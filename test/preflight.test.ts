// `npm run dev` runs scripts/preflight.mjs first. Run it as a reviewer would, in a fresh folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/preflight.mjs", import.meta.url));
function preflight(envFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  if (envFile !== undefined) writeFileSync(join(dir, ".env"), envFile);
  const env = { ...process.env };
  for (const k of ["GEMINI_API_KEY", "GROQ_API_KEY", "TAVILY_API_KEY"]) delete env[k];
  const r = spawnSync(process.execPath, [script], { cwd: dir, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("no .env: says how to create one", () => {
  const r = preflight();
  assert.equal(r.code, 1);
  assert.match(r.out, /No \.env file found[\s\S]*cp \.env\.example \.env/);
});

test("the template copied but not filled in: names each missing key and where to get it", () => {
  const r = preflight("GEMINI_API_KEY=\nGROQ_API_KEY=\nTAVILY_API_KEY=\n");
  assert.equal(r.code, 1);
  assert.match(r.out, /aistudio\.google\.com\/apikey/);
  assert.match(r.out, /app\.tavily\.com/);
});

test("search key missing: refuses, because search is the agent's one tool", () => {
  const r = preflight("GEMINI_API_KEY=x\n");
  assert.equal(r.code, 1);
  assert.match(r.out, /TAVILY_API_KEY/);
  assert.doesNotMatch(r.out, /GEMINI_API_KEY \(/);
});

test("one model key is enough; the missing fallback is mentioned, not fatal", () => {
  const groqOnly = preflight("GROQ_API_KEY=x\nTAVILY_API_KEY=y\n");
  assert.equal(groqOnly.code, 0);
  assert.match(groqOnly.out, /Groq answers alone/);
  const both = preflight("GEMINI_API_KEY=x\nGROQ_API_KEY=x\nTAVILY_API_KEY=y\n");
  assert.equal(both.code, 0);
  assert.equal(both.out.trim(), "");
});
