# agentrouter v0.2.0 — Windows Tray App Engineering Spec

Status: draft. Target: Windows 11, notification area. Core stays CommonJS, zero npm dependencies, Node >= 18.
This spec builds on the v0.1.0 interfaces in `bin/agentrouter.js`, `lib/gateway.js`, `lib/failover.js`, `lib/usage.js`, `lib/config.js`, `lib/providers.js`.

## 1. Goal statement

The tray app adds a control surface over the CLI. It does not replace it.

- One-click profile switching from the tray menu (writes `cfg.active` via `lib/config.js`).
- Gateway start/stop with live status (menu title reflects `server.listening` and port).
- Toast notification when a failover chain step fires (429/500/502/503/504 or network error).
- Usage pop-up: requests and tokens from `~/.agentrouter/usage.jsonl`, last 7 days and all time.
- Quick actions: "Copy PowerShell env" and "Run agent with profile" reuse `envLines()` and the `run` command's injection logic from `bin/agentrouter.js`.

Non-goals: no cloud, no accounts, no telemetry — ever. No editor UI for config.json (the CLI keeps that role). No macOS/Linux in v0.2.

## 2. Tech choice

| Option | Shell size | Core reuse | Win11 tray fidelity | New toolchain |
|---|---|---|---|---|
| Native Win32 + C++/Rust | 1-3 MB | sidecar needed | best | Rust or MSVC |
| Tauri 2 (Rust + WebView2) | ~8-10 MB (open question: exact) | sidecar needed | best | Rust |
| Electron | ~90-100 MB installer, ~200 MB installed | in-process | good | Node already required |
| Node-only (node-systray / PowerShell NotifyIcon) | n/a | in-process | poor | none |

- Electron rejected: two orders of magnitude larger than the job needs, contradicts the zero-dependency product position.
- node-systray rejected: ships a bundled third-party Go binary — a dependency in disguise. PowerShell NotifyIcon rejected: no clean menu-event loop, STA quirks, unmaintainable.
- Tauri 2 works but v0.2 has no surface that needs a webview (menus and toasts cover everything), so its webview runtime is paid for and unused.

**Recommendation for v0.2: standalone Rust tray shell + Node sidecar.**
Use the `tray-icon` crate (the same crate Tauri 2 uses for menus) plus the `windows` crate for WinRT toasts. No WebView2, no window in v0.2. Shell binary target: under 3 MB. The shell is the only compiled artifact; the entire product logic stays in the existing Node lib/.

Sidecar embedding, concretely:
- The v0.1.0 user installed an npm package with `engines.node >= 18`, so Node is already present. The shell resolves Node via `node.exe` on PATH at first launch and spawns `node <install>/lib/tray-sidecar.js`. If Node is absent the menu shows one item, "Node not found — install Node 18 or newer", and opens nodejs.org on click.
- IPC: JSON lines over the sidecar's stdio (see section 3). Shell kills the sidecar on quit and assigns the child to a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so a crashed shell never orphans a gateway.
- A Node single-executable sidecar (SEA, Node >= 20) is an option for later if "no installed Node" users matter. Open question: SEA exe size and Windows signing steps.

## 3. Architecture

Components:

1. `tray/` — Rust shell: tray icon, menu rendering, toasts, clipboard, job-object supervision, launches the sidecar. Holds no product logic.
2. `lib/tray-sidecar.js` — new Node process. Owns: config load/save (reuses `lib/config.js`), gateway lifecycle (reuses `lib/gateway.js` `createGateway`, binds 127.0.0.1), usage queries (reuses `lib/usage.js`), env-block generation (port of `envLines()` from `bin/agentrouter.js` into `lib/env-blocks.js` so CLI and tray share one implementation), failover event subscription.
3. `lib/failover.js` — extended with an event hook (section 6).
4. `lib/gateway.js` — extended: streaming usage capture (section 5), failover hook wiring.
5. `lib/usage.js` — extended with `summarizeSince(sinceIso)`; `readUsage`/`summarize` unchanged.

```
+----------------------------------------------------------+
| Windows 11 notification area                              |
|   [tray icon]  <-- menu / toast events -->  tray shell    |
|                                              (Rust)       |
+------------------------------------||---------------------+
                                 stdin/stdout (JSON lines)
                                      ||                    |
+------------------------------------||---------------------+
|  lib/tray-sidecar.js (Node, zero-dep)                     |
|   protocol reader --> ops                                 |
|     gateway.start/stop --> createGateway + listen(8787)   |
|     profile.use        --> loadConfig/saveConfig          |
|     usage.summary      --> readUsage/summarizeSince       |
|     env.copy           --> resolveEnv + env-blocks        |
|     run.agent          --> spawn bin/agentrouter.js run   |
|   event writer      <-- failover hooks, gateway state     |
+----------------------------------------------------------+
```

IPC contract: one JSON object per line, UTF-8, both directions. Sidecar stdout carries protocol only; all diagnostics go to stderr. Requests carry a numeric `id`; responses echo it. Events have no `id`.

Tray -> sidecar (requests):

```json
{"id":1,"op":"gateway.start","args":{"port":8787}}
{"id":2,"op":"gateway.stop"}
{"id":3,"op":"profile.use","args":{"name":"deepseek"}}
{"id":4,"op":"state.get"}
{"id":5,"op":"usage.summary","args":{"days":7}}
{"id":6,"op":"env.copy","args":{"name":"deepseek","shell":"powershell"}}
{"id":7,"op":"run.agent","args":{"name":"deepseek","command":"claude"}}
{"id":8,"op":"setting.set","args":{"key":"failoverToasts","value":false}}
```

Sidecar -> tray (responses):

```json
{"id":1,"ok":true,"result":{"listening":true,"port":8787,"active":"deepseek"}}
{"id":2,"ok":false,"error":"EADDRINUSE: port 8787 in use"}
```

Sidecar -> tray (events):

```json
{"event":"gateway.state","state":"running","port":8787}
{"event":"failover","from":"deepseek","to":"openrouter","reason":"http 429","ts":"2026-11-05T10:00:00.000Z"}
{"event":"usage.logged","provider":"deepseek","model":"deepseek-chat"}
```

`profile.use` semantics: `createGateway({config})` captures the config object once, so the sidecar implements switch as stop server -> `saveConfig` with new `active` -> `loadConfig` -> start server. Local restart is fast; if measurement shows it is not, the follow-up is making `handle_request` re-read config per call. Open question: restart-on-switch latency, resolve in M2.

## 4. UI inventory

Tray icon states: idle (gateway stopped), running (gateway listening), error (port conflict or sidecar failure). Tooltips: "agentrouter — gateway stopped" / "agentrouter — gateway on 127.0.0.1:8787".

Menu (exact labels, top to bottom):

```
Gateway: stopped                      (or "Gateway: running on 127.0.0.1:8787")
  Start gateway        /  Stop gateway   (one shown, depends on state)
--- separator ---
Profiles                              (radio group; checked item = cfg.active)
  DeepSeek
  Kimi / Moonshot
  OpenRouter
  Ollama (local, no key)
--- separator ---
Copy PowerShell env                   (for active profile)
Copy cmd.exe env
Run agent with profile...             (submenu: "claude", "codex", "aider", custom)
--- separator ---
Usage (7d)                            (opens submenu, rows below)
Usage (all time)
--- separator ---
Failover toasts                       (checkbox, default on)
Open config file                      (explorer.exe on CONFIG_PATH)
Quit
```

Usage submenu rows (one disabled menu item per line, values from `summarizeSince`):

```
Requests: 128
Prompt tokens: 45,120
Completion tokens: 9,880
By provider:
  deepseek: 100 req
  openrouter: 28 req
```

Toasts (WinRT ToastNotificationManager, exact copy):

| Event | Title | Body |
|---|---|---|
| Failover step | "agentrouter failover" | "deepseek returned http 429 — retrying on openrouter" |
| All providers failed | "agentrouter failover" | "all providers failed for model \"deepseek\"" |
| Gateway error | "agentrouter gateway" | "port 8787 in use — gateway not started" |

No emoji anywhere in labels or toast copy. Toasts suppressed while the "Failover toasts" checkbox is off (persisted in config.json as `failoverToasts: true`).

## 5. Streaming usage fix

v0.1.0 gap: `lib/gateway.js` buffers and logs usage only for JSON content types; SSE responses are piped through at line 134-142 with no capture. v0.2 fix, three layers:

1. Request rewrite: when the client body has `stream: true`, inject `stream_options: {"include_usage": true}` into the upstream body before fetch. OpenAI and most compatible providers then emit a final SSE chunk carrying `"usage": {...}` with `"choices": []`. Some providers reject unknown fields: if the upstream answers 4xx on the first attempt, retry the request without the injected field (bounded to one extra attempt).
2. SSE scan: on the stream path, pipe through a `Transform` that forwards bytes unchanged and, on the side, splits on `\n\n` event boundaries and parses lines starting with `data: `. Any parsed object with a `usage` object that has numeric `prompt_tokens`/`completion_tokens` triggers `logUsage` with `streamed: true`. The OpenAI final usage chunk is also forwarded to the client; `"choices": []` chunks are ignored by mainstream client SDKs. Log one entry per request (a request may carry multiple usage-bearing chunks only if the provider is misbehaving — keep the first, drop later ones).
3. Fallback: if no usage chunk arrives, log the entry with `prompt_tokens: null, completion_tokens: null, streamed: true`. Optionally record upstream `x-ratelimit-remaining-tokens` deltas when present as `ratelimit_tokens` — informational only.

Honesty clause, stated in code comments and the README: token counts for streamed responses arrive only if the upstream sends them. Providers that emit no usage in stream mode cannot be counted; the entry records that the request happened and that it streamed.

## 6. Failover toasts

Event source: `lib/failover.js` currently returns void and throws with `err.attempts`. Add an optional hooks parameter, zero dependencies:

```js
async function withFailover(chain, attempt_fn, hooks = {}) { ... }
// before moving from chain[i] to chain[i+1] on a retryable failure:
if (hooks.onFailover) hooks.onFailover({
  ts: new Date().toISOString(),
  from: chain[i],
  to: chain[i + 1],
  reason: `http ${status}`,          // or "network error" for thrown fetch failures
  attempts: attempts.length,
});
```

`lib/gateway.js` builds the hooks once and passes them into `withFailover`. The hook appends the same object as a line to `~/.agentrouter/events.jsonl` (new `EVENTS_PATH` export in `lib/config.js`) and calls the sidecar's registered callback, which writes `{"event":"failover",...}` to stdout. The tray shell maps that event to the toast in section 4. Setting `failoverToasts: false` suppresses only the toast, never the JSONL record.

Test seam: `withFailover` with a failing then succeeding attempt_fn must emit exactly one `onFailover` object with correct `from`/`to`/`reason`.

## 7. Milestones

M1 — Tray + gateway supervisor (shippable alpha)
- Scope: Rust shell, sidecar protocol, gateway.start/stop/state.get, tray icon states, Quit with job-object teardown.
- Files: `tray/` (new crate), `lib/tray-sidecar.js`, `lib/env-blocks.js` (extracted), package.json (`scripts.tray`).
- Tests: `node --test` for protocol reader (request/response framing, malformed line skipped); manual: start/stop, port-in-use shows error state, `taskkill /IM shell.exe` leaves no node.exe child.

M2 — Profile switching + env copy + run actions
- Scope: Profiles radio group, `profile.use` with restart-on-switch, clipboard ops, "Run agent with profile..." submenu.
- Files: `lib/tray-sidecar.js`, `lib/env-blocks.js`, tray menu code.
- Tests: switch writes `cfg.active` and new gateway serves per-request `<profile>` model field; clipboard content matches `agentrouter env <profile>` output byte for byte; `run.agent` spawns with `CREATE_NEW_CONSOLE` and inherits env.

M3 — Failover toasts + usage pop-up
- Scope: failover hooks in lib/failover.js and lib/gateway.js, SSE usage capture, `summarizeSince`, events.jsonl, toasts, Usage submenus, "Failover toasts" checkbox.
- Files: `lib/failover.js`, `lib/gateway.js`, `lib/usage.js`, `lib/config.js`, `lib/tray-sidecar.js`, tray toast code.
- Tests: unit — hook emission, SSE scan against a fixture stream with and without a usage chunk, include_usage rejection fallback; manual — live 429 from a mocked upstream produces one toast and one events.jsonl line.

M4 — Signed installer
- Scope: MSIX or NSIS installer, Start Menu shortcut with AppUserModelID (required for toasts from unpackaged apps), winget manifest (`9qe.agentrouter`), code signing.
- Files: `installer/`, `packaging/winget/`, CI workflow.
- Code signing reality check: Azure Trusted Signing — published at roughly $9.99/month, requires individual or organization identity validation, gives SmartScreen reputation on a rolling basis (open question: current pricing, validation wait, and individual-account availability). EV certificate — several hundred USD per year plus validation, immediate SmartScreen reputation, hardware token or cloud HSM. Self-signed — free, warns on every install, never builds SmartScreen reputation; acceptable for the alpha, not for M4. Decision due at M4 start; distribution of the unsigned M1-M3 builds is zip + "unblock the file" instructions.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Webview dependency bloat | Large binary, slow start | Chosen shell has no webview; if a future UI needs one, revisit Tauri as a separate window, not a rewrite |
| Tray icon hidden in overflow | Users think the app is not running | Win11 hides new icons in the overflow flyout by default; document "drag to taskbar corner" in the README; tooltip states gateway status |
| Sidecar orphan (shell crash leaves node.exe + bound port alive) | Port 8787 stuck, phantom gateway | Job Object with KILL_ON_JOB_CLOSE in the shell; sidecar also exits if stdin closes (parent-death detection) |
| AV false positives on unsigned tray exe | Install blocked, repo reports | Ship M1-M3 as zip with hash published; sign from M4; submit false positives to vendor portals |
| Providers that never send stream usage | Token counts under-report for streaming | Disclosed in section 5 and README; entry records `streamed: true` with null tokens |
| Upstream rejects injected stream_options | Streaming requests fail on strict providers | One retry without the injected field, bounded, logged |
| Restart-on-switch drops in-flight requests | Rare client error during switch | Acceptable for local single-user tool; document; revisit per-request config read if it bites |

Open questions carried: sidecar restart latency measurement (M2), SEA exe size if bundled Node is pursued, Trusted Signing current terms (M4).
