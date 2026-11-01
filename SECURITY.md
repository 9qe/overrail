# Security Policy

## Supported versions

| version | supported |
|---|---|
| 0.4.x | yes |
| 0.3.x | security fixes on request |
| < 0.3 | no |

## Reporting a vulnerability

Use GitHub Security Advisories (Security tab -> Report a vulnerability) for a private report. If you do not have GitHub access for that, contact the maintainer through GitHub. Please do not open a public issue for a security report.

## Scope

- The local gateway (`overrail serve`), both dialects: `/v1/chat/completions` and `/v1/messages`
- Environment-variable handling (profile env resolution and injection)
- Failover and mid-stream recovery
- The recovery journal (`~/.overrail/recovery.jsonl`)

## Design stance

- The gateway binds to `127.0.0.1` only. It never listens on a network interface.
- API keys are read from environment variables and are never written to disk by the tool. `~/.overrail/usage.jsonl` contains token counts, provider name, model, and a timestamp — no keys, no prompts, no request bodies.
- The recovery journal is allowlisted metadata only: recovery id, request hash, tool-call id, function name, a SHA-256 of the arguments, phase, provider and timestamp. Prompts, tool arguments and generation-parameter values are filtered out before the write, and a test asserts the file bytes contain none of them.
- Request bodies are bounded (`OVERRAIL_MAX_BODY_BYTES`, default 32 MiB) and rejected with HTTP 413 before they can exhaust memory; the ack route is capped at 64 KiB.
- There is no telemetry.

## Local trust model — read this before assuming the gateway is a security boundary

- **No authentication, no TLS, no per-process identity.** Any process that can open a loopback connection to `127.0.0.1:8787` can send completions to your providers, spend your quota, and read `GET /v1/models`.
- **Recovery acknowledgements are assertions, not proofs.** `POST /v1/recovery/:id/ack` trusts whatever `tool_call_id` a caller presents with that key. A local process that can reach the gateway can forge an acknowledgement and make the gateway believe a tool ran. There is no shared secret per session; the idempotency key is itself the only capability, so treat it as a secret if you generate one.
- **The journal is only as private as your home directory.** Anyone who can read `~/.overrail/recovery.jsonl` sees which tools ran, when, and against which provider. `OVERRAIL_RECOVERY_DIR` does not add encryption.
- **Loopback is not isolation.** A sandboxed or low-trust process on the same machine is inside this trust boundary by default. Do not run the gateway on a shared or multi-tenant host, and stop it (`Ctrl-C`) when you are not using it.

This is deliberate for a single-user developer tool, not an oversight — but it is a real limitation, and overrail is not a permission boundary between programs on your machine.
