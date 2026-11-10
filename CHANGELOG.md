# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-10

### Added

- **Add demo history** on the start screen: the agent answers three real questions dated last
  Tuesday, Monday and 3 November, shown live, so a new install has memory to try. Same as
  `npm run seed`.

### Fixed

- Node 22.13 to 22.15 ship SQLite without full-text search, so recall failed there. The minimum is
  now Node 22.16, the first Node 22 with it; `npm run dev` says so on older versions, and CI tests
  22.16.

## [1.0.0] - 2026-11-10

### Added

- A chat agent with one tool, web search (Tavily), that answers with numbered sources.
- Memory of every completed exchange, with the time it was asked and the sources it cited, in a
  local SQLite file. Date phrases ("last Tuesday", "3 November", "last week") are resolved in code
  and recalled before the model runs, along with topic matches and recent turns, within a size
  budget.
- "Is it still correct?" checks: a search with a `since` date fetches the current page and pages
  published since then, and the agent fills in that date itself when the question is about change.
- Two Gemini models (a fast one picks searches, a stronger one writes), with Groq as a fallback,
  a cool-down for a failing provider, and stall timeouts on every request.
- A chat page in minimi's palette: live view of what was recalled and searched, citations,
  source cards, a memory drawer, and a mini window in Chrome.
- 83 unit and integration tests (no keys needed) and a 16-conversation live eval.

[1.1.0]: https://github.com/SanyamWadhwa07/minimi-chat-agent/releases/tag/v1.1.0
[1.0.0]: https://github.com/SanyamWadhwa07/minimi-chat-agent/releases/tag/v1.0.0
