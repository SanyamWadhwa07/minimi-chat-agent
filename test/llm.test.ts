import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { streamStep, limits, resetProviderState, ModelError, providers, type ChatMessage } from "../src/llm.ts";
import { SEARCH_TOOL } from "../src/search.ts";
import { fakeNetwork, chunk, setKeys } from "./fake.ts";

const req = (over: Partial<Parameters<typeof streamStep>[0]> = {}) => ({
  messages: [{ role: "user", content: "hi" }] as ChatMessage[],
  tools: [SEARCH_TOOL],
  toolChoice: "auto" as const,
  first: false,
  ...over,
});
function run(r = req(), signal = new AbortController().signal) {
  const text: string[] = [];
  const switches: string[] = [];
  const done = streamStep(r, { onText: (d) => text.push(d), onSwitch: (from, to, why) => switches.push(`${from.name}>${to.name}: ${why}`) }, signal);
  return { done, text, switches };
}

beforeEach(() => {
  setKeys();
  resetProviderState();
  Object.assign(limits, { firstChunkMs: 20_000, idleMs: 15_000 });
});
afterEach(() => mock.restoreAll());

test("streams text from Gemini; Groq is not called", async () => {
  const calls = fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("Hel"), chunk.text("lo")] }], groq: [] });
  const { done, text } = run();
  const res = await done;
  assert.equal(res.text, "Hello");
  assert.deepEqual(text, ["Hel", "lo"]);
  assert.equal(res.provider.name, "gemini");
  assert.equal(calls.groq.length, 0);
});

test("the first step uses the fast model, later steps the main model", async () => {
  const calls = fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("a")] }] });
  await run(req({ first: true })).done;
  await run(req({ first: false })).done;
  assert.deepEqual(calls.generativelanguage.map((c) => [c.body.model, c.body.reasoning_effort]), [["gemini-3.6-flash", "minimal"], ["gemini-3.8-flash", "low"]]);
});

test("Gemini fails before any text: Groq answers, the switch is announced, Gemini cools down", async () => {
  const calls = fakeNetwork({
    generativelanguage: [{ kind: "json", status: 429, body: { error: "quota" }, headers: { "retry-after": "60" } }],
    groq: [{ kind: "sse", events: [chunk.text("from groq")] }],
  });
  const first = run();
  assert.equal((await first.done).provider.name, "groq");
  assert.deepEqual(first.switches, ["gemini>groq: rate limit reached"]);
  // The next step skips Gemini while it cools down: no wasted request, no second notice.
  const second = run();
  assert.equal((await second.done).provider.name, "groq");
  assert.equal(calls.generativelanguage.length, 1);
  assert.deepEqual(second.switches, []);
});

test("failure after text has reached the user is not retried elsewhere: the answer would repeat", async () => {
  const calls = fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("The price is"), chunk.text(" $")], failAfter: 2 }], groq: [] });
  const { done, text } = run();
  await assert.rejects(done, (e) => e instanceof ModelError && /cut off/.test(e.message));
  assert.deepEqual(text, ["The price is", " $"]);
  assert.equal(calls.groq.length, 0);
});

test("an error event inside the stream counts as a failure", async () => {
  fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.error("internal")] }], groq: [{ kind: "sse", events: [chunk.text("ok")] }] });
  assert.equal((await run().done).text, "ok");
});

test("Groq's rejected tool call is a generation glitch: retried once on Groq", async () => {
  setKeys({ groq: true, tavily: true });
  const calls = fakeNetwork({ groq: [{ kind: "json", status: 400, body: { error: { message: "tool call validation failed: parameters" } } }, { kind: "sse", events: [chunk.text("ok")] }] });
  assert.equal((await run().done).text, "ok");
  assert.equal(calls.groq.length, 2);
});

test("no first chunk in time: next provider; a stall mid-stream after text: a clear error", async () => {
  limits.firstChunkMs = 50;
  fakeNetwork({ generativelanguage: [{ kind: "hang" }], groq: [{ kind: "sse", events: [chunk.text("ok")] }] });
  const r = run();
  assert.equal((await r.done).provider.name, "groq");
  assert.match(r.switches[0], /no response in 0.05 s/);

  mock.restoreAll();
  resetProviderState();
  limits.idleMs = 50;
  fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("half an ans")], hang: true }], groq: [] });
  await assert.rejects(run().done, /cut off \(gemini: stream stalled for 0.05 s\)/);
});

test("every provider down: one message that says what to check", async () => {
  fakeNetwork({ generativelanguage: [{ kind: "network-error" }], groq: [{ kind: "network-error" }] });
  await assert.rejects(run().done, /Could not reach any model service\. Check your internet connection/);
  resetProviderState();
  mock.restoreAll();
  fakeNetwork({ generativelanguage: [{ kind: "json", status: 400, body: { error: { message: "API key not valid" } } }], groq: [{ kind: "json", status: 401, body: {} }] });
  await assert.rejects(run().done, /gemini: API key rejected; groq: API key rejected\)\. Check the keys in \.env/);
});

test("no model key at all: a setup error, not a retry", async () => {
  setKeys({ tavily: true });
  await assert.rejects(run().done, (e) => e instanceof ModelError && !e.retryable && /GEMINI_API_KEY or GROQ_API_KEY/.test(e.message));
});

test("thought signatures go back to Gemini unchanged and are stripped for Groq", async () => {
  const signed: ChatMessage[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" }, extra_content: { google: { thought_signature: "SIG" } } }] },
    { role: "tool", tool_call_id: "c1", content: "result" },
  ];
  const calls = fakeNetwork({ generativelanguage: [{ kind: "json", status: 503, body: {} }, { kind: "sse", events: [chunk.text("a")] }], groq: [{ kind: "sse", events: [chunk.text("b")] }] });
  await run(req({ messages: signed })).done; // Gemini fails, Groq answers
  assert.equal(calls.groq[0].body.messages[1].tool_calls[0].extra_content, undefined);
  resetProviderState();
  await run(req({ messages: signed })).done;
  assert.equal(calls.generativelanguage[1].body.messages[1].tool_calls[0].extra_content.google.thought_signature, "SIG");
});

test("Groq requests are cut to its remaining per-minute tokens, read from its headers", async () => {
  setKeys({ groq: true, tavily: true });
  const big: ChatMessage[] = [{ role: "user", content: "q" }, { role: "tool", tool_call_id: "c", content: "x".repeat(60_000) }];
  const calls = fakeNetwork({ groq: [{ kind: "sse", events: [chunk.text("ok")], headers: { "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "3000" } }] });
  await run(req({ messages: big })).done;
  await run(req({ messages: big })).done;
  const sizes = calls.groq.map((c) => JSON.stringify(c.body.messages).length / 4);
  assert.ok(sizes[0] <= 6800, `first request ~${sizes[0]} tokens, budget 6800`);
  assert.ok(sizes[1] <= 1800, `second request ~${sizes[1]} tokens after the headers said 3000 left`);
});

test("the last step sends no tools; tool calls from both stream shapes are assembled", async () => {
  const calls = fakeNetwork({
    generativelanguage: [{ kind: "sse", events: [chunk.geminiCall("g1", { query: "a" }, "SIG"), chunk.geminiCall("g2", { query: "b" })] }, { kind: "sse", events: [chunk.text("final")] }],
  });
  const res = await run().done;
  assert.deepEqual(res.toolCalls.map((c) => [c.id, JSON.parse(c.function.arguments).query]), [["g1", "a"], ["g2", "b"]]);
  await run(req({ tools: [] })).done;
  assert.equal("tools" in calls.generativelanguage[1].body, false);
  assert.equal("tool_choice" in calls.generativelanguage[1].body, false);
});

test("stopping mid-stream aborts the request and tries no other provider", async () => {
  const calls = fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("a")], hang: true }], groq: [] });
  const ctrl = new AbortController();
  const r = run(req(), ctrl.signal);
  setTimeout(() => ctrl.abort(new Error("stopped")), 30);
  await assert.rejects(r.done, /stopped/);
  assert.equal(calls.generativelanguage[0].signal?.aborted, true);
  assert.equal(calls.groq.length, 0);
});

test("model choices follow .env overrides; gpt-oss and qwen get their own reasoning switches", () => {
  process.env.GEMINI_MODEL = "gemini-x";
  process.env.GROQ_MODEL = "openai/gpt-oss-120b";
  const [g, q] = providers();
  assert.equal(g.main.model, "gemini-x");
  assert.deepEqual(q.main.extra, { include_reasoning: false });
  process.env.GROQ_MODEL = "qwen/qwen3.8-27b";
  assert.deepEqual(providers()[1].main.extra, { reasoning_format: "hidden" });
});
