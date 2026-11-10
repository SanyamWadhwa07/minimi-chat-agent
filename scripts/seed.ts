// npm run seed: gives a new install some history to talk about. Asks the real agent three
// questions as if they had been asked on earlier days (last Tuesday, Monday, 3 November), so the
// sample questions have something to find. The answers are real, made today; only the dates are
// back-dated. Rows are marked origin = "seed" and labelled as seeded in the UI.
import { openMemory } from "../src/memory/db.ts";
import { resolveTimeRefs } from "../src/memory/temporal.ts";
import { runTurn } from "../src/agent.ts";
import { formatWhen } from "../src/clock.ts";
try { process.loadEnvFile(); } catch {}

const now = new Date();
/** The start of the day a phrase means today, plus a time of day. Uses the same date code as recall. */
function on(phrase: string, hour: number, minute: number) {
  const day = new Date(resolveTimeRefs(phrase, now)[0].candidates[0].start);
  day.setHours(hour, minute);
  return day;
}

const conversations = [
  { when: on("3 November", 11, 20), question: "What is the current Node.js LTS version, and when does it reach end of life?" },
  { when: on("last Tuesday", 10, 42), question: "What's the cheapest managed Postgres hosting for a small production app? Compare Neon, Supabase and AWS RDS." },
  { when: on("on Monday", 16, 5), question: "We're a 20-person sales team. Shortlist 5 CRM tools with their current per-seat pricing." },
];

const mem = openMemory();
if (mem.list().some((t) => t.origin === "seed")) {
  console.log("Memory already has seeded conversations. Run npm run reset first to start over.");
  process.exit(0);
}
for (const [i, c] of conversations.entries()) {
  process.stdout.write(`${formatWhen(c.when.getTime())}  ${c.question}\n  `);
  const turn = await runTurn(
    mem,
    { sessionId: `seed-${i + 1}`, message: c.question, now: c.when, origin: "seed" },
    (e) => {
      if (e.type === "search" && e.status === "done") process.stdout.write(".");
      if (e.type === "error") process.stdout.write(`error: ${e.message}`);
    },
    new AbortController().signal,
  );
  console.log(turn ? ` saved (${turn.sources.length} sources)` : " not saved");
}
console.log("\nDone. Try: \"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?\"");
