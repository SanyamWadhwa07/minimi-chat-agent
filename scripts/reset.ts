// npm run reset: forget everything (deletes the local memory file). Stop npm run dev first.
import { rmSync, existsSync } from "node:fs";

const file = process.env.MEMORY_FILE || "data/memory.db";
const files = [file, `${file}-wal`, `${file}-shm`].filter((f) => existsSync(f));
for (const f of files) rmSync(f);
console.log(files.length ? `Memory cleared (${files.join(", ")}).` : "Memory was already empty.");
