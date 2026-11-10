import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sseData, toolCallAssembler, fitToBudget, estimateTokens, type ChatMessage } from "../src/llm.ts";

// Recorded by scripts/spike-stream.ts from the real APIs, asked for two searches in parallel.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.sse`, import.meta.url));

/** Feeds bytes in small pieces, so JSON lines are split across chunks the way a network splits them. */
async function* chunks(bytes: Uint8Array, size = 7) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function parse(bytes: Uint8Array) {
  const calls = toolCallAssembler();
  let text = "";
  for await (const e of sseData(chunks(bytes))) {
    const delta = (e as { choices?: { delta?: { content?: string; tool_calls?: object[] } }[] }).choices?.[0]?.delta;
    if (delta?.content) text += delta.content;
    for (const tc of delta?.tool_calls ?? []) calls.add(tc);
  }
  return { text, calls: calls.done() };
}

test("Gemini: whole calls without an index, signature on the first", async () => {
  const { calls } = await parse(fixture("gemini-3.8-flash.step1"));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.ok(calls[0].extra_content, "first call keeps its thought signature");
  assert.equal(calls[1].extra_content, undefined);
  for (const c of calls) {
    assert.equal(c.function.name, "web_search");
    assert.match(JSON.parse(c.function.arguments).query, /neon|supabase/i);
  }
});

test("Groq: fragments joined by index", async () => {
  const { calls } = await parse(fixture("groq-qwen3.8-27b.step1"));
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.ok(c.id);
    assert.equal(c.function.name, "web_search");
    assert.ok(JSON.parse(c.function.arguments).query);
  }
});

test("text deltas, and calls that arrive with no id or arguments", async () => {
  const lines = [
    { choices: [{ delta: { content: "Hello" } }] },
    { choices: [{ delta: { content: ", world" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "web_search" } }] } }] },
  ].map((j) => `data: ${JSON.stringify(j)}\n\n`);
  const { text, calls } = await parse(new TextEncoder().encode(`${lines.join("")}data: [DONE]\n\n`));
  assert.equal(text, "Hello, world");
  assert.deepEqual(calls.map((c) => [c.id, c.function.arguments]), [["call_0", "{}"]]);
});

test("fitToBudget shortens only tool results, and only when over budget", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s".repeat(400) },
    { role: "user", content: "question" },
    { role: "tool", tool_call_id: "a", content: "x".repeat(20_000) },
    { role: "tool", tool_call_id: "b", content: "y".repeat(20_000) },
  ];
  assert.equal(fitToBudget(messages, 100_000), messages);
  const fitted = fitToBudget(messages, 4000);
  assert.ok(estimateTokens(fitted) <= 4000, `${estimateTokens(fitted)} tokens`);
  assert.equal(fitted[0], messages[0]);
  assert.match((fitted[2] as { content: string }).content, /cut to fit\]$/);
});
