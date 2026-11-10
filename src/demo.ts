// Demo history, so a new install has something to remember: three real questions put to the agent
// as if asked on earlier days. The answers are live; only the dates are back-dated, and the rows are
// marked origin = "seed" so the page labels them. Used by `npm run seed` and the page's demo button.
import type { Memory } from "./memory/db.ts";
import { resolveTimeRefs } from "./memory/temporal.ts";
import { runTurn } from "./agent.ts";

export const DEMO = [
  { day: "3 November", time: [11, 20], question: "What is the current Node.js LTS version, and when does it reach end of life?" },
  { day: "last Tuesday", time: [10, 42], question: "What's the cheapest managed Postgres hosting for a small production app? Compare Neon, Supabase and AWS RDS." },
  { day: "on Monday", time: [16, 5], question: "We're a 20-person sales team. Shortlist 5 CRM tools with their current per-seat pricing." },
];

export const hasDemo = (mem: Memory) => mem.list().some((t) => t.origin === "seed");

/** When a demo question counts as asked: its day (the same date code as recall), never in the future. */
function askedAt(d: (typeof DEMO)[number], now: Date) {
  const at = new Date(resolveTimeRefs(d.day, now)[0].candidates[0].start);
  at.setHours(d.time[0], d.time[1]);
  return at > now ? new Date(now.getTime() - 60 * 60e3) : at;
}

export type DemoProgress = { i: number; total: number; question: string; askedAt: number; saved: boolean | null };

/** Asks each demo question in turn; reports each before (saved: null) and after. Returns how many were saved. */
export async function addDemoHistory(mem: Memory, onProgress: (p: DemoProgress) => void, signal: AbortSignal) {
  const now = new Date();
  let saved = 0;
  for (const [i, d] of DEMO.entries()) {
    if (signal.aborted) break;
    const at = askedAt(d, now);
    const base = { i, total: DEMO.length, question: d.question, askedAt: at.getTime() };
    onProgress({ ...base, saved: null });
    const turn = await runTurn(mem, { sessionId: `demo-${i + 1}`, message: d.question, now: at, origin: "seed" }, () => {}, signal);
    if (turn) saved++;
    onProgress({ ...base, saved: Boolean(turn) });
  }
  return saved;
}
