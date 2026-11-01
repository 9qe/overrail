# Provider Compatibility Matrix

Evidence about **real providers** (DeepSeek, Moonshot/Kimi, OpenRouter, Ollama) flowing through the
actual gateway. This is the only artifact in the repo that proves provider compatibility — everything
under `test/` and the recovery benchmark run against local fake upstreams.

> **Important:** passing local chaos/stream tests does **not** prove provider compatibility.
> The fake upstreams implement *our* reading of the OpenAI SSE contract. Real providers deviate:
> usage chunks with empty `choices`, `data:{...}` without a space after the colon, multi-line data
> frames, mid-codepoint flushes for CJK/emoji output, provider-specific rate-limit and billing
> error shapes. Those deviations can only be caught against the live APIs, which is what this
> runner does — opt-in and paid.

## Running it

```bash
# nothing is sent to any paid API unless you put a real key in the environment
DEEPSEEK_API_KEY=sk-...        node examples/live-provider-matrix.js
MOONSHOT_API_KEY=sk-...        node examples/live-provider-matrix.js --providers kimi
OPENROUTER_API_KEY=sk-or-...   node examples/live-provider-matrix.js --providers openrouter
                               node examples/live-provider-matrix.js --providers ollama   # local, no key
```

| Knob | Meaning |
|---|---|
| `--providers deepseek,kimi,openrouter,ollama` | subset to run (default: all four) |
| `--out <path>` | report location, default `docs/provider-matrix-results.json` |
| `OVERRAIL_MATRIX_<PROVIDER>_MODEL` | override the default model, e.g. `OVERRAIL_MATRIX_KIMI=kimi-k2-0711-preview` (sent as `profile/model` through the gateway) |
| `OVERRAIL_MATRIX_RATELIMIT=1` | opt into the burst case (10 parallel requests — spends quota, off by default) |

Keys are read **only** from `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `OPENROUTER_API_KEY` (Ollama needs
none). They are placed only in `Authorization` headers and every string that reaches the console or
the JSON report passes through a scrubber that redacts key values, `sk-...` tokens and `Bearer ...`
sequences. The report records the *name* of the env var and a boolean `key_present` — never a value.

## Matrix cases and pass criteria

All LLM cases go through a real in-process `createGateway()` bound to 127.0.0.1 with a single-provider
failover chain, so what is measured is the gateway's actual forwarding path, not a re-implementation.

| Case | What it does | PASS means |
|---|---|---|
| `models-probe` | `GET <baseUrl>/models` with the key | HTTP 2xx, model count recorded |
| `non-stream` | tiny chat request through the gateway | 200 JSON with non-empty completion; usage object captured |
| `stream` | `stream: true` through the gateway | ≥1 content delta, **exactly one** `[DONE]`, zero unparsable data events |
| `tool-call` | function-calling request, streaming | `get_weather` tool call emitted and the stream contract holds |
| `malformed-upstream` | — | always **SKIP**: malformed SSE cannot be injected at a real provider; covered locally by `test/edge-stream.test.js` |
| `rate-limit` | 10-request parallel burst (opt-in) | observed status histogram recorded; without `OVERRAIL_MATRIX_RATELIMIT=1` it is `SKIP (opt-in-only)` |
| `long-context` | ~10–12k-token prompt, 16-token answer | prompt accepted, non-empty answer |
| `usage-reconcile` | compares the provider's usage object with the gateway's `usage.jsonl` entry | identical `prompt_tokens`/`completion_tokens`, correct provider/model evidence |

## Result statuses

`PASS` · `FAIL` (with classification: `auth-rejected`, `model-not-found`, `rate-limited-unexpectedly`,
`upstream-http-50x`, `gateway-chain-exhausted`, `non-json-body`, `token-mismatch`, `client-timeout`, …)
· `SKIP-MISSING-KEY` · `SKIP-UNFUNDED` (HTTP 402 or billing/quota/credit language in the provider error)
· `SKIP-UNREACHABLE` (connection refused/DNS/timeout before any provider verdict).

Because a single-provider chain makes the gateway wrap every dead upstream as `502 all providers failed`,
the runner unwraps the inner provider status from the attempt details before classifying
(e.g. `auth-rejected (gateway-wrapped 401)`).

## Current state (2026-11-01) — BLOCKED, no live evidence

Last run on the bench machine (Windows 11, Node v24.11.0), recorded in `docs/provider-matrix-results.json`:

- `deepseek`, `kimi`, `openrouter`: **SKIP-MISSING-KEY** for every case — no keys in the environment, no network traffic sent.
- `ollama`: **SKIP-UNREACHABLE** — Ollama is not installed on this machine and nothing is listening on `localhost:11434`.
- Summary: `pass: 0, fail: 0, skipped: 32, evidence_valid: false`; the runner exits **2** with
  `BLOCKED: no funded+reachable provider completed the core case`.

The runner was smoke-tested against the live network with an intentionally **fake** DeepSeek key:
`models-probe` and `non-stream` correctly classified as `auth-rejected` / `auth-rejected
(gateway-wrapped 401)`, and the key value was confirmed absent from all output. That proves the
classification path works — it is **not** compatibility evidence.

**No PASS row on this matrix is real yet.** Until someone runs it with funded keys against live
providers, provider compatibility remains unproven. Do not cite this matrix in launch material
while `evidence_valid` is `false`; the runner deliberately fails the command (exit 2) in that state
so a fake-green matrix cannot slip into docs.

### What a full pass looks like

For each funded provider: all eight cases `PASS` (or the documented SKIPs), `usage-reconcile`
showing exact token agreement, and stream/tool cases confirming the one-`[DONE]` contract survives
the provider's real framing. Two relay defects found locally — multi-line `data:` re-framing and
mid-codepoint chunk splits — are fixed and covered by `test/edge-stream.test.js`; the live matrix
still has to confirm the same paths against each provider's real byte boundaries.
