import { test } from "node:test";
import assert from "node:assert/strict";
import { openMemory, type Turn } from "../src/memory/db.ts";
import { recall, ftsQuery, renderFull, renderCompact } from "../src/memory/recall.ts";
import { resolveTimeRefs } from "../src/memory/temporal.ts";

const NOW = new Date(2026, 10, 10, 15, 0); // Tue 10 Nov 2026
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).getTime();

function memoryWith(turns: Partial<Turn>[]) {
  const mem = openMemory(":memory:");
  const ids = turns.map((t) =>
    mem.add({ sessionId: "s1", askedAt: at(1), question: "q", answer: "a", sources: [], model: "test", origin: "chat", ...t }),
  );
  return { mem, ids };
}
const ask = (mem: ReturnType<typeof openMemory>, message: string, opts = {}) => recall(mem, message, resolveTimeRefs(message, NOW), opts);

const POSTGRES = { askedAt: at(3), question: "What's the cheapest managed Postgres hosting for a side project?", answer: "Neon's free tier, then Supabase Pro at $25/month.", sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing", published: "2026-10-30", snippet: "" }] };
const CRM = { askedAt: at(9), question: "Shortlist 5 CRM tools for a 20-person sales team", answer: "HubSpot, Pipedrive, Zoho CRM, Salesforce Starter, Freshsales." };
const WEATHER = { askedAt: at(6), question: "Will it rain in Bengaluru this weekend?", answer: "Light showers on Saturday." };

test("a date phrase finds the turns asked that day, in full", () => {
  const { mem } = memoryWith([POSTGRES, CRM, WEATHER]);
  const r = ask(mem, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
  assert.equal(r.lookups.length, 1);
  assert.equal(r.lookups[0].hits, 1);
  assert.equal(r.lookups[0].window.start, new Date(2026, 10, 3).getTime());
  assert.equal(r.turns[0].turn.question, POSTGRES.question);
  assert.equal(r.turns[0].why, "date");
  assert.equal(r.turns[0].full, true);
  assert.equal(r.stored, 3);
});

test("an ambiguous weekday uses the reading that has turns", () => {
  const { mem } = memoryWith([{ ...CRM, askedAt: at(2) }]); // Mon 2 Nov, not yesterday
  const r = ask(mem, "last Monday we shortlisted some CRMs, any news?");
  assert.equal(r.lookups[0].hits, 1);
  assert.equal(r.lookups[0].window.start, new Date(2026, 10, 2).getTime());
});

test("a wrong date still finds the turn by topic", () => {
  const { mem } = memoryWith([POSTGRES, WEATHER]);
  const r = ask(mem, "On Monday I asked you about Postgres hosting, is that still right?");
  assert.equal(r.lookups[0].hits, 0);
  const pg = r.turns.find((t) => t.turn.question === POSTGRES.question);
  assert.equal(pg?.why, "topic");
  assert.equal(pg?.full, true);
  assert.equal(r.turns[0].turn.question, POSTGRES.question); // topic before recency
});

test("no date: topic matches first, the rest compact", () => {
  const { mem } = memoryWith([POSTGRES, CRM, WEATHER]);
  const r = ask(mem, "what did you recommend for Postgres?");
  assert.deepEqual(r.lookups, []);
  assert.equal(r.turns[0].why, "topic");
  assert.deepEqual(r.turns.slice(1).map((t) => [t.why, t.full]), [["recent", false], ["recent", false]]);
});

test("empty memory", () => {
  const { mem } = memoryWith([]);
  const r = ask(mem, "What did I ask you on 3 November?");
  assert.deepEqual(r.lookups.map((l) => l.hits), [0]);
  assert.deepEqual(r.turns, []);
  assert.equal(r.stored, 0);
  assert.equal(r.firstAt, null);
});

test("the turns already in the conversation are left out", () => {
  const { mem, ids } = memoryWith([POSTGRES, CRM]);
  const r = ask(mem, "Postgres and CRM", { exclude: [ids[1]] });
  assert.deepEqual(r.turns.map((t) => t.turn.question), [POSTGRES.question]);
  assert.equal(r.stored, 1);
});

test("punctuation and FTS5 syntax in the message cannot break the query", () => {
  const { mem } = memoryWith([POSTGRES]);
  for (const m of ['postgres" OR *', "NEAR(postgres hosting)", "pricing: -neon ^supabase (2026)", "AND OR NOT", "'; DROP TABLE turns; --", "🙂 postgres?!"]) {
    assert.doesNotThrow(() => ask(mem, m), m);
  }
  assert.equal(ftsQuery("Has any pricing changed since then?"), '"pricing"');
  assert.equal(ftsQuery("the and of"), "");
});

test("a busy day: the turns that match the topic come first", () => {
  const sameDay = (h: number, question: string) => ({ askedAt: at(3, h), question, answer: "…" });
  const { mem } = memoryWith([sameDay(9, "Weather in Pune?"), sameDay(10, "Best pizza nearby?"), sameDay(11, "Neon vs Supabase pricing for Postgres"), sameDay(12, "Movie times")]);
  const r = ask(mem, "What did you say about Postgres pricing on 3 November?");
  assert.equal(r.lookups[0].hits, 4);
  assert.equal(r.turns[0].turn.question, "Neon vs Supabase pricing for Postgres");
});

test("non-English and emoji text is stored and found by topic", () => {
  const { mem } = memoryWith([{ askedAt: at(3), question: "पोस्टग्रेस होस्टिंग कितने की है?", answer: "Neon ₹1,600/माह" }, WEATHER]);
  const r = ask(mem, "पोस्टग्रेस होस्टिंग 🙂");
  assert.equal(r.turns[0].why, "topic");
  assert.match(r.turns[0].turn.question, /पोस्टग्रेस/);
});

test("a large memory stays inside the budget and keeps priority order", () => {
  const filler = Array.from({ length: 300 }, (_, i) => ({ askedAt: new Date(2026, 9, 1, 0, i * 10).getTime(), question: `Filler question number ${i} about gardening`, answer: "Water twice a week. ".repeat(20) }));
  const { mem } = memoryWith([{ ...POSTGRES, askedAt: new Date(2026, 8, 1).getTime() }, ...filler, CRM]); // Postgres is the oldest turn
  const r = ask(mem, "Yesterday's CRM list, and what did you say about Postgres hosting?");
  const size = r.turns.reduce((s, t) => s + (t.full ? renderFull(t.turn) : renderCompact(t.turn)).length, 0);
  assert.ok(size <= 9000, `size ${size}`);
  assert.equal(r.turns[0].why, "date");
  assert.equal(r.turns[0].turn.question, CRM.question);
  assert.equal(r.turns[1].turn.question, POSTGRES.question); // found by topic despite being oldest
  assert.ok(r.omitted > 200, `omitted ${r.omitted}`);
});
