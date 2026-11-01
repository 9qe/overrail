# overrail launch kit

Everything needed to announce v0.4.0. Record the GIF first, then post. Repo: https://github.com/9qe/overrail

## Show HN

Title:

Show HN: Overrail – Local LLM gateway that stitches severed SSE streams mid-generation

Post body:

Local proxies retry on 429s. But when a provider's socket dies 45 seconds into a 400-line file, most routers kill the stream and you lose the tokens you paid for.

overrail is a zero-dependency Node.js gateway (MIT, `npx overrail init`) that catches a severed SSE socket mid-generation and continues on the next provider. The partial reply goes back as an assistant prefill (DeepSeek: `prefix: true` on its beta endpoint; providers that reject a trailing assistant message get a constrained continue prompt). Tool calls are buffered until their JSON completes, so a drop mid-tool-call just discards the buffer and regenerates the call on the backup. Completed calls are passed as finished history, never generated twice. The client sees one continuous stream, one [DONE], and merged token usage.

Try it without keys: clone the repo and run `node examples/chaos-demo.js`. Against real providers: `OVERRAIL_CHAOS=midstream_drop@100`.

Scope, honestly: all of the above is verified against local mock upstreams (82 tests, plus a benchmark that kills an 8,000-delta stream at delta 4,000 and 7,900 and reassembles byte-identical output with a 16-34 ms client-visible stall). v0.4.0 also serves Anthropic `/v1/messages`, so Claude Code can sit behind the gateway and get failover too, and there is an opt-in durable recovery journal (`Idempotency-Key` + `POST /v1/recovery/:id/ack`, metadata only — never prompts or tool arguments). What we have NOT done: a funded live-provider matrix. `examples/live-provider-matrix.js` exists and reports 32/32 skipped with `evidence_valid: false` on this bench. We are not claiming provider compatibility until that file shows PASS rows. Keys never leave localhost. No telemetry. Gateway binds to 127.0.0.1.

Etiquette:

- Post Tuesday to Thursday, 8–10am ET.
- Stay in the thread all day and reply to questions as they come.
- Answer criticism directly. If someone finds a real bug, say so.
- Ship fixes live during the thread — push to GitHub and say what changed.
- No marketing speak. Describe what it does and what it does not.

## Reddit — r/LocalLLaMA

Title:

overrail — a zero-dependency CLI that puts a local OpenAI-compatible gateway in front of ollama for your coding agents (no API key, everything on 127.0.0.1, MIT)

Body:

If you run ollama, overrail gives your coding agents one endpoint to talk to: a local OpenAI-compatible gateway on http://127.0.0.1:8787, with an ollama profile (http://localhost:11434/v1, no API key). The local chain is just `ollama`. When you do want a hosted model, the default failover chain is deepseek -> kimi -> openrouter -> ollama.

What it is: a zero-dependency Node.js CLI, MIT, Windows-first. `overrail serve` starts the gateway (POST /v1/chat/completions, GET /v1/models). The `model` field takes `ollama` or `ollama/<model>`. `overrail run <profile> -- claude` injects the profile's environment and launches Claude Code on it. Usage is logged to ~/.overrail/usage.jsonl (`overrail usage`).

Privacy: the gateway binds 127.0.0.1 only, there is no telemetry, and with the ollama profile requests never leave your machine. Hosted-profile keys stay on your machine too.

Honest scope: v0.4.0 — CLI, gateway (OpenAI `/v1/chat/completions` + Anthropic `/v1/messages`), failover, mid-stream stitching, usage log. No tray app yet, no funded live-provider matrix yet. Install: `npx overrail init`. Repo: https://github.com/9qe/overrail

## X / Twitter thread

Three posts, each under 280 characters.

Post 1:

overrail run deepseek -- claude

Claude Code, running on DeepSeek, on your own API key.
One command. No env-var surgery.

MIT, zero dependencies, Node >= 18.
https://github.com/9qe/overrail

Post 2:

overrail serve

A local OpenAI-compatible gateway on 127.0.0.1:8787. Point curl, aider, or codex at it.

If deepseek rate-limits or drops, it fails over automatically: deepseek -> kimi -> openrouter -> ollama.

Post 3:

Requests are logged to ~/.overrail/usage.jsonl. Run overrail usage to see the table.

Keys never leave your machine. No telemetry. Nothing runs in the background.

v0.4.0 — try it: npx overrail init

## GIF to record

One GIF, six shots, in this order:

- [ ] `npx overrail init` — show setup completing
- [ ] env: set `DEEPSEEK_API_KEY`, then run `overrail env deepseek` to show what gets injected
- [ ] `overrail run deepseek -- claude` — Claude Code starts pointed at DeepSeek
- [ ] Type a prompt; show Claude answering on DeepSeek
- [ ] `overrail serve`, then hit http://127.0.0.1:8787/v1/chat/completions with the curl from the README
- [ ] `overrail usage` — show the usage table rows from this session

Tools: vhs (write a .tape file, get a GIF) or asciinema (record the session, render to GIF with agg).

Record once, reuse it in the HN post, the Reddit post, and the thread.
