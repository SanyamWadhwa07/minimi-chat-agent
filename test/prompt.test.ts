import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBlock, historyMessages, SYSTEM_PROMPT } from "../src/prompt.ts";
import type { Recall } from "../src/memory/recall.ts";
import type { Turn } from "../src/memory/db.ts";

const NOW = new Date(2026, 10, 10, 15, 4);
const turn = (over: Partial<Turn> = {}): Turn => ({ id: 1, sessionId: "s", askedAt: new Date(2026, 10, 3, 10, 42).getTime(), question: "Cheapest Postgres?", answer: "Neon [1].", sources: [{ n: 1, title: "Neon pricing", url: "https://neon.tech/pricing", published: "2026-10-30", snippet: "" }], model: "m", origin: "chat", ...over });
const empty: Recall = { lookups: [], turns: [], stored: 0, firstAt: null, omitted: 0 };

test("first conversation ever: the model is told memory is empty", () => {
  const block = contextBlock(empty, NOW);
  assert.match(block, /^<context>\nNow: Tue 10 Nov 2026, 15:04 \(the user's local time\)/);
  assert.match(block, /Memory: empty\. This is the user's first conversation with you\./);
});

test("only this conversation stored: memory outside it is empty, not the whole memory", () => {
  assert.match(contextBlock({ ...empty, firstAt: NOW.getTime() }, NOW), /Memory: nothing outside this conversation yet\./);
});

test("a date that found nothing is stated plainly, so the model cannot invent it", () => {
  const block = contextBlock({ ...empty, stored: 3, firstAt: new Date(2026, 10, 2).getTime(), lookups: [{ text: "on Monday", window: { start: new Date(2026, 10, 9).getTime(), end: new Date(2026, 10, 10).getTime() }, hits: 0 }] }, NOW);
  assert.match(block, /Memory: 3 earlier exchanges outside this conversation, the first on Mon 2 Nov 2026\./);
  assert.match(block, /- "on Monday" = Mon 9 Nov 2026: nothing stored that day\./);
});

test("a recalled exchange carries its time and the sources it cited", () => {
  const block = contextBlock({ ...empty, stored: 1, firstAt: 1, turns: [{ turn: turn(), why: "date", full: true }], omitted: 4 }, NOW);
  assert.match(block, /<exchange asked="Tue 3 Nov 2026, 10:42">\nUser: Cheapest Postgres\?\nYou: Neon \[1\]\.\nSources you cited then:\n\[1\] Neon pricing \(published 2026-10-30\) https:\/\/neon\.tech\/pricing/);
  assert.match(block, /\(4 older exchanges not shown\.\)/);
});

test("history keeps each question's time; the system prompt never changes (so it can be cached)", () => {
  assert.deepEqual(historyMessages([turn()]), [
    { role: "user", content: "[Tue 3 Nov 2026, 10:42] Cheapest Postgres?" },
    { role: "assistant", content: "Neon [1]." },
  ]);
  assert.doesNotMatch(SYSTEM_PROMPT, /\d{4}|Now:/);
});
