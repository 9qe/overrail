# Anthropic `/v1/messages` compatibility

`POST /v1/messages` takes an Anthropic Messages request, translates it into an OpenAI
chat-completions body, and pushes that body through the same failover and mid-stream stitching
engine that serves `POST /v1/chat/completions`. The translation lives in `lib/anthropic.js`, the
engine in `lib/gateway.js`. The upstream is never an Anthropic model. The shipped profiles are
DeepSeek, Moonshot/Kimi, OpenRouter and Ollama, so every Anthropic-shaped feature below is
emulated against a different vendor's API and the reply, JSON or SSE, is translated back into
Anthropic events. "Supported" in this file means the translation is correct and tested locally. It
does not mean any vendor honors the intent behind the field.

## Feature matrix

| Anthropic feature | Status | What this gateway actually does |
|---|---|---|
| Text messages | Supported | String content and `text` blocks are accepted for user and assistant turns. Consecutive text blocks join with a newline into one OpenAI message. |
| System prompt (string and block array) | Supported | A string passes through as the OpenAI system message. A block array must hold text blocks only; they join with newlines. Any other block type in `system` is a 400 that names the block type. |
| Basic tool definitions (`input_schema` mapped to JSON Schema `parameters`) | Supported | Each tool becomes `{"type":"function","function":{"name","description","parameters"}}`. `input_schema` is copied through as `parameters` with no validation, and a tool with no `input_schema` gets `{"type":"object","properties":{}}`. |
| Tool results | Supported | A `tool_result` block becomes an OpenAI `role:"tool"` message keyed by `tool_use_id`. String content passes through unchanged, text blocks join, and a block array of text plus image becomes the OpenAI parts array. Any other block type inside a tool result is a 400. |
| Streaming text | Supported | OpenAI `delta.content` becomes `content_block_start`, `content_block_delta` with `text_delta`, and one `content_block_stop`. Block indices are global and monotonic, and text that resumes after a tool call opens a fresh block. |
| Streaming `tool_use` | Supported | Tool call deltas open a `tool_use` block, arguments stream as `input_json_delta`, and every block closes exactly once, including when the provider dies mid-stream or never sends a finish reason. |
| Stop reason mapping | Supported | `stop` to `end_turn`, `length` to `max_tokens`, `tool_calls` and `function_call` to `tool_use`, `content_filter` to `refusal`. A missing or unrecognized finish reason becomes `end_turn`. |
| Object-based `tool_choice` | Supported, with a 400 on anything unmappable | `{"type":"auto"}` maps to `auto`, `{"type":"any"}` to `required`, `{"type":"none"}` to `none`, `{"type":"tool","name":"x"}` to `{"type":"function","function":{"name":"x"}}`, and `{"type":"function","function":{"name":"x"}}` is accepted as an already OpenAI-shaped passthrough. The bare strings `auto`, `any`, `required` and `none` still work. An unknown `type`, a `tool` choice with no name, or a value that is neither string nor object is a 400 naming the value and listing the supported forms. An absent `tool_choice` stays absent. Nothing is silently dropped anymore. |
| Image blocks | Translated; end-to-end success is unproven | A base64 source becomes `{"type":"image_url","image_url":{"url":"data:<media_type>;base64,<data>"}}` and a url source becomes `image_url` with that url, in arrival order alongside the text parts, in user turns, assistant turns and tool results. `media_type` must be `image/jpeg`, `image/png`, `image/gif` or `image/webp`; anything else is a 400 naming the media type. There is no separate inline size cap on base64 payloads, the request body limit below is what gates them. The translated request only succeeds if the upstream profile is genuinely vision-capable. A provider that rejects the image rejects it as its own 4xx or 5xx, which is provider behavior this project has NOT tested, because no funded provider has ever been sent an image. |
| `top_k` | Ignored, and named as ignored | Anthropic accepts `top_k`. OpenAI chat completions has no equivalent field, so this gateway does not forward it and does not smuggle it into another parameter. The request succeeds and the model never sees the constraint. |
| `thinking` and `redacted_thinking` blocks, `document` blocks, `search_result` blocks, `tool_reference` and `web_search_tool_result` blocks, citations, prompt caching and `cache_control`, stop-location metadata, and token-by-token `partial_json` guarantees beyond this encoder | NOT supported | `thinking`, `redacted_thinking`, `document`, `search_result`, `tool_reference`, `web_search_tool_result` and any other unknown block type are rejected with a 400 that names the block type, in user content, assistant content, tool results and the system prompt. They are never silently stripped, because a truncated prompt makes the model answer a question nobody asked. Citations and `cache_control` on blocks that are otherwise accepted are ignored: there is no prompt caching behind this route, so a cache breakpoint neither costs nor buys anything. `stop_sequence` returns `null` in the JSON response and in the streamed `message_delta`; the gateway never reports a stop location. The encoder does emit `input_json_delta` chunks, but the only guarantee is that the concatenation of a block's `partial_json` equals the arguments this gateway parsed. Anthropic's per-token framing is not reproduced, so no client should depend on a particular chunk boundary. |

## Signals a client can rely on

`temperature` and `top_p` are forwarded verbatim. Anthropic's scale for both is 0 to 1, and every
OpenAI-compatible profile shipped here accepts that range, so no rescaling is applied. A value that
is not a finite number inside 0 to 1 is a 400 naming the field.

Request bodies are capped at 32 MiB, or at the integer byte count in `OVERRAIL_MAX_BODY_BYTES`. The
limit is checked against `content-length` first and then against the running total, the promise
rejects the moment the total passes the limit, and the remaining bytes are drained and discarded
rather than buffered. The client gets an Anthropic-shaped error with HTTP status 413 and this
message:

```
request body too large: 33554432 byte limit exceeded; raise it with OVERRAIL_MAX_BODY_BYTES (the value is bytes)
```

Translation failures use the Anthropic error envelope with `invalid_request_error` for 400 responses:

```
unsupported Anthropic tool_choice type "mcp_tool"; supported forms are "auto", "any", "required", "none", {"type":"auto"}, {"type":"any"}, {"type":"none"}, {"type":"tool","name":"<tool name>"}, and the OpenAI passthrough {"type":"function","function":{"name":"<tool name>"}}

unsupported Anthropic content block type "document" in user message content; this gateway does not translate it, so the request is rejected instead of silently dropping your content

unsupported image media_type "application/pdf" in user message content; this gateway forwards the types Anthropic sends: image/jpeg, image/png, image/gif, image/webp

"temperature" must be between 0 and 1 (Anthropic's scale), got 1.5
```

Upstream failures keep the gateway's existing shape: a 502 `api_error` with the per-profile `attempts`
array attached.

## Not established

Full Claude Code compatibility is UNTESTED. No live-provider run has ever completed against this
route, on any provider. `docs/provider-matrix.md` records the current state as `pass: 0`, `fail: 0`,
`skipped: 32` with `evidence_valid: false`, because there is no funded API key on this machine and
Ollama is not installed here. The matrix runner exits 2 in that state on purpose.

Every claim in this file is backed only by local tests, `test/anthropic.test.js` and
`test/anthropic-gateway.test.js`, which run against in-process fake upstreams that implement this
project's reading of the OpenAI contract. Real providers deviate in framing, usage chunks and error
shapes, and those deviations are exactly what a local suite cannot catch. Treat the matrix above as a
statement about the translation layer, not about any vendor.
