// A scripted network for tests: answers the model and search APIs from a queue, records every
// request, and can stall, fail or stream slowly on demand. No keys, no cost, deterministic.
import { mock } from "node:test";

export type Step =
  | { kind: "sse"; events: object[]; status?: number; headers?: Record<string, string>; gapMs?: number; hang?: boolean; failAfter?: number }
  | { kind: "json"; body: unknown; status?: number; headers?: Record<string, string>; delayMs?: number }
  | { kind: "network-error" }
  | { kind: "hang" }; // never answers until aborted

export type Call = { url: string; body: any; signal?: AbortSignal; at: number };

/** Chunks in each provider's real streaming shape (see test/fixtures). */
export const chunk = {
  text: (t: string) => ({ choices: [{ delta: { content: t } }] }),
  /** Gemini: a whole call per chunk, no index; the first of a set carries a thought signature. */
  geminiCall: (id: string, args: object, signature?: string) => ({
    choices: [{ delta: { role: "assistant", tool_calls: [{ id, type: "function", function: { name: "web_search", arguments: JSON.stringify(args) }, ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}) }] } }],
  }),
  /** Groq / OpenAI: fragments keyed by index. */
  groqCall: (index: number, id: string, args: object) => ({ choices: [{ delta: { tool_calls: [{ index, id, type: "function", function: { name: "web_search", arguments: JSON.stringify(args) } }] } }] }),
  error: (message: string) => ({ error: { message } }),
};

export const tavilyResults = (...results: { title: string; url: string; content?: string; published_date?: string }[]) => ({ kind: "json" as const, body: { results } });

function sseResponse(step: Extract<Step, { kind: "sse" }>, signal?: AbortSignal) {
  const enc = new TextEncoder();
  let i = 0;
  let timer: NodeJS.Timeout | undefined;
  const socket = setInterval(() => {}, 1000); // stands in for the open connection, as above
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        clearInterval(socket);
        try {
          ctrl.error(signal.reason);
        } catch {}
      });
    },
    cancel() {
      clearInterval(socket);
    },
    async pull(ctrl) {
      if (step.gapMs) await new Promise((r) => (timer = setTimeout(r, step.gapMs)));
      if (signal?.aborted) return;
      if (step.failAfter !== undefined && i === step.failAfter) {
        clearInterval(socket);
        return ctrl.error(new TypeError("terminated"));
      }
      if (i < step.events.length) return ctrl.enqueue(enc.encode(`data: ${JSON.stringify(step.events[i++])}\n\n`));
      if (step.hang) return new Promise(() => {}); // stays open, sends nothing more
      clearInterval(socket);
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
  });
  return new Response(stream, { status: step.status ?? 200, headers: { "Content-Type": "text/event-stream", ...step.headers } });
}

/**
 * Replaces fetch. `routes` maps a URL substring ("generativelanguage", "groq", "tavily") to a queue
 * of responses, used in order; the last one repeats. Returns the recorded calls.
 */
const realFetch = globalThis.fetch;

export function fakeNetwork(routes: Record<string, Step[]>) {
  const calls: Record<string, Call[]> = Object.fromEntries(Object.keys(routes).map((k) => [k, []]));
  const t0 = performance.now();
  mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init); // the app under test
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request to ${url}`);
    const queue = routes[key];
    const n = calls[key].length;
    const step = queue[Math.min(n, queue.length - 1)];
    const signal = init.signal ?? undefined;
    calls[key].push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, signal, at: performance.now() - t0 });
    const abortable = <T>(p: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason));
        p.then(resolve, reject);
      });
    if (step.kind === "network-error") throw new TypeError("fetch failed");
    // A real stalled request holds a socket open, which keeps Node running until a timeout fires.
    // An interval stands in for that socket.
    if (step.kind === "hang") {
      const socket = setInterval(() => {}, 1000);
      return abortable(new Promise<Response>(() => {})).finally(() => clearInterval(socket));
    }
    if (step.kind === "json") {
      if (step.delayMs) await abortable(new Promise((r) => setTimeout(r, step.delayMs)));
      return new Response(JSON.stringify(step.body), { status: step.status ?? 200, headers: { "Content-Type": "application/json", ...step.headers } });
    }
    return sseResponse(step, signal);
  });
  return calls;
}

/** Fake keys for every provider, so each test controls which ones exist. */
export function setKeys(keys: { gemini?: boolean; groq?: boolean; tavily?: boolean } = { gemini: true, groq: true, tavily: true }) {
  for (const [name, on] of [["GEMINI_API_KEY", keys.gemini], ["GROQ_API_KEY", keys.groq], ["TAVILY_API_KEY", keys.tavily]] as const) {
    if (on) process.env[name] = `test-${name.toLowerCase()}`;
    else delete process.env[name];
  }
  for (const name of ["GEMINI_MODEL", "GEMINI_FAST_MODEL", "GROQ_MODEL"]) delete process.env[name];
}
