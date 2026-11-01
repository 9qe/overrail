# Recovery Benchmark

Reproducible measurement of the gateway's mid-stream failover on a large (8,000-delta) response.
Everything runs locally against fake upstreams through the **real** `createGateway()` — no API keys,
no external network, CI-safe.

## Command

```bash
node examples/recovery-benchmark.js                        # 8000 deltas, drop after 4000
OVERRAIL_BENCH_DROP_AT=6500 node examples/recovery-benchmark.js
OVERRAIL_BENCH_TOTAL=500 OVERRAIL_BENCH_DROP_AT=100 node examples/recovery-benchmark.js
node examples/recovery-benchmark.js --out docs/benchmark-results.json   # machine-readable report
```

| Knob | Default | Meaning |
|---|---|---|
| `OVERRAIL_BENCH_DROP_AT` | `4000` | number of *forwarded content deltas* before the relay force-drops the primary leg (exported to the gateway as `OVERRAIL_CHAOS=midstream_drop@N`) |
| `OVERRAIL_BENCH_TOTAL` | `8000` | total deterministic content deltas in the scripted answer |
| `--out <path>` | — | also write the JSON report to a file |

Exit code is `0` only when every verification check passes; the JSON is printed between
`===JSON===` and EOF for piping into parsers.

## Methodology

1. **Primary** fake upstream streams 8,000 paced deltas (`w0 `, `w1 `, …, 500 per 1 ms tick) as
   OpenAI-style SSE through the gateway.
2. After `DROP_AT` deltas have been **forwarded to the client**, the relay force-drops the leg —
   the continuation path is the production code in `lib/stream-relay.js`: the accumulated content is
   sent to the **backup** as an assistant-prefill message; the backup *derives its start index from
   that prefill* (it parses the last prefill piece), streams the remaining deltas, then emits a
   two-fragment tool call (held by the relay until the arguments parse) and a finish chunk with usage,
   followed by `[DONE]`.
3. The client reads the gateway response with a streaming reader and a persistent `TextDecoder`,
   timestamping: first body byte, the last event at the stitch boundary and the first continuation
   event after it (the **client-observed failover gap**), and total completion. RSS is sampled every
   2 ms in-process (gateway + upstreams + client share the process).
4. Verification gates (all must hold): assembled content is **byte-identical** to the scripted
   8,000-piece answer; exactly one `[DONE]`; exactly one finish event; the tool-call id appears
   exactly once with valid JSON arguments; a merged usage event is present; zero unparsable events;
   8000/8000 content deltas delivered.

## Result (2026-11-01, Windows 11 x64, Node v24.11.0, integrated relay)

From `docs/benchmark-results.json` (exit 0, verification `pass: true`):

| Metric | Drop @4000 | Drop @7900 |
|---|---|---|
| First byte latency | 124 ms | 130 ms |
| Client-observed failover gap | 34 ms | 16 ms |
| Backup setup (primary first write → backup request) | 190 ms | 328 ms |
| Total stream time | 364 ms | 401 ms |
| Bytes received by client | 1,367,631 | 1,367,631 |
| Content deltas / chars | 8000 / 46,890 | 8000 / 46,890 |
| `[DONE]` markers | 1 | 1 |
| Finish events | 1 | 1 |
| Tool-call occurrences | 1 (args valid) | 1 (args valid) |
| Peak RSS (start ~51.4 MB) | 74.3 MB | 74.1 MB |

Evidence files: `docs/benchmark-results.json` (drop at 4000), `docs/benchmark-results-late-drop.json`
(drop at 7900 — a drop that lands almost at the end of the answer).

Verification: `exact_stitch, single_done, single_finish_event, tool_call_once, tool_args_valid,
usage_present, no_unparsed_events` — all `true` at both offsets. Repeat runs vary timing by a few
tens of ms; all content/`[DONE]`/stitch counts are identical.

## What this benchmark does **not** prove

- **No real provider.** The upstreams are local mocks that implement our reading of the SSE contract.
  Real-world 8k-token behavior — network jitter, TLS, provider keep-alive cadence, billing 429s —
  is out of scope. See `docs/provider-matrix.md`; live provider compatibility is currently BLOCKED.
- **In-process memory.** Gateway, upstreams and client share one Node process, so RSS deltas bound
  buffering behavior but not a production deployment's footprint.
- **The drop is synthetic.** `OVERRAIL_CHAOS=midstream_drop@N` throws inside the relay exactly at
  the forwarded-delta count; a real socket death can land mid-codepoint or mid-frame.

## Framing bugs found and fixed while building this

Two defects in `lib/stream-relay.js` were reproduced by this benchmark's test suite and are now
**fixed and covered by non-skipped tests** in `test/edge-stream.test.js`:

1. **Mid-codepoint chunk splits.** `sse_events()` decoded each network chunk with
   `chunk.toString("utf8")`, so a UTF-8 sequence flushed across two chunks (routine for CJK/emoji
   streams) produced U+FFFD pairs. Fix: one persistent `StringDecoder` per stream, flushed with
   `decoder.end()` on the tail.
2. **Multi-line `data:` framing.** The relay joined multi-line data frames for parsing but re-emitted
   them with a single `data: ` prefix, so strict SSE clients silently lost the chunk.
   Fix: `sse_frame()` re-prefixes every line on the way out.

## What a real 8k-token provider proof would include

To promote this from "local simulation passes" to "recovery proven in production":

1. Funded DeepSeek (or Kimi/OpenRouter) primary + a second funded provider as backup, run through
   `live-provider-matrix.js`-style gateway config.
2. A prompt eliciting ≥8,000 tokens of streamed output (long story/essay), with `stream_options:
   {"include_usage": true}` where supported.
3. A real kill at a random byte offset mid-stream — TCP-level abort of the upstream connection, not
   a relay-internal throw — ideally repeated across offsets (mid-codepoint, mid-JSON, mid-tool-args).
4. Assertions identical to the local gates: byte-exact assembled text vs a reference run, one
   `[DONE]`, one finish, tool call exactly once, usage reconciliation against the provider's own
   accounting, plus client-visible gap distribution across N recoveries.
5. Non-ASCII stress (CJK + emoji heavy generation) to exercise the split-codepoint path end-to-end.
6. Sanitized JSON evidence committed next to this file, with latency percentiles, not a single run.

Until items 3+6 exist over a funded key, recovery claims should be phrased as *local mid-stream
failover verified at 8k deltas; live 8k-token provider recovery pending*.
