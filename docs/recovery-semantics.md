# Recovery semantics

`lib/recovery.js` — what the gateway can prove about mid-stream tool calls, and what it can never prove.
This document is a boundary spec, not a feature page. Where a guarantee does not exist, it says so.

## 0. Short version

| Claim | Verdict |
| --- | --- |
| A partially-streamed tool-call buffer never reaches the client. | **Guaranteed** by the relay (arguments are held until the JSON parses). |
| An undelivered call can be discarded and regenerated on the backup. | **Guaranteed.** The client never saw those bytes, so regeneration cannot duplicate anything the client acted on. |
| The gateway can record exactly what it emitted. | **Yes** — append-only journal, metadata only. |
| The gateway can accept "I executed this" from a cooperating client. | **Yes** — `POST /v1/recovery/:id/ack`, idempotent. |
| Tool side effects run exactly once, end to end. | **No.** Not achievable from a proxy. See §3. |
| A delivered-but-unacknowledged call can be stitched into "probably fine". | **No.** That state is exposed as `execution_unknown`, never hidden. |
| Only one provider is billed when a stream is stitched. | **No.** Both legs bill their own partial output. See §8. |
| The backup provider continues with primary-equivalent semantics. | **Best-effort only.** See §9. |

## 1. The two facts the journal can establish

There are exactly two independently observable events, and they happen in different processes:

1. **Emission** — the gateway forwarded a complete tool call to the client. Observable here, so recordable here (`phase: "offered"`).
2. **Execution** — the client invoked the tool. Not observable here. Only ever a *claim* the client makes (`phase: "acknowledged"`), stored as "client asserted at time T", never as "side effect happened".

Anything stronger than those two statements is a client-behaviour assumption, not a gateway guarantee. `lib/recovery.js` never upgrades an emission into an execution: no code path in it writes `acknowledged` without an explicit ack call.

## 2. What overrail does guarantee

* **Buffer gating.** `lib/stream-relay.js` (`flush_tools`, `update_heartbeat`) holds every `delta.tool_calls` chunk until all in-flight calls' `arguments` parse as JSON. Until then the only thing on the wire to the client is an SSE keep-alive comment. A malformed half-call cannot be executed by a client because it cannot be seen by a client.
* **Discard-on-drop.** When the upstream socket dies, `relay_stream` clears `state.tools` and `state.tool_chunks` before switching legs. Unflushed buffers are dropped, never forwarded late.
* **Single emission per logical call.** Completed calls are replayed to the backup as finished history, so the backup regenerates only the missing calls. The existing suite asserts the call id appears exactly once in the client-visible stream (`test/midstream.test.js`).
* **Deterministic identity.** The same request always maps to the same `recovery_id`, so a retry lands on one journal session instead of forking a new one.
* **Metadata-only persistence.** Argument payloads and prompt text never reach the journal (§5).

## 3. What overrail cannot guarantee, and why

**Exactly-once external tool execution is not achievable from this position.** The reasons are structural, not implementation gaps:

* After bytes are delivered, execution happens in the client process. The gateway has no handle on it: no return path, no transaction, no ability to roll a file write or an email back.
* Any transport ack the gateway does have (TCP, SSE flush success) proves only that the kernel accepted the bytes. A client that crashes one line later, or parses the event and then dies before running the tool, produces a "delivered" that is not an "executed".
* A non-cooperating client never calls `/ack`. For that client, `acknowledged` is unreachable and every delivered call stays `execution_unknown` forever. There is no inference that closes this. Guessing "delivered implies executed" is exactly the false claim this module exists to avoid.
* A retry of the *client's* HTTP request can re-execute a tool even with a perfect journal, because the decision to execute is downstream of the gateway. The recovery id lets a well-behaved client dedupe; it cannot make a careless one dedupe.

So the honest contract is: **at-most-once emission from the gateway, exactly-once execution only if the client cooperates by acknowledging and by checking the journal before re-running.** Clients that want stronger guarantees need one of: a client-side executor keyed on `recovery_id` + `tool_call_id`, a tool layer that is itself idempotent, or provider-side tool execution (the tool runs inside the provider's transaction, out of reach of this stitching path entirely).

## 4. Lifecycle

```
generated ──► offered ──► acknowledged              (delivered, client confirmed execution)
    │            │
    │            └─────► abandoned                  (given up on; execution still unknown)
    └─────────────────► abandoned                   (never delivered; safe to regenerate)
```

| Phase | Meaning | Who writes it |
| --- | --- | --- |
| `generated` | The call was assembled in gateway memory but never forwarded. Client cannot have acted on it. | gateway |
| `offered` | The completed call was forwarded to the client. | gateway |
| `acknowledged` | The client asserts it executed this call. | client, via `POST /v1/recovery/:id/ack` |
| `abandoned` | The gateway stopped waiting on this call. | gateway |

`acknowledged` is absorbing: once present, no later `offered` or `abandoned` record can move the call off it. A racing `abandoned` after an ack is kept in the journal (append-only, never rewritten) and surfaces as `conflict: "acknowledged_wins_over_abandon"`.

Transitions the module refuses, as data rather than exceptions:

* ack of an unknown `recovery_id` → `unknown_recovery_id`.
* ack of a `recovery_id` with no such `tool_call_id` → `unknown_tool_call_id`.
* second ack of the same call → `replay: true`, **one** acknowledged line on disk.
* re-recording `generated`/`offered` for an already-acked call → `conflict: "already_executed"`, nothing written. This is the duplicate-side-effect alarm, not a bug to silence.
* ack after `abandoned` → accepted (the client really may have run it), returns `was: "abandoned"`, `conflict: "duplicate_side_effect_risk"`.
* re-opening a header-derived session with a different request body → `idempotency_key_conflict`; the two requests are never merged.

## 5. The journal

Path: `~/.overrail/recovery.jsonl` (same `CONFIG_DIR` convention as `usage.jsonl`, `lib/config.js`). Override with `OVERRAIL_RECOVERY_DIR` for tests or an alternate volume.

Append-only JSONL, one record per line:

```json
{"v":1,"recovery_id":"…","request_hash":"…","tool_call_id":"call_1","function":"write","args_sha256":"…","phase":"offered","profile":"deepseek","provider":"kimi","ts":"2026-11-03T…Z"}
```

Stored: `recovery_id`, `request_hash`, `tool_call_id`, function **name**, `args_sha256`, `phase`, requested `profile`, serving `provider`, `model`, key `source`, `ts`.

Never stored, enforced by an allowlist plus a strings-only filter in `metadata_only()`: tool arguments, message content, system prompts, file bodies, headers, API keys, the raw idempotency key (only its SHA-256 becomes the id). Argument *identity* survives as `args_sha256` (normalised JSON, so key order and whitespace do not fork it) — enough to detect "same call id, different arguments" without persisting the arguments.

Because arguments are not persisted, a continuation built from disk cannot quote them. `continuation_history()` puts a valid-JSON sentinel in the assistant history instead of inventing content:

```json
{"_overrail_recovery":"arguments_not_persisted","args_sha256":"…"}
```

The relay still holds the real arguments in memory during a stitch; pass them through `known_arguments` and the sentinel is not used.

Durability limits, stated plainly: writes are single small `appendFileSync` lines (no `fsync`, no directory sync, no file locking). A power loss can lose or tear the tail line; `read_journal()` skips unparseable lines the same way `readUsage()` does, so a torn tail costs one record, not the session. There is no rotation or compaction — trim the file yourself if it grows.

## 6. Recovery identity

`derive_recovery_key(request)` returns `{ recovery_id, request_hash, source }`.

1. If an `Idempotency-Key` or `OVERRAIL-RECOVERY-KEY` header is present and non-blank (case-insensitive; `Idempotency-Key` wins), `recovery_id = sha256("overrail-recovery-key:v1\n" + value)` and `source: "header"`.
2. Otherwise `recovery_id = request_hash` and `source: "derived"`, where
   `request_hash = sha256("overrail-request:v1\n" + canonical(normalised request))`.

Normalisation is the identity: endpoint (query and trailing slashes stripped), profile name, model, messages, tool definitions, tool-result context. Object keys sorted, `null` treated as absent, tool `arguments` canonicalised through a JSON round trip, tool-call `index` dropped (stream framing, array order carries position), tool **order kept** (it is model-visible), unrecognised message/body fields ignored — so `temperature`, `stream`, per-attempt request ids, and header noise never change the identity, and a client that re-serialises the same logical request gets the same id.

The identity is deliberately not a fingerprint of everything: it is a fingerprint of the things whose difference would change what the tools should do.

## 7. Ack protocol

```
POST /v1/recovery/:recovery_id/ack
content-type: application/json
{ "tool_call_id": "call_1", "provider": "kimi" }   // provider optional, echoed only
```

| Outcome | HTTP | Body |
| --- | --- | --- |
| first ack | 200 | `{ object, recovery_id, tool_call_id, status: "acknowledged", replay: false, executed_once_claim }` |
| duplicate ack | 200 | same, `replay: true` — **not** an error; a client retrying its ack must succeed |
| ack after abandon | 200 | adds `was: "abandoned"`, `conflict: "duplicate_side_effect_risk"` |
| unknown recovery id | 404 | `{ error: { code: "unknown_recovery_id" } }` |
| unknown tool call id | 404 | `{ error: { code: "unknown_tool_call_id" } }` |
| bad id in URL, non-JSON body, missing/empty `tool_call_id` | 400 | `{ error: { code: "invalid_recovery_id" \| "invalid_json" \| "missing_tool_call_id" } }` |
| any method but POST | 405 | `{ error: { code: "method_not_allowed" } }`, `allow: POST` |

`handle_recovery_ack` never throws; every failure is a JSON status, and the response carries `executed_once_claim: "client-asserted only; the gateway cannot observe execution"` so nothing downstream can mistake a stored ack for observed fact. Body is capped at 64 KiB. Loopback-only posture unchanged: the gateway binds `127.0.0.1`, so this route is reachable only from the local client.

## 8. Billing

Stitching is a second model request. Both providers bill what they generated:

* The leg that died is billed for the partial output it produced before the socket closed. Nothing in this module refunds or prevents that.
* The backup leg is billed for the continuation, including the prefill/history tokens it was charged as prompt input.
* `lib/usage.js` records the merged `usage` the client sees, which sums the legs' reported token counts. That is a client-facing number, not a statement about what either provider invoiced.

So "you don't pay twice for the tokens you already received" holds only in the narrow sense that received content is not re-requested. Partial output already streamed is paid for, and the continuation is paid for again on top. Recovery metadata adds no token cost; journal writes add disk and one small append per phase transition.

## 9. Cross-provider continuation is best-effort

The backup is a different model with different conditioning. Expect, and do not paper over:

* **Different completions.** The regenerated call may use a different id, argument shape, or split calls differently than the primary would have. The journal records what was actually emitted per leg, so `args_sha256` can legitimately change across records for the same `tool_call_id`.
* **Different prefill mechanics.** Assistant prefill is honoured as an explicit prefix only on DeepSeek's beta endpoint (`prefix: true`); providers that reject a trailing assistant message get a constrained "continue exactly from" user prompt instead. Continuation fidelity differs between those two paths.
* **Tool-history schema differences.** OpenAI-shaped `tool_calls` + `role: "tool"` is what the relay synthesises. A provider that wants a different tool-result envelope may reject it or ignore the "already handled" instruction and repeat the call.
* **Tool-choice and parallel-call behaviour** differ per model; a mid-call switch can change whether the remaining calls arrive at all.
* **Semantic drift.** Even with valid history, the backup model does not know what the primary was about to do. Stitching preserves the conversation; it does not preserve intent.

`continuation_history()` returns the three groups a correct client needs to reason about this, and labels each one:

| Field | Contents | Client obligation |
| --- | --- | --- |
| `executed` / `acknowledged` | acked calls | never re-run; already in assistant history with a "do not repeat" tool result |
| `execution_unknown` / `delivered_unacknowledged` | delivered, no ack | **unknown side-effect state.** Check the tool, or accept a possible duplicate. Do not assume either way. |
| `must_regenerate` / `generated_unacknowledged` | never delivered | safe to produce again; the client cannot have run these |

A provider failure after delivery can leave an execution result permanently unavailable. The protocol exposes that as `execution_unknown` with no inferred replacement value. Stitching the *text* is not stitching the *effect*, and this module never presents them as the same thing.

## 10. Gateway wiring (not yet applied)

`lib/recovery.js` is standalone; nothing imports it yet. Two edits make it live.

**Route** — in `lib/gateway.js`, `handle_request`, before the 404 fallback:

```js
const { match_recovery_ack, handle_recovery_ack } = require("./recovery");
// …
const ack = match_recovery_ack(url.pathname);
if (ack) return handle_recovery_ack(req, res, ack.recovery_id);
```

**Journal hooks** — `relay_stream` already holds the exact data needed; it needs `recovery_id` passed in from `handle_chat_completions` plus three calls:

```js
// handle_chat_completions, after `parsed` is validated:
const key = derive_recovery_key({
  headers: req.headers,                       // Idempotency-Key / OVERRAIL-RECOVERY-KEY win
  endpoint: "/v1/chat/completions",
  profile_name: requested_profile,
  model: parsed.model,
  messages: parsed.messages,
  tools: parsed.tools,
});
open_session({ ...key, profile: requested_profile, model: parsed.model });
// pass key.recovery_id into relay_stream
```

```js
// stream-relay.js, inside flush_tools(): collect exactly the calls flushed in this pass
const flushed = [];
for (const tool of state.tools.values()) {
  const call = { id: tool.id, type: "function", function: { name: tool.name, arguments: tool.args } };
  state.completed_tools.push(call);
  flushed.push(call);
}
// …after the forward loop, with the provider that produced them:
record_emitted_calls({ recovery_id, calls: flushed, phase: "offered", provider: state.winner.profile_name });

// stream-relay.js, on the drop path, just before state.tools.clear(): those buffers died
// unforwarded, so they are recorded as generated and regenerated on the next leg
record_emitted_calls({
  recovery_id,
  calls: [...state.tools.values()].filter((t) => t.id).map((t) => ({ id: t.id, function: { name: t.name, arguments: t.args } })),
  phase: "generated",
  provider: state.winner.profile_name,
});
```

Passing an already-recorded call again is harmless (deduped by phase + argument hash), but
recording only the newly flushed calls keeps a mid-stream ack from being misread as a
`already_executed` conflict on the next flush.

```js
// finish(): abandon whatever is still unacked
for (const tool_call_id of continuation_history(recovery_id).must_regenerate) abandon_call({ recovery_id, tool_call_id });
```

Surface `recovery_id` to the client on the first SSE response (e.g. an `x-overrail-recovery-id` header written in `ensure_headers`, or a commented SSE field) — without it, a cooperating client cannot address the ack route. Then echo it in `on_done`'s usage record so a session can be correlated after the fact.

The stitching path in `relay_stream` (`attempt_chain(parsed_body, history)`) should build `history` from `continuation_history(recovery_id, { known_arguments })` rather than the current hardcoded "already received by the client" string, so an acked call is never presented as unconfirmed and an unconfirmed one is never presented as done.

## 11. Tests

```
node --test test/recovery.test.js
```

Covers: key stability, normalisation (key order, whitespace, `null` vs absent, `index` dropped, tool order significant, non-semantic fields ignored), header precedence, argument-hash equivalence, journal location, metadata-only persistence (asserts secret prompt/argument tokens are absent from disk and every field is allowlisted), session idempotency and `idempotency_key_conflict`, phase dedupe, idempotent ack with exactly one execution record, unknown-id and malformed-input refusals without exceptions, abandon/ack races including a hand-injected conflicting journal line, torn-line tolerance, `OVERRAIL_RECOVERY_DIR`, continuation grouping plus the arguments sentinel and live-argument override, and the HTTP contract end to end through a server wired exactly as §10 describes.

## 12. Non-goals

No network replication, no cross-machine journal, no fsync-backed durability claim, no encrypted at-rest store (the file is metadata, but the home directory is the trust boundary), no automatic retry of tools, no provider-side transaction, and no claim of exactly-once execution anywhere in this document.
