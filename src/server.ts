// Entry point for `npm run dev`: loads .env, opens memory, and serves the app.
import { openMemory } from "./memory/db.ts";
import { createApp, listen } from "./app.ts";

try {
  process.loadEnvFile(); // .env, if present (Node's built-in loader; no dotenv needed)
} catch {}

const server = await listen(createApp(openMemory()), Number(process.env.PORT) || 3000);
const { port } = server.address() as { port: number };
console.log(`\n  minimi chat agent: http://localhost:${port}\n`);
