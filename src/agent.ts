// One chat turn:
//   1. recall: resolve date phrases and pick past exchanges (code, a few ms, no model call)
//   2. up to three model steps with web_search; all searches of a step run in parallel; streamed
//   3. save the exchange with its time and the sources it cited (only if it completed)
import type { Memory, Source, Turn } from "./memory/db.ts";
import { resolveTimeRefs } from "./memory/temporal.ts";
import { recall } from "./memory/recall.ts";
import { streamStep, ModelError, type ChatMessage, type Provider, type ToolCall } from "./llm.ts";
import { SEARCH_TOOL, searchArgs, webSearch, SourceList, SearchError } from "./search.ts";
import { SYSTEM_PROMPT, contextBlock, historyMessages } from "./prompt.ts";
import { isoDay } from "./clock.ts";

/** What the UI is told while a turn runs, in order. */
export type AgentEvent =
  | { type: "recall"; lookups: { text: string; start: number; end: number; hits: number }[]; turns: { askedAt: number; question: string; why: string }[]; stored: number }
  | { type: "search"; id: string; query: string; since?: string; status: "running" | "done" | "error"; results?: number; error?: string }
  | { type: "text"; delta: string }
  | { type: "notice"; message: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; turnId: number; askedAt: number; model: string; timings: Timings }
  | { type: "error"; message: string; retryable: boolean };
/** Where the time went: recall, each model step, and the search batches (each batch runs in parallel). */
export type Timings = { recallMs: number; stepMs: number[]; searchMs: number; firstTextMs: number | null; totalMs: number; searches: number };

const MAX_STEPS = 3; // search, maybe one follow-up search, answer
const MAX_SEARCHES = 12; // per answer; each is one or two search credits
const HISTORY_TURNS = 6; // earlier turns of this conversation sent as chat messages
const ASKS_ABOUT_CHANGE = /\b(?:chang\w*|still|since|updat\w*|correct|accurate|right now)\b/i;

export async function runTurn(
  mem: Memory,
  input: { sessionId: string; message: string; now?: Date; origin?: Turn["origin"] },
  emit: (e: AgentEvent) => void,
  signal: AbortSignal,
): Promise<Turn | null> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const now = input.now ?? new Date(); // seed and tests pass an earlier "now"
  try {
    // 1. Recall
    const history = mem.session(input.sessionId, HISTORY_TURNS);
    const r = recall(mem, input.message, resolveTimeRefs(input.message, now), { exclude: history.map((t) => t.id) });
    const recallMs = ms();
    emit({
      type: "recall",
      lookups: r.lookups.map((l) => ({ text: l.text, start: l.window.start, end: l.window.end, hits: l.hits })),
      turns: r.turns.filter((t) => t.why !== "recent").map((t) => ({ askedAt: t.turn.askedAt, question: t.turn.question, why: t.why })),
      stored: r.stored,
    });

    // 2. Model steps
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...historyMessages(history),
      { role: "user", content: `${contextBlock(r, now)}\n\n${input.message}` },
    ];
    // "Has it changed since?" about a recalled conversation: every search covers that date, whether or
    // not the model remembers to pass it (Groq's model often does not; measured in the eval).
    const datedTurns = r.turns.filter((t) => t.why === "date").map((t) => t.turn.askedAt);
    const since = datedTurns.length && ASKS_ABOUT_CHANGE.test(input.message) ? isoDay(Math.min(...datedTurns)) : undefined;
    const sources = new SourceList();
    let answer = "";
    let firstTextMs: number | null = null;
    let searches = 0;
    const stepMs: number[] = [];
    let searchMs = 0;
    let model = "";
    let gap = false; // text before a search ends a paragraph; the answer after it starts a new one
    const onText = (d: string) => {
      firstTextMs ??= ms();
      if (gap) {
        d = `\n\n${d}`;
        gap = false;
      }
      answer += d;
      emit({ type: "text", delta: d });
    };
    const onSwitch = (from: Provider, to: Provider, why: string) => emit({ type: "notice", message: `${from.name} failed (${why}); answering with ${to.name}.` });

    const search = async (call: ToolCall, provider: Provider): Promise<string> => {
      if (call.function.name !== "web_search") return `Error: there is no tool named "${call.function.name}".`;
      let args;
      try {
        args = searchArgs.parse(JSON.parse(call.function.arguments));
      } catch {
        return 'Error: invalid arguments. Expected {"query": string, "since"?: "YYYY-MM-DD"}.';
      }
      if (searches >= MAX_SEARCHES) return "Not run: the search limit for one answer was reached. Answer with what you have.";
      args.since ??= since;
      searches++;
      emit({ type: "search", id: call.id, query: args.query, since: args.since, status: "running" });
      try {
        const out = await webSearch(args, sources, { signal, maxChars: provider.resultChars });
        emit({ type: "search", id: call.id, query: args.query, since: args.since, status: "done", results: out.results });
        return out.text;
      } catch (e) {
        if (signal.aborted) throw e;
        const why = e instanceof SearchError ? e.message : "the search failed";
        emit({ type: "search", id: call.id, query: args.query, since: args.since, status: "error", error: why });
        return `Search failed: ${why}. Tell the user you could not check this, and why.`;
      }
    };

    for (let step = 0; step < MAX_STEPS; step++) {
      const stepStart = ms();
      const last = step === MAX_STEPS - 1;
      // The last step must produce the answer. tool_choice "none" is not enough: Gemini then returns
      // an empty reply when it still wants to search (seen in the eval), so the tool is removed.
      if (last) messages.push({ role: "user", content: "(Searching is over for this answer. Answer now from the results above. If something important could not be confirmed, say so briefly.)" });
      const res = await streamStep({ messages, tools: last ? [] : [SEARCH_TOOL], toolChoice: "auto", first: step === 0 }, { onText, onSwitch }, signal);
      model = `${res.provider.name}: ${res.model}`;
      stepMs.push(ms() - stepStart);
      if (last || !res.toolCalls.length) break;
      if (res.text) gap = true;
      messages.push({ role: "assistant", content: res.text || null, tool_calls: res.toolCalls });
      const searchStart = ms();
      const results = await Promise.all(res.toolCalls.map((c) => search(c, res.provider)));
      searchMs += ms() - searchStart;
      res.toolCalls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: results[i] }));
    }
    if (!answer.trim()) throw new ModelError("The model returned an empty answer.");

    // 3. Save. Keep the sources the answer cites ([2], [1, 3]); with no citations, the first few.
    const cited = new Set([...answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(",").map(Number)));
    const kept = sources.items.filter((s) => cited.has(s.n));
    const turn: Omit<Turn, "id"> = {
      sessionId: input.sessionId,
      askedAt: now.getTime(),
      question: input.message,
      answer,
      sources: kept.length ? kept : sources.items.slice(0, 5),
      model,
      origin: input.origin ?? "chat",
    };
    if (signal.aborted) return null;
    const id = mem.add(turn);
    emit({ type: "sources", sources: kept });
    emit({ type: "done", turnId: id, askedAt: turn.askedAt, model, timings: { recallMs, stepMs, searchMs, firstTextMs, totalMs: ms(), searches } });
    return { id, ...turn };
  } catch (e) {
    if (signal.aborted) return null; // the user stopped it or left: nothing to show, nothing saved
    console.error("[agent]", e);
    const message = e instanceof Error ? e.message : String(e);
    emit({ type: "error", message, retryable: !(e instanceof ModelError) || e.retryable });
    return null;
  }
}
