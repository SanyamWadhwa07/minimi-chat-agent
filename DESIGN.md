# Design

Every test question has one shape: *find what I asked on a date, then check today's web against
it.* So the design centres on what a model can't do alone: know what happened when, and check an
old answer properly.

![One turn](docs/assets/architecture.svg)

## How it works, and why

**Memory is context, not a tool.** The brief allows one tool. A recall tool would also cost a round
trip and rely on the model deciding to call it. So before the model runs, `temporal.ts` turns date
phrases into local-time windows, using chrono-node plus fixes where it is wrong for memory ("this
Monday" landing in the future, "march forward" read as a month). `recall.ts` then fills a size
budget in priority order: turns on those dates, topic matches (SQLite FTS5), and everything else
as one line each. While memory is small everything fits, so nothing is missed. An ambiguous
weekday gets two candidate days, and the first with turns wins. A wrong day is caught by topic.

**Every answer is stored with its time and cited sources,** so "is it still correct?" is
mechanical. `web_search({query, since})` runs two requests at once: the current page, with no date
filter because pricing pages are edited in place, and pages published since then. When the
question is about change, code fills in `since` from the recalled date; Groq's model often forgot
to. Answers report each item as unchanged, changed, or not verifiable, and the agent says "no
change found", never "nothing changed".

**Fewer serial steps.** No planner or summariser call. A fast model (gemini-3.6-flash) picks every
search in one step, they run in parallel, and gemini-3.8-flash writes the answer, streamed. If
Gemini fails before any text is shown, Groq answers. A failing provider rests for 30 s, or as long
as its rate limit asks, and requests are trimmed to Groq's per-minute tokens using its rate-limit
headers.

## Measured

**Live** (`npm run eval`, 16 conversations): 16/16 pass. The median time to first words is
**6.0 s with search** and **1.7 s without**: about 2 s to pick searches, 1 s of searching, then
2–3 s until the answer starts. Three findings shaped the code:

- gemini-3.6-flash picks the same searches in about 1.6 s instead of 2.2–5.4 s. But writing
  answers, it called prices "unchanged" while citing one source for both then and now, so it only
  picks searches.
- On Gemini, `tool_choice: "none"` on the last step returned empty answers. The last step now has
  no tools, plus a note to answer from what it has.
- Tavily's "news" topic answered "Supabase pricing" with OECD tax and PS5 stories at relevance up
  to 1.0, so it was dropped.

**Offline** (`npm test`, 84 tests, no keys): a scripted network replays both providers' real
stream formats and forces every failure: rate limits, stalls before and during an answer, broken
streams, malformed tool calls, search errors and timeouts, a closed tab, oversized and malformed
requests, path traversal, a busy port. Writing them found four bugs: "march" and "sun" read as
dates, Hindi split into fragments by full-text search, a topic match lost beyond the newest 200
turns, and the server listening on every network interface instead of this machine only.

## Considered and rejected

- **Memory as a second tool:** against the brief, and it adds a round trip.
- **Embeddings:** every sample question is keyed by a date, and FTS plus recency covers one user's
  history. It would also add a vendor.
- **Vercel AI SDK:** v7 renamed its loop APIs this year. One `fetch` path covers both providers.
- **Gemini's built-in search:** Groq has no equivalent, and it gives no date filter and no sources
  to store.
- **better-sqlite3:** a native build `npm install` can fail on. `node:sqlite` is built into Node.

## Scaling

It is built for one person on one machine, as minimi is. Serving many users changes the stores,
not the shape. A turn is already one streamed HTTP request with no server-side session, so app
servers stay stateless behind a load balancer.

| Today | At scale | What stays the same |
|---|---|---|
| SQLite file, one user | Postgres, rows keyed by user, a time index and full-text search | the recall order and budget |
| Provider cool-downs in memory | a shared store (Redis), so every server skips a failing provider | the fallback code |
| Keys in `.env` | server-side keys, per-user rate limits and spend caps | one search tool |
| A search per call | results cached per query per day, since re-checks repeat queries | the `since` double search |
| Timings shown on the page | the same per-stage timings exported as metrics, with alerts on stalls | |

**Limits:** beyond the budget (hundreds of turns), an undated paraphrase can be missed. Stored
sources are excerpts. Two model calls plus a search is the latency floor.

## With another week

1. **Store structured claims** (item, value, source, date) and compare those instead of prose.
   That also enables minimi's real job: a background check that pings you when a claim changes.
2. **An LLM-judged correctness eval**, run nightly, gating model and prompt changes.
3. **Hybrid recall** (embeddings plus FTS), switched on only when memory outgrows the budget.
4. **Start each search as its tool call streams in**, and cache results per query per day.
