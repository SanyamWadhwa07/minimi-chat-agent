// npm run seed: adds the demo history from the terminal (the page has the same as a button).
import { openMemory } from "../src/memory/db.ts";
import { addDemoHistory, hasDemo } from "../src/demo.ts";
import { formatWhen } from "../src/clock.ts";
try { process.loadEnvFile(); } catch {}

const mem = openMemory();
if (hasDemo(mem)) {
  console.log("Memory already has the demo history. Run npm run reset first to start over.");
  process.exit(0);
}
const saved = await addDemoHistory(mem, (p) => {
  if (p.saved === null) process.stdout.write(`${formatWhen(p.askedAt)}  ${p.question}\n`);
  else console.log(p.saved ? "  saved" : "  not saved (see the error above)");
}, new AbortController().signal);
console.log(`\n${saved} of 3 added. Try: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"`);
