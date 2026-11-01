# overrail

**Your AI tool dies when the provider fails. overrail keeps it alive — even mid-answer.**

<p align="center">
  <img src="docs/banner.svg" alt="overrail banner" width="880">
</p>

Free and open source (MIT). Runs entirely on your computer. v0.3.0.

## What it does, in plain English

1. You use an AI coding tool (like Claude Code) with one AI provider (like DeepSeek).
2. Sometimes that provider rate-limits you, or its connection just drops. Your tool freezes or errors out — often halfway through an answer you already paid for.
3. overrail sits in between. When the provider fails, it quietly switches to a backup. If the answer was half-finished, the backup picks up exactly where it stopped. You see one uninterrupted answer.

Your API keys stay on your computer. Requests go straight from you to the provider — nowhere else.

## Try it in 1 minute (no account, no API key)

<p align="center">
  <img src="docs/chaos-demo.svg" alt="terminal recording: provider dies mid-sentence, backup finishes it" width="880">
</p>

You need [Node.js](https://nodejs.org) installed. Open PowerShell (Windows) or Terminal (Mac/Linux) and paste these three lines:

```bash
git clone https://github.com/9qe/overrail.git
cd overrail
node examples/chaos-demo.js
```

What you'll see: the first provider "dies" after three words, a backup finishes the sentence, and your side never shows an error:

```
client <- "The"
client <- " quick"
client <- " brown"        <- first provider dies here
client <- " fox"          <- backup provider takes over, same answer
client <- " jumps"
client <- " over the lazy dog."
client <- [DONE]
```

That's the whole idea. Everything below is about using it with real providers.

## Use it with your own AI provider

Three steps. DeepSeek is the example here; Kimi, OpenRouter, and Ollama work the same way.

**Step 1 — get an API key.** Sign up at https://platform.deepseek.com and create a key. An API key is just a password that lets apps use your account.

**Step 2 — set up overrail.** Open PowerShell and run:

```powershell
npx overrail init
$env:DEEPSEEK_API_KEY = "paste-your-key-here"
```

On Mac/Linux (bash), the second line is: `export DEEPSEEK_API_KEY="paste-your-key-here"`

**Step 3 — start your tool through overrail:**

```powershell
overrail run deepseek -- claude
```

That's Claude Code running on DeepSeek instead of Anthropic. `overrail run` points Claude Code straight at DeepSeek's Anthropic-compatible endpoint — it's provider switching, and it does not go through the gateway. For automatic failover and mid-stream stitching, use the gateway below with tools that speak OpenAI's API (aider, Codex, curl).

*If Windows says `overrail` is not recognized, run `npm i -g overrail` once, or prefix commands with `npx overrail`.*

---

## For developers

**Kill an LLM provider mid-sentence. Your agent keeps streaming.**

Zero-dependency Node.js CLI (CommonJS, Node >= 18), Windows-first. Install: `npm i -g overrail` or `npx overrail init`.

### Why not LiteLLM, OpenRouter, or another proxy

- **No cloud middleman.** Keys stay in your environment; requests go from your machine straight to the provider. Nothing phones home.
- **No dependency tree.** Zero dependencies, CommonJS, small enough to audit in one sitting. No Python, no Docker, no SDK.
- **Mid-stream stitching, not just retries.** Most routers retry requests that fail before the first token. overrail also catches a severed SSE socket mid-generation and stitches the remainder via assistant prefill, including tool calls, so a 400-line file at token 300 doesn't die at token 300 and you don't pay twice for the tokens you already received.

### Chaos testing against real providers

Set `OVERRAIL_CHAOS=529` (primary returns overloaded) or `OVERRAIL_CHAOS=midstream_drop@100` (primary's socket dies after 100 content events) and run any request through `overrail serve`. `node examples/chaos-demo.js` runs the same demo against local mock upstreams, no keys needed.

## Gateway

`overrail serve` starts a local OpenAI-compatible gateway at http://127.0.0.1:8787. It exposes `POST /v1/chat/completions` and `GET /v1/models`, and binds to 127.0.0.1 only.

It does **not** serve Anthropic's `/v1/messages` — don't point `claude` at it. Use `overrail run` for Claude Code (provider switching only); use the gateway for aider, Codex, and curl (failover and mid-stream stitching).

Point your tools at it:

```
 aider   codex   curl   continue
   \       |      |       /
    \      |      |      /
     +-----+------+-----+
             |
             v
      overrail serve
    http://127.0.0.1:8787
             |
             v
  deepseek -> kimi -> openrouter -> ollama
     (automatic failover)
```

Test it with curl:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek","messages":[{"role":"user","content":"What is 2+2?"}]}'
```

If a provider returns 429, 500, 502, 503, or 504, or the connection fails, the gateway moves to the next profile in the chain. Default chain: `deepseek -> kimi -> openrouter -> ollama`. Local chain: `ollama`. The `model` field in gateway calls takes `<profile>` (for example `deepseek`) or `<profile>/<model>`.

## Built-in profiles

| profile | base URL | env var | note |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | first in the default failover chain |
| `kimi` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | second in the default failover chain |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | hundreds of models |
| `ollama` | `http://localhost:11434/v1` | none | local, no key |

## Commands

| command | description |
|---|---|
| `overrail init` | set up profiles and configuration |
| `overrail list` | list profiles |
| `overrail use <name>` | set the active profile |
| `overrail current` | show the active profile |
| `overrail env <name>` | print the environment variables a profile would inject |
| `overrail run [name] -- <cmd...>` | run a command with the profile's environment injected |
| `overrail serve [--port N]` | start the local gateway (default port 8787) |
| `overrail usage` | view usage logged in `~/.overrail/usage.jsonl` |
| `overrail chains` | show failover chains |
| `overrail help` | show help |

## How it works

- **Env injection.** `overrail run deepseek -- claude` launches Claude Code pointed at DeepSeek using your own `DEEPSEEK_API_KEY`. Your workflow does not change; the model under it does.
- **Local gateway.** `overrail serve` runs an OpenAI-compatible endpoint (`POST /v1/chat/completions`, `GET /v1/models`) on http://127.0.0.1:8787, bound to 127.0.0.1 only.
- **Failover.** When a provider returns 429, 500, 502, 503, 504, or 529, or the network errors out, the gateway moves to the next profile in the chain. Default: `deepseek -> kimi -> openrouter -> ollama`. Local: `ollama`.
- **Mid-stream failover.** If the upstream socket dies mid-response, the gateway replays your messages plus the partial reply as an assistant prefill (DeepSeek: `prefix: true` on its beta endpoint; providers that reject a trailing assistant message get a constrained continue prompt instead). The client sees one continuous response, a single `[DONE]`, and merged token usage.
- **Tool-call recovery.** Tool-call arguments are buffered until the JSON is complete, with SSE keep-alives during long calls. Because partial calls never reach the client, a drop mid-tool-call just discards the buffer and regenerates the call on the backup provider. Calls that already completed are passed to the backup as finished history, so they're never generated twice.
- **Chaos testing.** Set `OVERRAIL_CHAOS=529` to make the first upstream attempt return 529, or `OVERRAIL_CHAOS=midstream_drop@100` to kill the primary stream after 100 content events. Reproduce a failover on your own machine in 30 seconds, no real outage required.
- **Usage log.** Gateway requests are appended to `~/.overrail/usage.jsonl` (provider, model, and token counts; streaming responses are logged when the upstream reports usage). Run `overrail usage` to view it.

### Design

- Zero dependencies. CommonJS. Requires Node >= 18.
- Windows-first.
- No telemetry. No proxy-to-cloud. Nothing runs in the background when you close the terminal.
- Keys never leave your machine — requests go from your machine straight to the provider.

## Roadmap

Planned for vNext, in no particular order:

- Windows tray app
- Cost estimates with an editable price table
- Smart task-based model routing
- Profile support for more agents

## Support

overrail is free and MIT-licensed, and the core stays that way. If it saves you a mid-task provider migration, sponsor the work at https://github.com/sponsors/9qe.

## License

MIT. See [LICENSE](LICENSE).
