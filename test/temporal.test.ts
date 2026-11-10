import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimeRefs, type Window } from "../src/memory/temporal.ts";

// Local-time constructors only, so the tests pass in any timezone.
const TUE = new Date(2026, 10, 10, 15, 0); // Tue 10 Nov 2026, 15:00

/** "2026-11-03" for a one-day window, "2026-11-02..2026-11-08" for longer ones (inclusive). */
function show(w: Window) {
  const iso = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const first = iso(w.start);
  const last = iso(new Date(w.end).setDate(new Date(w.end).getDate() - 1));
  return first === last ? first : `${first}..${last}`;
}
const resolve = (msg: string, now = TUE) => resolveTimeRefs(msg, now).map((r) => r.candidates.map(show));

test("the three sample questions", () => {
  assert.deepEqual(resolve("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?"), [["2026-11-09"]]);
  // "today" is the live conversation, not a lookup
  assert.deepEqual(resolve("What did I ask you on 3 November? Is your answer still correct today?"), [["2026-11-03"]]);
  assert.deepEqual(resolve("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), [["2026-11-03", "2026-10-27"]]);
});

test("day phrases", () => {
  assert.deepEqual(resolve("yesterday"), [["2026-11-09"]]);
  assert.deepEqual(resolve("2 days ago"), [["2026-11-08"]]);
  assert.deepEqual(resolve("Nov 3"), [["2026-11-03"]]);
  assert.deepEqual(resolve("3/11"), [["2026-11-03"]]); // day first
  assert.deepEqual(resolve("on 3 November 2025"), [["2025-11-03"]]);
});

test("a day-month in the future means last year's", () => {
  assert.deepEqual(resolve("what did I ask you on 25 December?"), [["2025-12-25"]]);
});

test("weekdays: latest such day, with a second reading where English is ambiguous", () => {
  assert.deepEqual(resolve("on Monday"), [["2026-11-09"]]);
  assert.deepEqual(resolve("this Monday"), [["2026-11-09"]]); // chrono alone says 16 Nov
  assert.deepEqual(resolve("on Tuesday"), [["2026-11-03", "2026-11-10"]]); // said on a Tuesday
  assert.deepEqual(resolve("last Monday"), [["2026-11-09", "2026-11-02"]]);
  assert.deepEqual(resolve("on Friday"), [["2026-11-06"]]);
});

test("weekday phrases never land in the future, from every day of the week", () => {
  for (let i = 0; i < 7; i++) {
    const now = new Date(2026, 10, 9 + i, 9, 30); // Mon 9 .. Sun 15 Nov
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      for (const phrase of [`on ${day}`, `last ${day}`]) {
        const refs = resolveTimeRefs(`What did we discuss ${phrase}?`, now);
        assert.equal(refs.length, 1, `${phrase} on ${now.toDateString()}`);
        for (const w of refs[0].candidates) {
          assert.ok(w.end <= new Date(2026, 10, 10 + i).getTime(), `${phrase} on ${now.toDateString()} gave ${show(w)}`);
          assert.equal(new Date(w.start).toLocaleDateString("en-GB", { weekday: "long" }), day);
        }
      }
    }
  }
});

test("week and month phrases are spans", () => {
  assert.deepEqual(resolve("last week"), [["2026-11-02..2026-11-08"]]);
  assert.deepEqual(resolve("earlier this week"), [["2026-11-09..2026-11-10"]]);
  assert.deepEqual(resolve("in October"), [["2026-10-01..2026-10-31"]]);
  assert.deepEqual(resolve("last month"), [["2026-10-01..2026-10-31"]]);
  assert.deepEqual(resolve("in November"), [["2026-11-01..2026-11-10"]]); // cut off at today
  assert.deepEqual(resolve("from Monday to Wednesday"), [["2026-11-09..2026-11-10"]]);
});

test("earlier today counts, a bare today or a time does not", () => {
  assert.deepEqual(resolve("what did I ask you this morning?"), [["2026-11-10"]]);
  assert.deepEqual(resolve("earlier today you said"), [["2026-11-10"]]);
  assert.deepEqual(resolve("what's the weather today?"), []);
  assert.deepEqual(resolve("call me at 3pm"), []);
  assert.deepEqual(resolve("is it raining now"), []);
});

test("future phrases are not memory", () => {
  assert.deepEqual(resolve("what's on next Friday?"), []);
  assert.deepEqual(resolve("tomorrow"), []);
});

test("everyday words that are also month or day names are not dates", () => {
  assert.deepEqual(resolve("Should we march forward with Neon?"), []);
  assert.deepEqual(resolve("Is sun protection worth it?"), []);
  assert.deepEqual(resolve("May I ask what you told me last Tuesday?"), [["2026-11-03", "2026-10-27"]]);
  assert.deepEqual(resolve("the may release"), []);
  // ...but they still work where a date is clearly meant
  assert.deepEqual(resolve("what did I ask you in march"), [["2026-03-01..2026-03-31"]]);
  assert.deepEqual(resolve("what did we discuss on wed?"), [["2026-11-04"]]);
});

test("years, and ranges written with 'between'", () => {
  assert.deepEqual(resolve("what did I ask you last year?"), [["2025-01-01..2025-12-31"]]);
  assert.deepEqual(resolve("everything this year"), [["2026-01-01..2026-11-10"]]);
  assert.deepEqual(resolve("between 2 and 4 November"), [["2026-11-02..2026-11-04"]]);
  assert.deepEqual(resolve("2-4 Nov"), [["2026-11-02..2026-11-04"]]);
});

test("across the new year", () => {
  const jan5 = new Date(2027, 0, 5, 9, 0);
  assert.deepEqual(resolve("What did I ask you on 25 December?", jan5), [["2026-12-25"]]);
  assert.deepEqual(resolve("last week", jan5), [["2026-12-28..2027-01-03"]]);
  assert.deepEqual(resolve("in December", jan5), [["2026-12-01..2026-12-31"]]);
});

test("impossible dates are ignored, not guessed", () => {
  assert.deepEqual(resolve("on 31 November"), []);
  assert.deepEqual(resolve("on 29 February"), []);
});

test("a day stays a whole local day across a daylight-saving change", () => {
  const tz = process.env.TZ;
  process.env.TZ = "America/New_York"; // clocks went back on Sun 1 Nov 2026
  try {
    const [ref] = resolveTimeRefs("what did I ask yesterday?", new Date(2026, 10, 2, 10, 0));
    const { start, end } = ref.candidates[0];
    assert.equal(new Date(start).getHours(), 0);
    assert.equal(new Date(end).getHours(), 0);
    assert.equal((end - start) / 3600e3, 25); // that Sunday had 25 hours
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test("no date, no refs", () => {
  assert.deepEqual(resolve("Compare Neon and Supabase pricing for a 20-person team"), []);
  assert.deepEqual(resolve("Postgres 16 vs 17"), []);
});
