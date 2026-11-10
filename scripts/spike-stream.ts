// One-off spike: records the raw streamed responses from Gemini and Groq for a question that
// needs two parallel searches, then sends fake tool results back and records the answer stream.
// The recordings become test fixtures for the stream parser in src/llm.ts.
import { writeFileSync } from "node:fs";
try { process.loadEnvFile(); } catch {}

const tools = [{ type: "function", function: { name: "web_search", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }];
const question = "Compare the current monthly price of the cheapest paid plan of Neon and of Supabase. Search for each one separately, in parallel.";
const targets = [
  { name: "gemini-3.8-flash", base: "https://generativelanguage.googleapis.com/v1beta/openai", key: process.env.GEMINI_API_KEY, model: "gemini-3.8-flash", extra: { reasoning_effort: "low" } },
  { name: "groq-qwen3.8-27b", base: "https://api.groq.com/openai/v1", key: process.env.GROQ_API_KEY, model: "qwen/qwen3.8-27b", extra: { reasoning_format: "hidden" } },
];

async function call(t: (typeof targets)[number], messages: unknown[], tag: string) {
  const t0 = performance.now();
  const res = await fetch(`${t.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.key}` },
    body: JSON.stringify({ model: t.model, messages, tools, tool_choice: "auto", stream: true, stream_options: { include_usage: true }, ...t.extra }),
  });
  const headersAt = performance.now() - t0;
  const rl = [...res.headers].filter(([k]) => k.startsWith("x-ratelimit") || k === "retry-after").map(([k, v]) => `${k}=${v}`).join(" ");
  if (!res.ok) { console.log(`  ${tag}: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`); return null; }
  let raw = "", firstAt = 0;
  const dec = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) { if (!firstAt) firstAt = performance.now() - t0; raw += dec.decode(chunk, { stream: true }); }
  writeFileSync(`test/fixtures/${t.name}.${tag}.sse`, raw);
  // naive assembly, only to see the shape
  // Groq sends OpenAI-style fragments keyed by `index`; Gemini sends each call whole, no `index`.
  const calls: any[] = []; const byIndex: Record<number, any> = {}; let text = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const j = JSON.parse(line.slice(6)); const d = j.choices?.[0]?.delta;
    if (d?.content) text += d.content;
    for (const tc of d?.tool_calls ?? []) {
      const fresh = () => { const n = { id: "", type: "function", function: { name: "", arguments: "" } }; calls.push(n); return n; };
      const c = typeof tc.index === "number" ? (byIndex[tc.index] ??= fresh()) : tc.id && !calls.some((x) => x.id === tc.id) ? fresh() : (calls.at(-1) ?? fresh());
      if (tc.id) c.id = tc.id; if (tc.function?.name) c.function.name += tc.function.name; if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      if (tc.extra_content) c.extra_content = tc.extra_content;
    }
  }
  console.log(`  ${tag}: headers ${headersAt.toFixed(0)}ms, first chunk ${firstAt.toFixed(0)}ms, done ${(performance.now() - t0).toFixed(0)}ms; ${raw.split("\ndata: ").length} events`);
  console.log(`  ${tag}: rate-limit headers: ${rl || "(none)"}`);
  return { calls, text };
}

for (const t of targets) {
  if (!t.key) { console.log(`${t.name}: no key, skipped`); continue; }
  console.log(t.name);
  const messages: any[] = [{ role: "system", content: "Do not announce searches; call the tool directly." }, { role: "user", content: question }];
  const s1 = await call(t, messages, "step1");
  if (!s1) continue;
  console.log(`  step1 tool calls: ${s1.calls.map((c: any) => `${c.function.name}(${c.function.arguments}) id=${c.id || "(empty)"}${c.extra_content ? " +extra_content" : ""}`).join(", ") || "none"}; text: ${JSON.stringify(s1.text.slice(0, 80))}`);
  if (!s1.calls.length) continue;
  messages.push({ role: "assistant", content: s1.text || null, tool_calls: s1.calls });
  for (const c of s1.calls) messages.push({ role: "tool", tool_call_id: c.id, content: `Result for ${c.function.arguments}: Launch plan $19/month (pricing page, 2026-11-01).` });
  const s2 = await call(t, messages, "step2");
  if (s2) console.log(`  step2 answer: ${JSON.stringify(s2.text.slice(0, 160))}`);
}
