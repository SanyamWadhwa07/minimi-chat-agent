// The agent's one tool: web search through Tavily, which returns page text in the same call (no
// scraping step) and can filter by publish date.
//
// With `since`, one tool call is two requests in parallel:
//   - the current state, no date filter: pricing pages are edited in place and keep an old publish
//     date, so a date filter alone would hide the very page that changed (Tavily's docs warn of this)
//   - pages published or updated since that date. (Tavily's "news" topic was tried and dropped: for
//     "Supabase pricing" it returned OECD tax and PS5 articles, with relevance scores up to 1.0.)
// Doing this in code means "has X changed since D" is checked the same way every time, instead of
// depending on the model remembering to make both searches.
import { z } from "zod";
import type { Source } from "./memory/db.ts";
import { isoDay } from "./clock.ts";

export const searchArgs = z.object({
  query: z.string().min(1).max(400),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type SearchArgs = z.infer<typeof searchArgs>;

/** The tool definition the model sees (OpenAI function format, which Gemini and Groq both accept). */
export const SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "web_search",
    description:
      "Search the web. Returns numbered results with page text and publish dates. Call it once per item to check; several calls in one turn run in parallel.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A specific search query, e.g. 'Neon Postgres pricing'." },
        since: {
          type: "string",
          description: "YYYY-MM-DD. Set it when asked what changed since a date: you then also get pages published or updated after that date.",
        },
      },
      required: ["query"],
    },
  },
};

/** A URL without its #fragment (Tavily adds "#:~:text=..." highlights). */
const clean = (url: string) => {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
};
/** Same page despite www., a trailing slash or letter case. */
const pageKey = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url;
  }
};

/** Numbers sources across one turn, so the answer can cite [1], [2] and the UI can link them. */
export class SourceList {
  readonly items: Source[] = [];
  /** Returns the source's number, and whether it was already in the list. */
  add(s: Omit<Source, "n">): { n: number; isNew: boolean } {
    const url = clean(s.url);
    const seen = this.items.find((x) => pageKey(x.url) === pageKey(url));
    if (seen) return { n: seen.n, isNew: false };
    const n = this.items.length + 1;
    this.items.push({ ...s, n, url });
    return { n, isNew: true };
  }
}

type Hit = { title?: string; url: string; content?: string; published_date?: string };

export class SearchError extends Error {}

/** One search request may take this long before it counts as failed. */
export const searchLimits = { timeoutMs: 6000 };

async function tavily(body: Record<string, unknown>, signal?: AbortSignal): Promise<Hit[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new SearchError("search is not set up: TAVILY_API_KEY is missing in .env");
  const timeout = AbortSignal.timeout(searchLimits.timeoutMs);
  let res: Response;
  try {
    res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ max_results: 5, search_depth: "fast", include_published_date: true, ...body }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new SearchError(timeout.aborted ? `search timed out after ${searchLimits.timeoutMs / 1000} s` : "could not reach the search service");
  }
  if (!res.ok) {
    const wait = res.headers.get("retry-after");
    const why: Record<number, string> = {
      401: "the search service rejected TAVILY_API_KEY",
      429: `the search service is rate-limiting${wait ? `, retry in ${wait} s` : ""}`,
      432: "the Tavily plan's monthly searches are used up",
      433: "the Tavily pay-as-you-go limit is reached",
    };
    throw new SearchError(why[res.status] ?? `the search service returned HTTP ${res.status}`);
  }
  return ((await res.json()) as { results?: Hit[] }).results ?? [];
}

/** "Thu, 25 Jun 2026 10:00:00 GMT" -> "2026-06-25"; null when missing or unreadable. */
function dateOf(raw?: string) {
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(ms) ? null : isoDay(ms);
}

/**
 * Runs one web_search call. Returns the text the model reads; adds every result to `sources`.
 * Throws SearchError only when nothing could be searched at all.
 */
export async function webSearch(args: SearchArgs, sources: SourceList, opts: { signal?: AbortSignal; maxChars?: number } = {}) {
  const maxChars = opts.maxChars ?? 900;
  const parts = [{ label: "Current results", body: { query: args.query } }];
  if (args.since) parts.push({ label: `Published or updated since ${args.since}`, body: { query: args.query, start_date: args.since } as never });

  const settled = await Promise.allSettled(parts.map((p) => tavily(p.body, opts.signal)));
  if (opts.signal?.aborted) throw opts.signal.reason;
  if (settled.every((s) => s.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;

  let results = 0;
  const sections = settled.map((s, i) => {
    if (s.status === "rejected") return `${parts[i].label}: this search failed (${s.reason instanceof Error ? s.reason.message : s.reason}).`;
    if (!s.value.length) return `${parts[i].label}: nothing found.`;
    const lines: string[] = [];
    for (const h of s.value) {
      const published = dateOf(h.published_date);
      const snippet = (h.content ?? "").replace(/\s+/g, " ").trim().slice(0, maxChars);
      const { n, isNew } = sources.add({ title: h.title?.trim() || new URL(h.url).hostname, url: h.url, published, snippet: snippet.slice(0, 300) });
      if (!isNew) continue; // the model already has this page's text under [n]
      results++;
      lines.push(`[${n}] ${h.title ?? ""} ${clean(h.url)}${published ? ` (published ${published})` : ""}\n${snippet}`);
    }
    return `${parts[i].label}:\n${lines.length ? lines.join("\n\n") : "only pages already listed above."}`;
  });
  return { text: `Search: "${args.query}"\n${sections.join("\n\n")}`, results };
}
