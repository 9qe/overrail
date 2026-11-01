# Contributing

agentrouter is a zero-dependency Node.js CLI that swaps model providers under AI agent CLIs, with a local gateway and failover.

## Setup

- Node >= 18. No `npm install` needed — there are zero dependencies.
- Tests: `node --test`
- Try the CLI locally: `node bin/agentrouter.js help`

## Style

- CommonJS. No build step.
- No new dependencies without a written reason in the PR.
- No emoji in code or docs.
- No telemetry. This is a hard rule — nothing may phone home except requests the user's own agent sends to the provider the user configured.

## Pull requests

- Tests must pass (`node --test`).
- New commands need tests and a row in the Commands table in README.md.
- Keep the diff minimal. Docs must match actual behavior — if you change behavior, change the docs in the same PR.

## Good first issues

Open issues are on GitHub: https://github.com/9qe/agentrouter/issues
