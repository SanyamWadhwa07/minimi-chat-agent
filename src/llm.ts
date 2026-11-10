// Model client: Gemini first, Groq second, both through their OpenAI-compatible chat endpoints with
// plain fetch, so one code path serves both and there is no SDK to drift. Adapted from the
// provider loop in my earlier project (Paypal-AI/lib/ai/llm.ts); new here: streaming, stall
// timeouts, a cool-down for a provider that just failed, and fitting requests into Groq's small
// per-minute token budget.

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  extra_content?: unknown; // Gemini's thought signature: must go back unchanged with the next request
};
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ModelChoice = { model: string; extra: Record<string, unknown> }; // extra: provider-specific request fields
export type Provider = {
  name: "gemini" | "groq";
  base: string;
  key: string;
  // The first step of a turn mostly decides what to search, so a faster model does it. Every step
  // after search results comes back uses the main model, which writes the answers that rest on
  // fresh facts. Measured on the same prompt: gemini-3.6-flash plans the same searches in ~1.6 s
  // vs ~2.6 s, but writing answers it copied old prices instead of checking them, so it only plans.
  first: ModelChoice;
  main: ModelChoice;
  resultChars: number; // how much page text per search result this provider gets
};

/** Configured providers, in the order they are tried. */
export function providers(): Provider[] {
  const list: Provider[] = [];
  if (process.env.GEMINI_API_KEY) {
    list.push({
      name: "gemini",
      base: "https://generativelanguage.googleapis.com/v1beta/openai",
      key: process.env.GEMINI_API_KEY,
      first: { model: process.env.GEMINI_FAST_MODEL || "gemini-3.6-flash", extra: { reasoning_effort: "minimal" } },
      main: { model: process.env.GEMINI_MODEL || "gemini-3.8-flash", extra: { reasoning_effort: "low" } },
      resultChars: 900,
    });
  }
  if (process.env.GROQ_API_KEY) {
    const model = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
    // Keep reasoning out of the answer text. gpt-oss models take a different field for this.
    const extra = model.includes("gpt-oss") ? { include_reasoning: false } : model.includes("qwen") ? { reasoning_format: "hidden" } : {};
    list.push({
      name: "groq",
      base: "https://api.groq.com/openai/v1",
      key: process.env.GROQ_API_KEY,
      first: { model, extra },
      main: { model, extra },
      resultChars: 400, // Groq's free tier allows 8,000 tokens a minute
    });
  }
  return list;
}

// ------------------------------------------------------------------ stream parsing

/** Splits an SSE byte stream into the JSON payloads of its `data:` lines. */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      yield JSON.parse(data);
    }
  }
}

/**
 * Builds tool calls from streamed deltas. The two providers stream them differently:
 *   Groq (OpenAI style): fragments of one call share an `index`; arguments arrive in pieces.
 *   Gemini: each call arrives whole in its own chunk with no `index`; only the first call of a
 *   parallel set carries the thought signature (`extra_content`).
 * Both shapes are recorded in test/fixtures and covered by test/stream.test.ts.
 */
export function toolCallAssembler() {
  const calls: ToolCall[] = [];
  const byIndex = new Map<number, ToolCall>();
  const fresh = () => {
    const c: ToolCall = { id: "", type: "function", function: { name: "", arguments: "" } };
    calls.push(c);
    return c;
  };
  type Delta = { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown };
  return {
    add(d: Delta) {
      let c: ToolCall;
      if (typeof d.index === "number") {
        c = byIndex.get(d.index) ?? fresh();
        byIndex.set(d.index, c);
      } else {
        c = d.id && !calls.some((x) => x.id === d.id) ? fresh() : (calls.at(-1) ?? fresh());
      }
      if (d.id) c.id = d.id;
      if (d.function?.name) c.function.name += d.function.name;
      if (d.function?.arguments) c.function.arguments += d.function.arguments;
      if (d.extra_content) c.extra_content = d.extra_content;
    },
    // Some providers leave ids empty; every call needs one so its result can be matched.
    done: () => calls.map((c, i) => ({ ...c, id: c.id || `call_${i}`, function: { ...c.function, arguments: c.function.arguments || "{}" } })),
  };
}

// ------------------------------------------------------------------ fitting Groq's token budget

/** Rough token count: about 4 characters per token for English text and JSON. */
export const estimateTokens = (messages: ChatMessage[]) => Math.ceil(JSON.stringify(messages).length / 4);

/**
 * Shortens tool results (the bulk of a request) until the request fits `maxTokens`. Used before
 * every Groq call: a turn that started on Gemini can hold more search text than Groq accepts.
 */
export function fitToBudget(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (estimateTokens(messages) <= maxTokens) return messages;
  const over = estimateTokens(messages) - maxTokens * 0.95; // a little under, for the "[cut]" markers
  const toolChars = messages.reduce((n, m) => n + (m.role === "tool" ? m.content.length : 0), 0);
  if (!toolChars) return messages;
  const keep = Math.max(0, 1 - (over * 4) / toolChars);
  return messages.map((m) => (m.role === "tool" ? { ...m, content: `${m.content.slice(0, Math.floor(m.content.length * keep))}…[cut to fit]` } : m));
}

// ------------------------------------------------------------------ one streamed model step

export class ModelError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
  }
}

/** Stall limits. A tool step with thinking measured 2-4 s, so 20 s without a first chunk means stuck. */
export const limits = { firstChunkMs: 20_000, idleMs: 15_000 };

// A provider that just failed is skipped for a while, so the next step does not pay for the same
// failure again. Groq's remaining-token count comes from its rate-limit headers.
const health = new Map<string, { until: number; why: string }>();
const groqTokens = { limit: 8000, remaining: 8000, at: 0 };
/** Forget cool-downs and token counts (tests start from a clean state). */
export function resetProviderState() {
  health.clear();
  Object.assign(groqTokens, { limit: 8000, remaining: 8000, at: 0 });
}

export type StepResult = { text: string; toolCalls: ToolCall[]; provider: Provider; model: string };
type StepRequest = { messages: ChatMessage[]; tools: unknown[]; toolChoice: "auto" | "none"; first: boolean };
export type StepHooks = { onText: (delta: string) => void; onSwitch: (from: Provider, to: Provider, why: string) => void };

/**
 * One model step, streamed. Tries providers in order and moves to the next on any failure, as long
 * as no text has reached the user yet. After text has started, a failure is thrown as a ModelError.
 */
export async function streamStep(
  req: StepRequest,
  hooks: StepHooks,
  signal: AbortSignal,
): Promise<StepResult> {
  const all = providers();
  if (!all.length) throw new ModelError("No model is set up: add GEMINI_API_KEY or GROQ_API_KEY to .env", false);
  const ready = all.filter((p) => (health.get(p.name)?.until ?? 0) < Date.now());
  const order = ready.length ? [...ready, ...all.filter((p) => !ready.includes(p))] : all;

  const errors: string[] = [];
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    // Groq rejects a malformed tool call the model generated with a 400; that is a glitch, not an
    // outage, so it gets one retry (measured: about 1 run in 5 on qwen3.8-27b).
    for (let attempt = 0; attempt < 2; attempt++) {
      let streamed = false;
      try {
        return await attemptStep(p, req, (d) => {
          streamed = true;
          hooks.onText(d);
        }, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        const detail = e instanceof Error ? e.message : String(e);
        const why = shortReason(e);
        if (streamed) throw new ModelError(`The answer was cut off (${p.name}: ${why}).`);
        if (attempt === 0 && /tool call validation|tool_use_failed|parse tool call/i.test(detail)) continue;
        const wait = e instanceof HttpError && e.status === 429 ? (e.retryAfter ?? 60) : 30;
        health.set(p.name, { until: Date.now() + wait * 1000, why });
        errors.push(`${p.name}: ${why}`);
        console.error(`[llm] ${p.name} failed: ${detail}`);
        if (order[i + 1]) hooks.onSwitch(p, order[i + 1], why);
        break;
      }
    }
  }
  if (errors.every((x) => x.endsWith(NETWORK))) throw new ModelError("Could not reach any model service. Check your internet connection and retry.");
  throw new ModelError(`No model could answer (${errors.join("; ")}). Check the keys in .env, or retry in a minute.`);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

const NETWORK = "could not connect";

/** A few words for the user; the full error goes to the server log. */
function shortReason(e: unknown) {
  if (e instanceof TypeError && /fetch failed/i.test(e.message)) return NETWORK;
  if (!(e instanceof HttpError)) return e instanceof Error ? e.message : String(e);
  if (e.status === 429) return "rate limit reached";
  if (e.status === 401 || e.status === 403 || /api key/i.test(e.message)) return "API key rejected";
  if (e.status >= 500) return `server error ${e.status}`;
  return `request rejected (HTTP ${e.status})`;
}

async function attemptStep(p: Provider, req: StepRequest, onText: (d: string) => void, outer: AbortSignal): Promise<StepResult> {
  const { model, extra } = req.first ? p.first : p.main;
  let messages = req.messages;
  if (p.name !== "gemini") {
    // Thought signatures mean nothing to other providers.
    messages = messages.map((m) => (m.role === "assistant" && m.tool_calls ? { ...m, tool_calls: m.tool_calls.map(({ extra_content: _, ...c }) => c) } : m));
    const sinceReset = Date.now() - groqTokens.at > 60_000;
    const available = sinceReset ? groqTokens.limit : groqTokens.remaining;
    messages = fitToBudget(messages, Math.max(1500, available - 1200)); // leave room for the answer
  }

  // One controller for the whole attempt: aborted by the user, a first-chunk timeout or an idle gap.
  const ctrl = new AbortController();
  const stop = () => ctrl.abort(outer.reason);
  outer.addEventListener("abort", stop, { once: true });
  let timer = setTimeout(() => ctrl.abort(new Error(`no response in ${limits.firstChunkMs / 1000} s`)), limits.firstChunkMs);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error(`stream stalled for ${limits.idleMs / 1000} s`)), limits.idleMs);
  };

  try {
    const res = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model, messages, ...(req.tools.length ? { tools: req.tools, tool_choice: req.toolChoice } : {}), stream: true, ...extra }),
      signal: ctrl.signal,
    });
    if (p.name === "groq") {
      const limit = Number(res.headers.get("x-ratelimit-limit-tokens"));
      const remaining = Number(res.headers.get("x-ratelimit-remaining-tokens"));
      if (limit && !Number.isNaN(remaining)) Object.assign(groqTokens, { limit, remaining, at: Date.now() });
    }
    if (!res.ok || !res.body) {
      const body = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      throw new HttpError(res.status, `HTTP ${res.status}: ${body}`, retryAfter);
    }

    const calls = toolCallAssembler();
    let text = "";
    for await (const event of sseData(res.body as unknown as AsyncIterable<Uint8Array>)) {
      touch();
      const e = event as { error?: { message?: string }; choices?: { delta?: { content?: string | null; tool_calls?: unknown[] } }[] };
      if (e.error) throw new Error(e.error.message ?? "the stream reported an error");
      const delta = e.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        onText(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) calls.add(tc as Parameters<typeof calls.add>[0]);
    }
    return { text, toolCalls: calls.done(), provider: p, model };
  } catch (e) {
    // Surface why the controller fired (timeout message) rather than a bare AbortError.
    if (ctrl.signal.aborted && !outer.aborted && ctrl.signal.reason instanceof Error) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", stop);
  }
}
