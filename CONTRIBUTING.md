# Contributing

Thanks for helping. The project is small on purpose: about a thousand lines of TypeScript and one
page of plain JavaScript.

## Ground rules

- **No build step, no native modules.** `npm install` then `npm run dev` must work on a fresh
  machine. Storage is Node's built-in SQLite.
- **Code before model.** Anything that can be decided by code (dates, recall, which searches cover
  which day) is decided by code and unit-tested; the model gets the result.
- **Every failure is a message.** A change that adds a network call also adds a test for its
  timeout and its error path in `test/`, using the fake network in `test/fake.ts`.

## Set up and test

```bash
git clone https://github.com/SanyamWadhwa07/minimi-chat-agent
cd minimi-chat-agent
npm install
npm test            # no keys needed
npm run typecheck
cp .env.example .env && npm run dev
npm run eval        # live: uses about 35 searches and model calls
```

## Pull requests

Keep them focused, describe how you tested, and add an entry under "Unreleased" in `CHANGELOG.md`.
