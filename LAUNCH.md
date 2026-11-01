# agentrouter launch kit

Everything needed to announce v0.1.0. Record the GIF first, then post. Repo: https://github.com/9qe/agentrouter

## Show HN

Candidate titles:

1. Show HN: Agentrouter — run Claude Code on DeepSeek with automatic failover
2. Show HN: Agentrouter — swap the model under any coding agent, with failover
3. Show HN: Agentrouter — a local OpenAI-compatible gateway with provider failover

Post body:

agentrouter is a zero-dependency Node.js CLI (MIT, Windows-first, Node >= 18) that does two things. First, env injection: `agentrouter run deepseek -- claude` launches Claude Code pointed at DeepSeek using your own DEEPSEEK_API_KEY — no config surgery, no exporting env vars by hand. Second, a local gateway: `agentrouter serve` starts an OpenAI-compatible endpoint at http://127.0.0.1:8787 (POST /v1/chat/completions, GET /v1/models). If a provider returns 429, 500, 502, 503, or 504, or the connection drops, the gateway fails over down the chain: deepseek -> kimi -> openrouter -> ollama. Gateway requests are logged to ~/.agentrouter/usage.jsonl, viewable with `agentrouter usage`.

Built because agent CLIs are wired to one vendor, and switching mid-task means env-var archaeology and lost work. A rate limit should not end a coding session. Honest about v0.1.0 scope: env injection, the gateway, failover chains, and the usage log all work today. No tray app yet, no cost estimates, no smart routing — that is the roadmap. Not on npm yet, so install is `npx github:9qe/agentrouter init`. Keys never leave your machine, there is no telemetry, and the gateway binds to 127.0.0.1 only.

Etiquette:

- Post Tuesday to Thursday, 8–10am ET.
- Stay in the thread all day and reply to questions as they come.
- Answer criticism directly. If someone finds a real bug, say so.
- Ship fixes live during the thread — push to GitHub and say what changed.
- No marketing speak. Describe what it does and what it does not.

## Reddit — r/LocalLLaMA

Title:

agentrouter — a zero-dependency CLI that puts a local OpenAI-compatible gateway in front of ollama for your coding agents (no API key, everything on 127.0.0.1, MIT)

Body:

If you run ollama, agentrouter gives your coding agents one endpoint to talk to: a local OpenAI-compatible gateway on http://127.0.0.1:8787, with an ollama profile (http://localhost:11434/v1, no API key). The local chain is just `ollama`. When you do want a hosted model, the default failover chain is deepseek -> kimi -> openrouter -> ollama.

What it is: a zero-dependency Node.js CLI, MIT, Windows-first. `agentrouter serve` starts the gateway (POST /v1/chat/completions, GET /v1/models). The `model` field takes `ollama` or `ollama/<model>`. `agentrouter run <profile> -- claude` injects the profile's environment and launches Claude Code on it. Usage is logged to ~/.agentrouter/usage.jsonl (`agentrouter usage`).

Privacy: the gateway binds 127.0.0.1 only, there is no telemetry, and with the ollama profile requests never leave your machine. Hosted-profile keys stay on your machine too.

Honest scope: v0.1.0 — CLI, gateway, failover, usage log. No tray app yet. Not on npm: `npx github:9qe/agentrouter init`. Repo: https://github.com/9qe/agentrouter

## X / Twitter thread

Three posts, each under 280 characters.

Post 1:

agentrouter run deepseek -- claude

Claude Code, running on DeepSeek, on your own API key.
One command. No env-var surgery.

MIT, zero dependencies, Node >= 18.
https://github.com/9qe/agentrouter

Post 2:

agentrouter serve

A local OpenAI-compatible gateway on 127.0.0.1:8787. Point curl, aider, or codex at it.

If deepseek rate-limits or drops, it fails over automatically: deepseek -> kimi -> openrouter -> ollama.

Post 3:

Requests are logged to ~/.agentrouter/usage.jsonl. Run agentrouter usage to see the table.

Keys never leave your machine. No telemetry. Nothing runs in the background.

v0.1.0 — try it: npx github:9qe/agentrouter init

## GIF to record

One GIF, six shots, in this order:

- [ ] `npx github:9qe/agentrouter init` — show setup completing
- [ ] env: set `DEEPSEEK_API_KEY`, then run `agentrouter env deepseek` to show what gets injected
- [ ] `agentrouter run deepseek -- claude` — Claude Code starts pointed at DeepSeek
- [ ] Type a prompt; show Claude answering on DeepSeek
- [ ] `agentrouter serve`, then hit http://127.0.0.1:8787/v1/chat/completions with the curl from the README
- [ ] `agentrouter usage` — show the usage table rows from this session

Tools: vhs (write a .tape file, get a GIF) or asciinema (record the session, render to GIF with agg).

Record once, reuse it in the HN post, the Reddit post, and the thread.
