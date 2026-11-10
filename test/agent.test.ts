import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { runTurn, type AgentEvent } from "../src/agent.ts";
import { openMemory, type Memory } from "../src/memory/db.ts";
import { resetProviderState, limits } from "../src/llm.ts";
import { fakeNetwork, chunk, tavilyResults, setKeys, type Step } from "./fake.ts";

const NOW = new Date(2026, 10, 10, 15, 0); // Tue 10 Nov 2026
let mem: Memory;
beforeEach(() => {
  setKeys();
  resetProviderState();
  Object.assign(limits, { firstChunkMs: 20_000, idleMs: 15_000 });
  mem = openMemory(":memory:");
});
afterEach(() => mock.restoreAll());

async function turn(message: string, opts: { sessionId?: string; signal?: AbortSignal } = {}) {
  const events: AgentEvent[] = [];
  const saved = await runTurn(mem, { sessionId: opts.sessionId ?? "s", message, now: NOW }, (e) => events.push(e), opts.signal ?? new AbortController().signal);
  const of = <T extends AgentEvent["type"]>(t: T) => events.filter((e) => e.type === t) as Extract<AgentEvent, { type: T }>[];
  return { saved, events, of, text: of("text").map((e) => e.delta).join("") };
}
const page = (n: number) => ({ title: `Page ${n}`, url: `https://example.com/${n}`, content: `Fact ${n}.` });
const searches = (...queries: string[]): Step => ({ kind: "sse", events: queries.map((q, i) => chunk.geminiCall(`c${i}`, { query: q }, i === 0 ? "SIG" : undefined)) });
const answer = (...parts: string[]): Step => ({ kind: "sse", events: parts.map(chunk.text) });

test("a full turn: recall, parallel searches, a cited answer, saved with its sources", async () => {
  mem.add({ sessionId: "old", askedAt: new Date(2026, 10, 3, 10, 42).getTime(), question: "Cheapest Postgres hosting?", answer: "Neon $19 [1].", sources: [], model: "x", origin: "chat" });
  const calls = fakeNetwork({
    generativelanguage: [searches("neon pricing", "supabase pricing", "rds pricing"), answer("No change found [1, 3].")],
    tavily: [{ ...tavilyResults(page(1)), delayMs: 60 }, { ...tavilyResults(page(2)), delayMs: 60 }, { ...tavilyResults(page(3)), delayMs: 60 }],
  });
  const t = await turn("Last Tuesday I asked about Postgres hosting. Any price changes?");

  assert.deepEqual(t.of("recall")[0].lookups.map((l) => l.hits), [1]);
  assert.match(calls.generativelanguage[0].body.messages.at(-1).content, /<exchange asked="Tue 3 Nov 2026, 10:42">/);
  const starts = calls.tavily.map((c) => c.at);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 40, "the three searches ran at the same time");
  assert.equal(t.text, "No change found [1, 3].");
  assert.deepEqual(t.saved?.sources.map((s) => s.n), [1, 3]); // only what the answer cites
  assert.equal(mem.stats().n, 2);
  const done = t.of("done")[0];
  assert.equal(done.timings.searches, 3);
  assert.equal(done.timings.stepMs.length, 2);
});

test("asked what changed since a recalled day: every search covers that day, even if the model forgets", async () => {
  mem.add({ sessionId: "old", askedAt: new Date(2026, 10, 3, 10, 42).getTime(), question: "Postgres hosting?", answer: "Neon.", sources: [], model: "x", origin: "chat" });
  const calls = fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.geminiCall("a", { query: "neon" }), chunk.geminiCall("b", { query: "rds", since: "2026-11-01" })] }, answer("ok")], tavily: [tavilyResults(page(1))] });
  await turn("Last Tuesday I asked about Postgres hosting. Has pricing changed since?");
  const dates = calls.tavily.map((c) => c.body.start_date).filter(Boolean).sort();
  assert.deepEqual(dates, ["2026-11-01", "2026-11-03"]); // the model's own date is kept; the missing one filled in

  mock.restoreAll();
  const plain = fakeNetwork({ generativelanguage: [searches("neon"), answer("ok")], tavily: [tavilyResults(page(1))] });
  await turn("What did I ask you last Tuesday?"); // not about change: no date added
  assert.equal(plain.tavily.some((c) => c.body.start_date), false);
});

test("an answer that cites nothing keeps its first five sources for later checks", async () => {
  fakeNetwork({ generativelanguage: [searches("q"), answer("Done.")], tavily: [tavilyResults(page(1), page(2), page(3), page(4), page(5), page(6))] });
  assert.deepEqual((await turn("x")).saved?.sources.map((s) => s.n), [1, 2, 3, 4, 5]);
});

test("small talk: one model call, no search", async () => {
  const calls = fakeNetwork({ generativelanguage: [answer("Hi!")], tavily: [] });
  const t = await turn("hello");
  assert.equal(t.text, "Hi!");
  assert.equal(calls.tavily.length, 0);
  assert.equal(calls.generativelanguage.length, 1);
});

test("a model that keeps searching is made to answer on the third step, with no tools", async () => {
  const calls = fakeNetwork({ generativelanguage: [searches("a"), searches("b"), answer("Best I could find.")], tavily: [tavilyResults(page(1))] });
  const t = await turn("x");
  assert.equal(t.text, "Best I could find.");
  const last = calls.generativelanguage[2].body;
  assert.equal(last.tools, undefined);
  assert.match(last.messages.at(-1).content, /Searching is over/);
});

test("at most 12 searches per answer; extra calls are refused, not run", async () => {
  const many = Array.from({ length: 15 }, (_, i) => `q${i}`);
  const calls = fakeNetwork({ generativelanguage: [searches(...many), answer("ok")], tavily: [tavilyResults(page(1))] });
  await turn("x");
  assert.equal(calls.tavily.length, 12);
  const toolMessages = calls.generativelanguage[1].body.messages.filter((m: { role: string }) => m.role === "tool");
  assert.equal(toolMessages.length, 15, "every call gets a reply");
  assert.match(toolMessages[14].content, /search limit/);
});

test("unknown tool, unreadable or invalid arguments: refused with a reason, turn continues", async () => {
  const bad: Step = {
    kind: "sse",
    events: [
      { choices: [{ delta: { tool_calls: [{ id: "a", function: { name: "delete_files", arguments: "{}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "b", function: { name: "web_search", arguments: "{not json" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: "c", function: { name: "web_search", arguments: '{"query":"x","since":"last week"}' } }] } }] },
    ],
  };
  const calls = fakeNetwork({ generativelanguage: [bad, answer("ok")], tavily: [] });
  const t = await turn("x");
  assert.equal(t.text, "ok");
  assert.equal(calls.tavily.length, 0);
  const replies = calls.generativelanguage[1].body.messages.filter((m: { role: string }) => m.role === "tool").map((m: { content: string }) => m.content);
  assert.match(replies[0], /no tool named "delete_files"/);
  assert.match(replies[1], /invalid arguments/);
  assert.match(replies[2], /invalid arguments/);
});

test("a failed search is reported to the user and the model, and the turn still answers", async () => {
  const calls = fakeNetwork({ generativelanguage: [searches("q"), answer("I could not check this.")], tavily: [{ kind: "json", status: 432, body: {} }] });
  const t = await turn("x");
  assert.equal(t.of("search").at(-1)?.status, "error");
  assert.match(t.of("search").at(-1)?.error ?? "", /monthly searches are used up/);
  assert.match(calls.generativelanguage[1].body.messages.at(-1).content, /Search failed: .*Tell the user/);
  assert.ok(t.saved);
});

test("text written before searching is kept, and the answer starts a new paragraph", async () => {
  fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("Let me check."), chunk.geminiCall("c", { query: "q" })] }, answer("Found it.")], tavily: [tavilyResults(page(1))] });
  assert.equal((await turn("x")).text, "Let me check.\n\nFound it.");
});

test("an empty answer is an error the user can retry, and nothing is saved", async () => {
  fakeNetwork({ generativelanguage: [answer()], groq: [answer()] });
  const t = await turn("x");
  assert.deepEqual(t.of("error").map((e) => [e.message, e.retryable]), [["The model returned an empty answer.", true]]);
  assert.equal(t.saved, null);
  assert.equal(mem.stats().n, 0);
});

test("an answer cut off mid-stream is shown as an error and not saved as memory", async () => {
  limits.idleMs = 50;
  fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("Neon costs")], hang: true }], groq: [] });
  const t = await turn("x");
  assert.match(t.of("error")[0].message, /cut off/);
  assert.equal(mem.stats().n, 0);
});

test("stopping during a search: no error shown, nothing saved, the search is cancelled", async () => {
  const calls = fakeNetwork({ generativelanguage: [searches("q")], tavily: [{ kind: "hang" }] });
  const ctrl = new AbortController();
  const pending = turn("x", { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(new Error("stopped")), 40);
  const t = await pending;
  assert.equal(t.saved, null);
  assert.equal(t.of("error").length, 0);
  assert.equal(calls.tavily[0].signal?.aborted, true);
  assert.equal(mem.stats().n, 0);
});

test("the conversation so far goes in as chat history; recall covers only older turns", async () => {
  for (let i = 0; i < 8; i++) mem.add({ sessionId: "s", askedAt: new Date(2026, 10, 10, 9, i).getTime(), question: `q${i}`, answer: `a${i}`, sources: [], model: "x", origin: "chat" });
  const calls = fakeNetwork({ generativelanguage: [answer("ok")] });
  await turn("and then?");
  const messages = calls.generativelanguage[0].body.messages;
  const history = messages.slice(1, -1).map((m: { content: string }) => m.content);
  assert.equal(history.length, 12, "last 6 turns as user/assistant pairs");
  assert.match(history[0], /^\[Tue 10 Nov 2026, 09:02\] q2$/);
  const context = messages.at(-1).content;
  assert.match(context, /q0/); // older turns of the same chat reach the model through recall
  assert.doesNotMatch(context, /"q7"/); // turns already in history are not repeated
});

test("Gemini down: Groq does the whole turn, and the user is told once", async () => {
  fakeNetwork({
    generativelanguage: [{ kind: "network-error" }],
    groq: [{ kind: "sse", events: [chunk.groqCall(0, "g1", { query: "q" })] }, answer("from groq [1]")],
    tavily: [tavilyResults(page(1))],
  });
  const t = await turn("x");
  assert.equal(t.of("notice").length, 1);
  assert.match(t.of("done")[0].model, /^groq: /);
  assert.equal(t.text, "from groq [1]");
});
