# Security Policy

## Supported versions

| version | supported |
|---|---|
| 0.1.0 | yes |

## Reporting a vulnerability

Use GitHub Security Advisories (Security tab -> Report a vulnerability) for a private report. If you do not have GitHub access for that, contact the maintainer through GitHub. Please do not open a public issue for a security report.

## Scope

- The local gateway (`overrail serve`)
- Environment-variable handling (profile env resolution and injection)
- Failover logic

## Design stance

- The gateway binds to `127.0.0.1` only. It never listens on a network interface.
- API keys are read from environment variables and are never written to disk by the tool. `~/.overrail/usage.jsonl` contains token counts, provider name, model, and a timestamp — no keys, no prompts, no request bodies.
- There is no telemetry.

## Known limitation

The gateway performs no authentication on localhost. Anything running locally can call it, matching typical local development tools (Ollama, LM Studio, and similar). Do not run it on a shared machine if that matters for your threat model.
