# Security policy

## What the agent touches

It runs on your machine as one Node process. It:

- reads API keys from `.env`, sends each only to its own service, and never returns them to the
  page (`/api/status` lists model names only, and a test checks this)
- stores conversations in `data/memory.db` on your machine, and nowhere else
- sends your messages and recalled context to Gemini (or Groq), and search queries to Tavily
- listens on `localhost` only, with no accounts or authentication: do not expose the port to a
  network

The page loads the Roboto font from Google Fonts. Answers are rendered from Markdown and
sanitised with DOMPurify: scripts, event handlers, inline styles and non-http links are removed,
and search results are treated as data, never as instructions.

## Supported versions

The latest release receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/SanyamWadhwa07/minimi-chat-agent/security/advisories/new).
You will get an acknowledgement within three days.
