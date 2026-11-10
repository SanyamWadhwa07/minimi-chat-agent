import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { webSearch, SourceList, SearchError, searchLimits } from "../src/search.ts";
import { fakeNetwork, tavilyResults, setKeys } from "./fake.ts";

beforeEach(() => {
  setKeys();
  searchLimits.timeoutMs = 6000;
});
afterEach(() => mock.restoreAll());

const NEON = { title: "Neon pricing", url: "https://neon.tech/pricing", content: "Launch plan from $19 a month.", published_date: "Thu, 05 Nov 2026 10:00:00 GMT" };

test("one request without since; results numbered, dated and cited by number", async () => {
  const calls = fakeNetwork({ tavily: [tavilyResults(NEON, { title: "Supabase pricing", url: "https://supabase.com/pricing", content: "Pro is $25." })] });
  const sources = new SourceList();
  const out = await webSearch({ query: "postgres pricing" }, sources);
  assert.equal(calls.tavily.length, 1);
  assert.equal(calls.tavily[0].body.query, "postgres pricing");
  assert.equal(calls.tavily[0].body.start_date, undefined);
  assert.equal(out.results, 2);
  assert.match(out.text, /\[1\] Neon pricing https:\/\/neon\.tech\/pricing \(published 2026-11-05\)/);
  assert.match(out.text, /\[2\] Supabase pricing/);
  assert.deepEqual(sources.items.map((s) => [s.n, s.published]), [[1, "2026-11-05"], [2, null]]);
});

test("with since: the current page and pages since that date, requested in parallel", async () => {
  const calls = fakeNetwork({ tavily: [{ ...tavilyResults(NEON), delayMs: 50 }, { ...tavilyResults({ ...NEON, url: "https://neon.tech/blog/new-plans" }), delayMs: 50 }] });
  const out = await webSearch({ query: "neon pricing", since: "2026-11-03" }, new SourceList());
  assert.equal(calls.tavily.length, 2);
  assert.equal(calls.tavily[0].body.start_date, undefined); // pricing pages keep old dates: no filter
  assert.equal(calls.tavily[1].body.start_date, "2026-11-03");
  assert.ok(calls.tavily[1].at - calls.tavily[0].at < 30, "second request sent before the first answered");
  assert.match(out.text, /Current results:[\s\S]*Published or updated since 2026-11-03:/);
});

test("the same page is listed once across searches, whatever its URL decoration", async () => {
  fakeNetwork({
    tavily: [
      tavilyResults(NEON, { ...NEON, url: "https://neon.tech/pricing#:~:text=Launch" }),
      tavilyResults({ ...NEON, url: "https://www.NEON.tech/pricing/" }, { title: "Other", url: "https://example.com/a" }),
    ],
  });
  const sources = new SourceList();
  const first = await webSearch({ query: "a" }, sources);
  const second = await webSearch({ query: "b" }, sources);
  assert.equal(first.results, 1);
  assert.equal(second.results, 1);
  assert.match(second.text, /\[2\] Other/);
  assert.deepEqual(sources.items.map((s) => s.url), ["https://neon.tech/pricing", "https://example.com/a"]);
});

test("each failure says what went wrong, in words the user can act on", async () => {
  const cases: [number, RegExp, Record<string, string>?][] = [
    [401, /rejected TAVILY_API_KEY/],
    [429, /rate-limiting, retry in 7 s/, { "retry-after": "7" }],
    [432, /monthly searches are used up/],
    [433, /pay-as-you-go limit/],
    [502, /returned HTTP 502/],
  ];
  for (const [status, message, headers] of cases) {
    fakeNetwork({ tavily: [{ kind: "json", status, body: {}, headers }] });
    await assert.rejects(webSearch({ query: "x" }, new SourceList()), (e) => e instanceof SearchError && message.test(e.message));
    mock.restoreAll();
  }
  fakeNetwork({ tavily: [{ kind: "network-error" }] });
  await assert.rejects(webSearch({ query: "x" }, new SourceList()), /could not reach the search service/);
});

test("a missing key fails before any request", async () => {
  setKeys({ gemini: true, groq: true, tavily: false });
  const calls = fakeNetwork({ tavily: [tavilyResults()] });
  await assert.rejects(webSearch({ query: "x" }, new SourceList()), /TAVILY_API_KEY is missing/);
  assert.equal(calls.tavily.length, 0);
});

test("a slow search times out instead of hanging the answer", async () => {
  searchLimits.timeoutMs = 40;
  fakeNetwork({ tavily: [{ kind: "hang" }] });
  const t0 = performance.now();
  await assert.rejects(webSearch({ query: "x" }, new SourceList()), /timed out after 0.04 s/);
  assert.ok(performance.now() - t0 < 1000);
});

test("if one half of a since-search fails, the other half is still used", async () => {
  fakeNetwork({ tavily: [tavilyResults(NEON), { kind: "json", status: 500, body: {} }] });
  const out = await webSearch({ query: "neon", since: "2026-11-03" }, new SourceList());
  assert.equal(out.results, 1);
  assert.match(out.text, /Published or updated since 2026-11-03: this search failed \(the search service returned HTTP 500\)/);
});

test("stopping the turn cancels the search", async () => {
  const calls = fakeNetwork({ tavily: [{ kind: "hang" }] });
  const ctrl = new AbortController();
  const pending = webSearch({ query: "x" }, new SourceList(), { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(new Error("stopped")), 20);
  await assert.rejects(pending, /stopped/);
  assert.equal(calls.tavily[0].signal?.aborted, true);
});

test("odd results: no title, bad date, broken URL, nothing found, long page text", async () => {
  fakeNetwork({
    tavily: [
      tavilyResults({ title: "", url: "https://docs.example.com/x", content: "a".repeat(5000), published_date: "not a date" }, { title: "Broken", url: "not a url" }),
      tavilyResults(),
    ],
  });
  const sources = new SourceList();
  const out = await webSearch({ query: "x" }, sources, { maxChars: 100 });
  assert.equal(sources.items[0].title, "docs.example.com");
  assert.equal(sources.items[0].published, null);
  assert.equal(sources.items[1].url, "not a url");
  assert.ok(!out.text.includes("a".repeat(101)), "page text cut to maxChars");
  assert.match((await webSearch({ query: "y" }, sources)).text, /Current results: nothing found\./);
});
