import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createApp, listen } from "../src/app.ts";
import { openMemory, type Memory } from "../src/memory/db.ts";
import { resetProviderState } from "../src/llm.ts";
import { fakeNetwork, chunk, setKeys } from "./fake.ts";

let mem: Memory;
let server: Server;
let base: string;
before(async () => {
  mem = openMemory(":memory:");
  server = await listen(createApp(mem), 0);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());
beforeEach(() => {
  setKeys();
  resetProviderState();
});
afterEach(() => mock.restoreAll());

const post = (body: string, type = "application/json") => fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": type }, body });
const events = (raw: string) => raw.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));

test("a chat turn streams as server-sent events, ending in done", async () => {
  fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("Hi there")] }] });
  const res = await post(JSON.stringify({ sessionId: "a", message: "hello" }));
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const e = events(await res.text());
  assert.deepEqual(e.map((x) => x.type), ["recall", "text", "sources", "done"]);
  const turns = (await (await fetch(`${base}/api/session/a`)).json()) as { answer: string }[];
  assert.equal(turns[0].answer, "Hi there");
});

test("bad requests get a short JSON error and never reach the model", async () => {
  const calls = fakeNetwork({ generativelanguage: [] });
  const bad = [
    JSON.stringify({ sessionId: "a" }),
    JSON.stringify({ sessionId: "a", message: "   " }),
    JSON.stringify({ sessionId: "a", message: "x".repeat(4001) }),
    JSON.stringify({ sessionId: "", message: "hi" }),
    JSON.stringify({ sessionId: "a", message: 42 }),
    "{not json",
  ];
  for (const body of bad) {
    const res = await post(body);
    assert.equal(res.status, 400, body.slice(0, 40));
    assert.match(((await res.json()) as { error: string }).error, /sessionId, message|not valid JSON/);
  }
  const huge = await post(JSON.stringify({ sessionId: "a", message: "x".repeat(70_000) }));
  assert.equal(huge.status, 413);
  assert.equal(calls.generativelanguage.length, 0);
});

test("a message of exactly 4000 characters is accepted", async () => {
  fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("ok")] }] });
  const res = await post(JSON.stringify({ sessionId: "long", message: "x".repeat(4000) }));
  assert.equal(events(await res.text()).at(-1).type, "done");
});

test("closing the tab mid-answer cancels the model call and saves nothing", async () => {
  const calls = fakeNetwork({ generativelanguage: [{ kind: "sse", events: [chunk.text("Thinking about")], hang: true }] });
  const before = mem.stats().n;
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "gone", message: "hi" }), signal: ctrl.signal });
  const reader = res.body!.getReader();
  await reader.read(); // the stream has started
  ctrl.abort();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.generativelanguage[0].signal?.aborted, true);
  assert.equal(mem.stats().n, before);
});

test("status shows which models are set up, never the keys", async () => {
  const body = await (await fetch(`${base}/api/status`)).text();
  const status = JSON.parse(body);
  assert.deepEqual(status.models, ["gemini: gemini-3.8-flash", "groq: qwen/qwen3.8-27b"]);
  assert.equal(status.search, true);
  for (const key of [process.env.GEMINI_API_KEY!, process.env.GROQ_API_KEY!, process.env.TAVILY_API_KEY!]) assert.ok(!body.includes(key));
});

test("history lists every question newest first; an unknown conversation is empty", async () => {
  mem.add({ sessionId: "h", askedAt: 1, question: "older", answer: "a", sources: [], model: "m", origin: "seed" });
  mem.add({ sessionId: "h", askedAt: 2, question: "newer", answer: "b", sources: [], model: "m", origin: "chat" });
  const rows = (await (await fetch(`${base}/api/history`)).json()) as { session_id: string; question: string }[];
  assert.deepEqual(rows.filter((r) => r.session_id === "h").map((r) => r.question), ["newer", "older"]);
  assert.deepEqual(await (await fetch(`${base}/api/session/nobody`)).json(), []);
  assert.equal((await fetch(`${base}/api/nothing-here`)).status, 404);
});

test("the page, its icon and the vendored libraries are served; nothing outside public/ is", async () => {
  const page = await fetch(`${base}/`);
  assert.match(await page.text(), /<title>minimi chat agent<\/title>/);
  assert.equal(page.headers.get("x-powered-by"), null);
  assert.match((await fetch(`${base}/favicon.svg`)).headers.get("content-type") ?? "", /svg/);
  for (const lib of ["/vendor/marked.js", "/vendor/purify.js"]) {
    const res = await fetch(`${base}${lib}`);
    assert.equal(res.status, 200, lib);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  }
  for (const path of ["/..%2f.env", "/..%2fpackage.json", "/%2e%2e/src/llm.ts", "/vendor/..%2f..%2f.env"]) {
    const res = await fetch(`${base}${path}`);
    assert.ok(res.status === 404 || res.status === 400 || res.status === 403, `${path} -> ${res.status}`);
  }
});

test("listens on this machine only, never on the network", () => {
  assert.equal((server.address() as { address: string }).address, "127.0.0.1");
});

test("a busy port: the app takes the next free one", async () => {
  const blocker = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const busy = (blocker.address() as { port: number }).port;
  const s = await listen(createApp(mem), busy);
  assert.notEqual((s.address() as { port: number }).port, busy);
  s.close();
  blocker.close();
});
