// Runs before `npm run dev`: checks the Node version and the keys, and says in plain words what to
// fix. Plain JavaScript so it runs even where TypeScript tooling would not.
const [major, minor] = process.versions.node.split(".").map(Number);
// 22.16 is the first Node 22 whose built-in SQLite includes full-text search (FTS5), which recall uses.
if (major < 22 || (major === 22 && minor < 16)) {
  console.error(`\n  This app needs Node.js 22.16 or newer (its built-in SQLite has the full-text search memory uses). You have ${process.versions.node}.\n  Install the current LTS from https://nodejs.org and run npm run dev again.\n`);
  process.exit(1);
}

try {
  process.loadEnvFile();
} catch {
  console.error("\n  No .env file found. Create one from the template and fill in your keys:\n\n    cp .env.example .env\n");
  process.exit(1);
}

const problems = [];
if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
  problems.push("Add GEMINI_API_KEY (https://aistudio.google.com/apikey) or GROQ_API_KEY (https://console.groq.com/keys). Both are free.");
}
if (!process.env.TAVILY_API_KEY) {
  problems.push("Add TAVILY_API_KEY (https://app.tavily.com, free). Web search is the agent's one tool.");
}
if (problems.length) {
  console.error(`\n  Missing keys in .env:\n${problems.map((p) => `   - ${p}`).join("\n")}\n`);
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) console.log("  Note: no GROQ_API_KEY, so there is no fallback if Gemini fails.");
if (!process.env.GEMINI_API_KEY) console.log("  Note: no GEMINI_API_KEY, so Groq answers alone.");
