// Turns date phrases in a message ("last Tuesday", "3 November", "last week") into local-time
// windows that memory can be looked up by. Code does this, not the model: calendar arithmetic is
// deterministic here and easy to test, and models get weekdays wrong.
import * as chrono from "chrono-node";

/** A span of local time, epoch ms, [start, end). */
export type Window = { start: number; end: number };
/** One date phrase and its possible readings, most likely first. */
export type TimeRef = { text: string; candidates: Window[] };

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// Calendar arithmetic through the Date constructor, so DST days are still whole days.
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayWindow = (d: Date): Window => ({ start: startOfDay(d).getTime(), end: addDays(d, 1).getTime() });
const startOfWeek = (d: Date) => addDays(d, -((d.getDay() + 6) % 7)); // weeks start on Monday

// chrono reads "last week" as the single day 7 days ago, and gives "this week" / "this morning"
// no certain date. These are matched first and removed from the text before chrono runs.
const SPECIAL: [RegExp, (today: Date) => Window][] = [
  [/\b(?:last|past|previous) week\b/i, (t) => ({ start: addDays(startOfWeek(t), -7).getTime(), end: startOfWeek(t).getTime() })],
  [/\b(?:earlier )?this week\b/i, (t) => ({ start: startOfWeek(t).getTime(), end: addDays(t, 1).getTime() })],
  [/\b(?:earlier today|this (?:morning|afternoon|evening)|tonight)\b/i, (t) => dayWindow(t)],
  [/\b(?:last|past|previous) year\b/i, (t) => ({ start: new Date(t.getFullYear() - 1, 0, 1).getTime(), end: new Date(t.getFullYear(), 0, 1).getTime() })],
  [/\b(?:earlier )?this year\b/i, (t) => ({ start: new Date(t.getFullYear(), 0, 1).getTime(), end: addDays(t, 1).getTime() })],
];

// Month and weekday names that are also everyday words ("march forward", "sun protection"). A bare
// one counts as a date only after a word that introduces a date ("in March", "on Sun").
const AMBIGUOUS = /^(?:march|may|sun|sat|wed|mon)$/i;
const INTRODUCES_DATE = /\b(?:in|on|since|during|from|until|till|by|last|this|early|late|mid|of)\s*$/i;

/** Every date phrase in `message` that can refer to the past, with its candidate windows. */
export function resolveTimeRefs(message: string, now: Date): TimeRef[] {
  const today = startOfDay(now);
  const refs: TimeRef[] = [];
  let rest = message;
  for (const [re, toWindow] of SPECIAL) {
    const m = rest.match(re);
    if (!m) continue;
    refs.push({ text: m[0], candidates: [toWindow(today)] });
    rest = rest.replace(re, " ");
  }
  // chrono reads "between 2 and 4 November" as only 4 November; "from 2 to 4 November" it reads as a range.
  rest = rest.replace(/\bbetween (\d{1,2}(?:st|nd|rd|th)?) and (\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,})/gi, "from $1 to $2");
  // en.GB reads "3/11" as 3 November, as people write it in India and the UK.
  for (const r of chrono.en.GB.parse(rest, now)) {
    if (AMBIGUOUS.test(r.text.trim()) && !INTRODUCES_DATE.test(rest.slice(0, r.index))) continue;
    const candidates = readings(r, today);
    if (candidates.length) refs.push({ text: r.text, candidates });
  }
  return refs;
}

function readings(r: chrono.ParsedResult, today: Date): Window[] {
  const s = r.start;
  const tomorrow = addDays(today, 1);
  // A bare "today" / "now" is the conversation already in front of the model, not a lookup.
  if (/^(?:today|now|right now)$/i.test(r.text.trim())) return [];
  if (/\b(?:next|coming|upcoming)\b/i.test(r.text)) return [];

  if (r.end) {
    // A range ("from Monday to Wednesday"): one window, cut off at the end of today.
    const start = startOfDay(s.date());
    const end = Math.min(addDays(r.end.date(), 1).getTime(), tomorrow.getTime());
    return start < tomorrow ? [{ start: start.getTime(), end }] : [];
  }

  if (s.isCertain("day")) {
    // "3 November", "yesterday", "2 days ago". Memory is in the past, so a day-month that lands in
    // the future ("25 December" said in November) means last year's.
    let day = startOfDay(s.date());
    if (!s.isCertain("year") && day > today) day = new Date(day.getFullYear() - 1, day.getMonth(), day.getDate());
    return day <= today ? [dayWindow(day)] : [];
  }

  if (s.isCertain("weekday")) {
    // The latest such weekday not after today. Two readings where English is ambiguous:
    //   "on Tuesday" said on a Tuesday: a week ago, or today.
    //   "last Monday" said on a Tuesday: yesterday, or the Monday before.
    // Recall uses the first reading that has turns, and the answer names the date it used.
    let base = startOfDay(s.date());
    while (base > today) base = addDays(base, -7);
    while (addDays(base, 7) <= today) base = addDays(base, 7);
    const isToday = base.getTime() === today.getTime();
    if (/\b(?:last|past|previous)\b/i.test(r.text)) {
      const first = isToday ? addDays(base, -7) : base;
      return [dayWindow(first), dayWindow(addDays(first, -7))];
    }
    return isToday ? [dayWindow(addDays(base, -7)), dayWindow(base)] : [dayWindow(base)];
  }

  if (s.isCertain("month")) {
    // "in October", "last month": the whole month; a future month without a year means last year's.
    let first = new Date(s.date().getFullYear(), s.date().getMonth(), 1);
    if (!s.isCertain("year") && first > today) first = new Date(first.getFullYear() - 1, first.getMonth(), 1);
    if (first > today) return [];
    const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
    return [{ start: first.getTime(), end: Math.min(next.getTime(), tomorrow.getTime()) }];
  }

  return []; // a time with no date ("at 3pm")
}
