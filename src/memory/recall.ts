// Picks which past exchanges the model sees, before it runs. Recall is not a model tool (the brief
// allows one tool, web search), so this code has to put the right turns in front of the model on
// its own. Order of priority, filled until a size budget runs out:
//   1. turns asked on the dates the message mentions ("last Tuesday" -> Tue 3 Nov)
//   2. turns that match the message by topic (full-text rank)
//   3. every other turn, newest first, as one compact line each
// While memory is small everything fits, so nothing can be missed; as it grows it degrades in that
// priority order.
import type { Memory, Turn } from "./db.ts";
import type { TimeRef, Window } from "./temporal.ts";
import { formatWhen } from "../clock.ts";

export type Recalled = { turn: Turn; why: "date" | "topic" | "recent"; full: boolean };
/** What a date phrase was looked up as, and how many turns that day had. */
export type Lookup = { text: string; window: Window; hits: number };
export type Recall = { lookups: Lookup[]; turns: Recalled[]; stored: number; firstAt: number | null; omitted: number };

const FULL_TOPIC_TURNS = 3; // topic matches shown in full; the rest compact
const ANSWER_CHARS = 1500;

export function recall(mem: Memory, message: string, refs: TimeRef[], opts: { exclude?: number[]; budget?: number } = {}): Recall {
  const exclude = opts.exclude ?? [];
  const budget = opts.budget ?? 9000; // characters, about 2,300 tokens

  // 1. Dates: the first candidate window that has turns wins ("last Monday" -> yesterday, else the Monday before).
  const lookups: Lookup[] = [];
  const dated = new Map<number, Turn>();
  for (const ref of refs) {
    let window = ref.candidates[0];
    let found: Turn[] = [];
    for (const w of ref.candidates) {
      found = mem.between(w.start, w.end, exclude);
      if (found.length) {
        window = w;
        break;
      }
    }
    lookups.push({ text: ref.text, window, hits: found.length });
    for (const t of found) dated.set(t.id, t);
  }

  // 2. Topic matches of any age. 3. The rest, newest first.
  const score = mem.topic(ftsQuery(message));
  const rank = (t: Turn) => score.get(t.id) ?? 0;
  const skip = new Set([...exclude, ...dated.keys()]);
  const topical = mem.byIds([...score.keys()]).filter((t) => !skip.has(t.id));
  const recent = mem.recent(200, [...skip, ...score.keys()]);
  const ordered: Omit<Recalled, "full">[] = [
    // on a busy day, the turns that also match the topic come first
    ...[...dated.values()].sort((a, b) => rank(b) - rank(a) || a.askedAt - b.askedAt).map((turn) => ({ turn, why: "date" as const })),
    ...topical.sort((a, b) => rank(b) - rank(a)).map((turn) => ({ turn, why: "topic" as const })),
    ...recent.map((turn) => ({ turn, why: "recent" as const })),
  ];

  const turns: Recalled[] = [];
  let used = 0;
  let fullTopics = 0;
  let omitted = 0;
  for (const r of ordered) {
    let full = r.why === "date" || (r.why === "topic" && fullTopics < FULL_TOPIC_TURNS);
    let cost = (full ? renderFull(r.turn) : renderCompact(r.turn)).length;
    if (used + cost > budget && full) {
      full = false;
      cost = renderCompact(r.turn).length;
    }
    if (used + cost > budget) {
      omitted++;
      continue;
    }
    if (full && r.why === "topic") fullTopics++;
    used += cost;
    turns.push({ ...r, full });
  }

  const { n, first } = mem.stats();
  const stored = n - exclude.length;
  return { lookups, turns, stored, firstAt: first, omitted: omitted + Math.max(0, stored - ordered.length) };
}

/** One past exchange in full: question, answer and the sources it cited. */
export function renderFull(t: Turn) {
  const answer = t.answer.length > ANSWER_CHARS ? `${t.answer.slice(0, ANSWER_CHARS)}…` : t.answer;
  const sources = t.sources.map((s) => `[${s.n}] ${s.title}${s.published ? ` (published ${s.published})` : ""} ${s.url}`).join("\n");
  return `<exchange asked="${formatWhen(t.askedAt)}">\nUser: ${t.question}\nYou: ${answer}${sources ? `\nSources you cited then:\n${sources}` : ""}\n</exchange>\n`;
}

/** One past exchange as a single line. */
export function renderCompact(t: Turn) {
  const q = t.question.length > 200 ? `${t.question.slice(0, 200)}…` : t.question;
  const a = t.answer.replace(/\s+/g, " ").slice(0, 150);
  return `- ${formatWhen(t.askedAt)}: "${q}" -> ${a}…\n`;
}

// Words that say nothing about the topic: grammar, chat filler, and the date words resolved above.
const STOP = new Set(
  ("a about above after again against all am an and any anything are as ask asked at be because been before being below between both but by can " +
    "change changed changes could did do does doing done during each few for from further get got had has have having he her here hers how i if in " +
    "into is it its just last let me more most my myself no nor not now of off on once only or other our ours out over own same said say she " +
    "should since so some still such tell than that the their them then there these they this those through to today told too under until up " +
    "very was we were what when where which while who whom why will with would yesterday you your yours correct right answer again remember " +
    "monday tuesday wednesday thursday friday saturday sunday week month year ago earlier morning january february march april may june july " +
    "august september october november december jan feb mar apr jun jul aug sep sept oct nov dec").split(" "),
);

/** An FTS5 query that ORs the message's topic words, each quoted so punctuation cannot break it. */
export function ftsQuery(message: string) {
  // \p{M} keeps combining marks inside words: Hindi "पोस्टग्रेस" would otherwise split at each vowel sign.
  const words = message.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const terms = [...new Set(words.filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w)))].slice(0, 12);
  return terms.map((w) => `"${w}"`).join(" OR ");
}
