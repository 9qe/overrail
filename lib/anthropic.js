const { Readable } = require("node:stream");

class AnthropicTranslateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AnthropicTranslateError";
    this.status = status;
  }
}

function is_object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num_or(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// The image types Anthropic actually puts in a `source.media_type`. Anything
// outside this list is rejected rather than forwarded, so a provider never
// quietly receives a payload it cannot decode.
const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// Body limit contract, shared with lib/gateway.js: bytes, integer env override,
// 32 MiB default.
const MAX_BODY_BYTES_ENV = "OVERRAIL_MAX_BODY_BYTES";
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

const SUPPORTED_TOOL_CHOICE_FORMS =
  'supported forms are "auto", "any", "required", "none", {"type":"auto"}, {"type":"any"}, ' +
  '{"type":"none"}, {"type":"tool","name":"<tool name>"}, and the OpenAI passthrough ' +
  '{"type":"function","function":{"name":"<tool name>"}}';

function describe_value(value) {
  let text;
  if (value === undefined) text = "undefined";
  else if (typeof value === "string") text = JSON.stringify(value);
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") text = String(value);
  else {
    try {
      text = JSON.stringify(value);
      if (typeof text !== "string") text = String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function check_unit_range(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AnthropicTranslateError(
      `"${field}" must be a finite number between 0 and 1 (Anthropic's scale), got ${describe_value(value)}`
    );
  }
  if (value < 0 || value > 1) {
    throw new AnthropicTranslateError(
      `"${field}" must be between 0 and 1 (Anthropic's scale), got ${value}`
    );
  }
  return value;
}

function too_large_body_error(limit_bytes) {
  return new AnthropicTranslateError(
    `request body too large: ${limit_bytes} byte limit exceeded; raise it with ${MAX_BODY_BYTES_ENV} (the value is bytes)`,
    413
  );
}

function resolve_max_body_bytes(max_bytes) {
  if (typeof max_bytes === "number" && Number.isFinite(max_bytes) && max_bytes > 0) return Math.trunc(max_bytes);
  const raw = process.env[MAX_BODY_BYTES_ENV];
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_BODY_BYTES;
}

function gen_id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function json_parseable(text) {
  if (text === "") return false;
  try {
    return is_object(JSON.parse(text));
  } catch {
    return false;
  }
}

function require_block_object(block, context) {
  if (!is_object(block)) {
    throw new AnthropicTranslateError(`content blocks in ${context} must be objects (found ${describe_value(block)})`);
  }
  if (typeof block.type !== "string") {
    throw new AnthropicTranslateError(`content block in ${context} is missing a string "type" field (found ${describe_value(block)})`);
  }
}

function reject_block_type(block_type, context) {
  const label = typeof block_type === "string" ? `"${block_type}"` : describe_value(block_type);
  throw new AnthropicTranslateError(
    `unsupported Anthropic content block type ${label} in ${context}; this gateway does not translate it, ` +
      "so the request is rejected instead of silently dropping your content"
  );
}

function push_text_part(parts, block, context) {
  if (typeof block.text !== "string") {
    throw new AnthropicTranslateError(`text content block in ${context} requires a string "text" field`);
  }
  parts.push({ type: "text", text: block.text });
}

// Anthropic image source -> OpenAI vision part. Base64 payloads get no inline
// size cap on purpose: the per-request body limit in default_read_body is what
// gates them, so a large screenshot is bounded by the same rule as any other body.
function image_block_to_openai(block, context) {
  const source = is_object(block.source) ? block.source : null;
  if (!source) {
    throw new AnthropicTranslateError(
      `image content block in ${context} requires a source object with type "base64" or "url" (found ${describe_value(block.source)})`
    );
  }
  if (source.type === "base64") {
    const media_type = source.media_type;
    if (typeof media_type !== "string" || IMAGE_MEDIA_TYPES.indexOf(media_type) === -1) {
      throw new AnthropicTranslateError(
        `unsupported image media_type ${describe_value(media_type)} in ${context}; this gateway forwards the types Anthropic sends: ${IMAGE_MEDIA_TYPES.join(", ")}`
      );
    }
    if (typeof source.data !== "string" || source.data === "") {
      throw new AnthropicTranslateError(`base64 image source in ${context} requires a non-empty string "data" field`);
    }
    return { type: "image_url", image_url: { url: `data:${media_type};base64,${source.data}` } };
  }
  if (source.type === "url") {
    if (typeof source.url !== "string" || source.url === "") {
      throw new AnthropicTranslateError(`url image source in ${context} requires a non-empty string "url" field`);
    }
    return { type: "image_url", image_url: { url: source.url } };
  }
  throw new AnthropicTranslateError(
    `unsupported image source type ${describe_value(source.type)} in ${context}; Anthropic sends "base64" or "url" image sources`
  );
}

function has_image_part(parts) {
  return parts.some((part) => part.type === "image_url");
}

// Text-only Anthropic content collapses to a plain OpenAI string; the moment an
// image joins the mix the ordered array form is the only one that keeps both.
function content_from_parts(parts) {
  if (!has_image_part(parts)) return parts.map((part) => part.text).join("\n");
  return parts;
}

function text_block_content(blocks, context) {
  const parts = [];
  for (const block of blocks) {
    require_block_object(block, context);
    if (block.type === "image") {
      throw new AnthropicTranslateError(
        `content block type "image" is not supported in ${context}; only text blocks are accepted there`
      );
    }
    if (block.type !== "text") reject_block_type(block.type, context);
    push_text_part(parts, block, context);
  }
  return parts.map((part) => part.text).join("\n");
}

function tool_result_content_to_openai(content, context) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      require_block_object(block, context);
      if (block.type === "text") push_text_part(parts, block, context);
      else if (block.type === "image") parts.push(image_block_to_openai(block, context));
      else reject_block_type(block.type, context);
    }
    return content_from_parts(parts);
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

function map_params(anthropic_body) {
  const out = {};
  if (typeof anthropic_body.model === "string" && anthropic_body.model !== "") out.model = anthropic_body.model;
  const max_tokens = num_or(anthropic_body.max_tokens, null);
  if (max_tokens === null) {
    throw new AnthropicTranslateError('"max_tokens" must be a finite number (required by the Messages API)');
  }
  out.max_tokens = max_tokens;
  // Anthropic's temperature scale is 0-1 and it is forwarded verbatim: every
  // OpenAI-compatible profile this gateway ships a default for accepts that
  // range, so doubling it invents a mapping no vendor documents.
  const temperature = check_unit_range(anthropic_body.temperature, "temperature");
  if (temperature !== null) out.temperature = temperature;
  const top_p = check_unit_range(anthropic_body.top_p, "top_p");
  if (top_p !== null) out.top_p = top_p;
  // "top_k" has no OpenAI chat-completions equivalent, so it is not forwarded.
  // It is an accepted no-op, recorded in docs/anthropic-compatibility.md.
  if (Array.isArray(anthropic_body.stop_sequences)) {
    const stops = anthropic_body.stop_sequences.filter((s) => typeof s === "string" && s !== "");
    if (stops.length > 0) out.stop = stops;
  }
  if (anthropic_body.stream === true) out.stream = true;
  return out;
}

function map_tools(anthropic_body) {
  if (!Array.isArray(anthropic_body.tools) || anthropic_body.tools.length === 0) return undefined;
  const tools = [];
  for (const tool of anthropic_body.tools) {
    if (!is_object(tool) || typeof tool.name !== "string" || tool.name === "") continue;
    const fn = {
      name: tool.name,
      parameters: is_object(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
    };
    if (typeof tool.description === "string" && tool.description !== "") fn.description = tool.description;
    tools.push({ type: "function", function: fn });
  }
  return tools.length > 0 ? tools : undefined;
}

// Anthropic's tool_choice arrives as bare strings or as typed objects. Every
// shape is either mapped to OpenAI or rejected with a 400: a directive the
// model was supposed to follow must never disappear on the way through.
function map_tool_choice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto") return "auto";
    if (choice === "any" || choice === "required") return "required";
    if (choice === "none") return "none";
    throw new AnthropicTranslateError(`unsupported Anthropic tool_choice ${describe_value(choice)}; ${SUPPORTED_TOOL_CHOICE_FORMS}`);
  }
  if (!is_object(choice)) {
    throw new AnthropicTranslateError(`unsupported Anthropic tool_choice ${describe_value(choice)}; ${SUPPORTED_TOOL_CHOICE_FORMS}`);
  }
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool") {
    if (typeof choice.name !== "string" || choice.name === "") {
      throw new AnthropicTranslateError(
        `tool_choice of type "tool" needs a non-empty string "name", got ${describe_value(choice)}; ${SUPPORTED_TOOL_CHOICE_FORMS}`
      );
    }
    return { type: "function", function: { name: choice.name } };
  }
  if (choice.type === "function") {
    const fn = is_object(choice.function) ? choice.function : null;
    if (!fn || typeof fn.name !== "string" || fn.name === "") {
      throw new AnthropicTranslateError(
        `tool_choice of type "function" is passed through to OpenAI and needs {"function":{"name":"<tool name>"}}, got ${describe_value(
          choice
        )}; ${SUPPORTED_TOOL_CHOICE_FORMS}`
      );
    }
    return { type: "function", function: { name: fn.name } };
  }
  throw new AnthropicTranslateError(
    `unsupported Anthropic tool_choice type ${describe_value(choice.type)}; ${SUPPORTED_TOOL_CHOICE_FORMS}`
  );
}

function map_history(messages) {
  const out = [];
  let pending = null; // assistant entry being built; sealed before the next user turn

  const seal = () => {
    if (!pending) return;
    const entry = { role: "assistant" };
    if (pending.has_image) {
      entry.content = pending.parts;
    } else if (pending.text.length > 0) {
      entry.content = pending.text;
    } else {
      entry.content = pending.tool_calls.length > 0 ? null : "";
    }
    if (pending.tool_calls.length > 0) entry.tool_calls = pending.tool_calls;
    out.push(entry);
    pending = null;
  };

  for (const msg of messages) {
    if (!is_object(msg) || typeof msg.role !== "string") {
      throw new AnthropicTranslateError("every history item must be an object with a string role");
    }
    if (msg.role === "assistant") {
      seal();
      pending = { text: "", parts: [], has_image: false, tool_calls: [] };
      if (typeof msg.content === "string") {
        pending.text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          require_block_object(block, "assistant message content");
          if (block.type === "text") {
            push_text_part(pending.parts, block, "assistant message content");
            pending.text += block.text;
          } else if (block.type === "image") {
            pending.parts.push(image_block_to_openai(block, "assistant message content"));
            pending.has_image = true;
          } else if (block.type === "tool_use") {
            if (typeof block.id !== "string" || typeof block.name !== "string") {
              throw new AnthropicTranslateError("tool_use block requires string id and name");
            }
            pending.tool_calls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(is_object(block.input) ? block.input : {}),
              },
            });
          } else {
            reject_block_type(block.type, "assistant message content");
          }
        }
      }
      continue;
    }
    if (msg.role === "user") {
      seal();
      if (typeof msg.content === "string") {
        if (msg.content !== "") out.push({ role: "user", content: msg.content });
        continue;
      }
      if (!Array.isArray(msg.content)) {
        const text = tool_result_content_to_openai(msg.content, "a user message");
        if (text !== "") out.push({ role: "user", content: text });
        continue;
      }
      const parts = [];
      for (const block of msg.content) {
        require_block_object(block, "user message content");
        if (block.type === "text") {
          push_text_part(parts, block, "user message content");
        } else if (block.type === "image") {
          parts.push(image_block_to_openai(block, "user message content"));
        } else if (block.type === "tool_result") {
          if (typeof block.tool_use_id !== "string") {
            throw new AnthropicTranslateError("tool_result block requires a string tool_use_id");
          }
          out.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: tool_result_content_to_openai(block.content, "tool_result content"),
          });
        } else {
          reject_block_type(block.type, "user message content");
        }
      }
      if (parts.length > 0) {
        const content = content_from_parts(parts);
        if (content !== "") out.push({ role: "user", content });
      }
      continue;
    }
    if (msg.role !== "system") {
      throw new AnthropicTranslateError(`unsupported Anthropic message role "${msg.role}"`);
    }
  }
  seal();
  return out;
}

function map_system(system) {
  if (system === undefined || system === null) return null;
  if (typeof system === "string") return system === "" ? null : system;
  if (!Array.isArray(system)) return null;
  const text = text_block_content(system, "the system prompt");
  return text === "" ? null : text;
}

function anthropic_messages_to_openai(anthropic_body) {
  if (!is_object(anthropic_body)) throw new AnthropicTranslateError("request body must be a JSON object");
  if (!Array.isArray(anthropic_body.messages)) {
    throw new AnthropicTranslateError('"messages" must be an array');
  }
  const openai = map_params(anthropic_body);
  const tools = map_tools(anthropic_body);
  if (tools) openai.tools = tools;
  const tool_choice = map_tool_choice(anthropic_body.tool_choice);
  if (tool_choice !== undefined) openai.tool_choice = tool_choice;

  const system = map_system(anthropic_body.system);
  const history = map_history(anthropic_body.messages);
  if (!system && history.length === 0) {
    throw new AnthropicTranslateError("request contains no usable system prompt or messages");
  }
  openai.messages = system ? [{ role: "system", content: system }, ...history] : history;
  return openai;
}

function finish_to_stop_reason(finish_reason) {
  if (finish_reason === "length") return "max_tokens";
  if (finish_reason === "tool_calls" || finish_reason === "function_call") return "tool_use";
  if (finish_reason === "content_filter") return "refusal";
  if (finish_reason === "stop" || finish_reason === null || finish_reason === undefined) return "end_turn";
  return "end_turn";
}

function parse_arguments(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return is_object(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

function openai_to_anthropic_response(openai_json, fallback_model) {
  if (!is_object(openai_json)) {
    throw new AnthropicTranslateError("upstream returned a non-object completion", 502);
  }
  const choice = Array.isArray(openai_json.choices) && openai_json.choices.length > 0 ? openai_json.choices[0] : null;
  const message = is_object(choice) && is_object(choice.message) ? choice.message : {};
  const usage = is_object(openai_json.usage) ? openai_json.usage : {};

  const content = [];
  if (typeof message.content === "string" && message.content !== "") {
    content.push({ type: "text", text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!is_object(call) || !is_object(call.function)) continue;
      content.push({
        type: "tool_use",
        id: typeof call.id === "string" && call.id !== "" ? call.id : gen_id("toolu"),
        name: typeof call.function.name === "string" ? call.function.name : "",
        input: parse_arguments(call.function.arguments),
      });
    }
  }

  const raw_id = typeof openai_json.id === "string" ? openai_json.id.replace(/^chatcmpl[-_]?/, "") : null;
  return {
    id: raw_id ? `msg_${raw_id}` : gen_id("msg"),
    type: "message",
    role: "assistant",
    model: typeof openai_json.model === "string" && openai_json.model !== "" ? openai_json.model : fallback_model,
    content,
    stop_reason: content.length === 0 ? "end_turn" : finish_to_stop_reason(is_object(choice) ? choice.finish_reason : null),
    stop_sequence: null,
    usage: {
      input_tokens: num_or(usage.prompt_tokens, 0),
      output_tokens: num_or(usage.completion_tokens, 0),
    },
  };
}

function parse_event_frame(frame) {
  let event = null;
  const data_lines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data_lines.push(line.slice(5).trimStart());
  }
  if (data_lines.length === 0) return null;
  try {
    return { event, data: JSON.parse(data_lines.join("\n")) };
  } catch {
    return null;
  }
}

function parse_anthropic_sse(text) {
  const events = [];
  for (const frame of String(text).split(/\r?\n\r?\n/)) {
    if (frame.trim() === "") continue;
    const parsed = parse_event_frame(frame);
    if (parsed) events.push(parsed);
  }
  return events;
}

function parse_data_payload(payload) {
  if (payload === "[DONE]") return { done: true };
  try {
    const chunk = JSON.parse(payload);
    return is_object(chunk) ? { chunk } : null;
  } catch {
    return null;
  }
}

function split_openai_sse(text) {
  const items = [];
  for (const frame of String(text).split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) {
        // a bare payload line (no SSE prefix) is still a valid feed source
        const bare = parse_data_payload(line.trim());
        if (bare) items.push(bare);
        continue;
      }
      const item = parse_data_payload(line.slice(5).trim());
      if (item) items.push(item);
    }
  }
  return items;
}

// Block indices are global and monotonic; only one block is open at a time and
// an index is never reopened after content_block_stop. Tool-call headers may
// arrive batched with interleaved argument streams, so blocks open lazily in
// arrival order: a call's block starts when it becomes active, streams deltas
// while its JSON is incomplete, and closes when its arguments parse and a
// queued sibling is waiting. finish/terminate closes everything exactly once.
// Text interrupted by a tool call resumes in a fresh block.
class AnthropicStreamEncoder {
  constructor({ model, include_ping } = {}) {
    this.model = typeof model === "string" && model !== "" ? model : "unknown-model";
    this.include_ping = include_ping === true;
    this.message_id = null;
    this.base_id_taken = false;
    this.model_taken = false;
    this.input_tokens = 0;
    this.output_tokens = 0;
    this.blocks = [];
    this.open_index = null;
    this.tool_entries = new Map(); // openai tool-call index -> entry
    this.tool_order = []; // entries in arrival order
    this.active_entry = null;
    this.finish_reason = null;
    this.started = false;
    this.terminated = false;
  }

  frame(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  message_start() {
    const message = {
      id: this.message_id || gen_id("msg"),
      type: "message",
      role: "assistant",
      model: this.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: this.input_tokens, output_tokens: 0 },
    };
    return this.frame("message_start", { type: "message_start", message });
  }

  ensure_started(chunk) {
    if (this.started) return [];
    if (is_object(chunk)) {
      if (!this.base_id_taken && typeof chunk.id === "string" && chunk.id !== "") {
        this.message_id = `msg_${chunk.id.replace(/^chatcmpl[-_]?/, "")}`;
        this.base_id_taken = true;
      }
      if (!this.model_taken && typeof chunk.model === "string" && chunk.model !== "") {
        this.model = chunk.model;
        this.model_taken = true;
      }
    }
    this.started = true;
    const out = [this.message_start()];
    if (this.include_ping) out.push(this.frame("ping", { type: "ping" }));
    return out;
  }

  close_block() {
    if (this.open_index === null) return [];
    const index = this.open_index;
    this.blocks[index].stopped = true;
    this.open_index = null;
    return [this.frame("content_block_stop", { type: "content_block_stop", index })];
  }

  emit_text(text) {
    const out = [];
    const active =
      this.open_index !== null && this.blocks[this.open_index].kind === "text" && !this.blocks[this.open_index].stopped;
    if (!active) {
      // an index may open only once, so text after a tool interruption gets a fresh block
      if (this.active_entry) {
        this.active_entry.finished = true;
        this.active_entry = null;
      }
      out.push(...this.close_block());
      const index = this.blocks.push({ kind: "text" }) - 1;
      this.open_index = index;
      out.push(
        this.frame("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        })
      );
    }
    out.push(
      this.frame("content_block_delta", {
        type: "content_block_delta",
        index: this.open_index,
        delta: { type: "text_delta", text },
      })
    );
    return out;
  }

  emit_tool_calls(deltas) {
    const out = [];
    for (const call of deltas) {
      if (!is_object(call)) continue;
      const key = typeof call.index === "number" ? call.index : 0;
      let entry = this.tool_entries.get(key);
      if (!entry) {
        entry = { key, id: null, name: "", args: "", started: false, finished: false, block_index: null };
        this.tool_entries.set(key, entry);
        this.tool_order.push(entry);
      }
      if (typeof call.id === "string" && call.id !== "" && !entry.started) entry.id = call.id;
      const fn = is_object(call.function) ? call.function : {};
      if (typeof fn.name === "string" && fn.name !== "") entry.name += fn.name;
      if (typeof fn.arguments === "string" && fn.arguments !== "") entry.args += fn.arguments;
      if (this.active_entry && this.active_entry !== entry) this.promote_tools(out);
      if (this.active_entry === entry && entry.started && fn.arguments) {
        out.push(
          this.frame("content_block_delta", {
            type: "content_block_delta",
            index: entry.block_index,
            delta: { type: "input_json_delta", partial_json: fn.arguments },
          })
        );
      }
    }
    this.promote_tools(out);
    return out;
  }

  activate_tool(entry, out) {
    if (this.open_index !== null) out.push(...this.close_block());
    entry.block_index = this.blocks.length;
    this.blocks.push({ kind: "tool_use", stopped: false });
    this.open_index = entry.block_index;
    entry.started = true;
    this.active_entry = entry;
    out.push(
      this.frame("content_block_start", {
        type: "content_block_start",
        index: entry.block_index,
        content_block: {
          type: "tool_use",
          id: entry.id || gen_id("toolu"),
          name: entry.name,
          input: {},
        },
      })
    );
    if (entry.args !== "") {
      out.push(
        this.frame("content_block_delta", {
          type: "content_block_delta",
          index: entry.block_index,
          delta: { type: "input_json_delta", partial_json: entry.args },
        })
      );
    }
  }

  promote_tools(out) {
    for (;;) {
      const active = this.active_entry;
      if (active && (!json_parseable(active.args) || !this.tool_order.some((e) => !e.started && !e.finished))) return;
      if (active) {
        out.push(...this.close_block());
        active.finished = true;
        this.active_entry = null;
      }
      const next = this.tool_order.find((e) => !e.started && !e.finished);
      if (!next) return;
      this.activate_tool(next, out);
    }
  }

  flush_tools(out) {
    // provider ended without finish_reason: every call still needs its own
    // start/stop pair, so promote any queued entries in arrival order
    for (;;) {
      const next = this.tool_order.find((e) => !e.started && !e.finished);
      if (!next) break;
      if (this.active_entry) {
        out.push(...this.close_block());
        this.active_entry.finished = true;
        this.active_entry = null;
      }
      this.activate_tool(next, out);
      out.push(...this.close_block());
      next.finished = true;
      this.active_entry = null;
    }
  }

  handle_chunk(chunk) {
    if (this.terminated || !is_object(chunk)) return [];
    if (is_object(chunk.usage)) {
      this.input_tokens = Math.max(this.input_tokens, num_or(chunk.usage.prompt_tokens, this.input_tokens));
      this.output_tokens = Math.max(this.output_tokens, num_or(chunk.usage.completion_tokens, this.output_tokens));
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    // some providers put the finish frame in choices[0] with an empty delta,
    // or send choices: [] alongside the final usage — scan all choices for it
    for (const candidate of choices) {
      if (is_object(candidate) && typeof candidate.finish_reason === "string" && candidate.finish_reason !== "") {
        this.finish_reason = candidate.finish_reason;
      }
    }
    const choice = choices[0];
    if (!is_object(choice)) {
      // usage-only chunk still opens the message so the event order stays valid
      return this.ensure_started(chunk);
    }
    const out = this.ensure_started(chunk);
    const delta = is_object(choice.delta) ? choice.delta : {};
    if (typeof delta.content === "string" && delta.content !== "") {
      out.push(...this.emit_text(delta.content));
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      out.push(...this.emit_tool_calls(delta.tool_calls));
    }
    return out;
  }

  feed(chunk) {
    if (typeof chunk === "string") {
      const trimmed = chunk.trim();
      if (trimmed === "") return [];
      if (trimmed === "[DONE]") return this.terminate();
      const out = [];
      let saw_done = false;
      const items = trimmed.startsWith("data:") || trimmed.includes("\ndata:")
        ? split_openai_sse(trimmed)
        : [parse_data_payload(trimmed)].filter(Boolean);
      for (const item of items) {
        if (item.done) {
          saw_done = true;
          continue;
        }
        out.push(...this.handle_chunk(item.chunk));
      }
      if (saw_done) return out.concat(this.terminate());
      return out;
    }
    return this.handle_chunk(chunk);
  }

  terminate() {
    if (this.terminated) return [];
    this.terminated = true;
    const out = this.ensure_started(null);
    this.flush_tools(out);
    if (this.active_entry) {
      this.active_entry.finished = true;
      this.active_entry = null;
    }
    out.push(...this.close_block());
    out.push(
      this.frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: finish_to_stop_reason(this.finish_reason), stop_sequence: null },
        usage: { output_tokens: this.output_tokens },
      })
    );
    out.push(this.frame("message_stop", { type: "message_stop" }));
    return out;
  }

  get done() {
    return this.terminated;
  }
}

function failure_payload(err) {
  const attempts = Array.isArray(err && err.attempts) ? err.attempts : [];
  const status = err && typeof err.status === "number" ? err.status : 502;
  return {
    status,
    payload: {
      type: "error",
      error: {
        type: status === 400 ? "invalid_request_error" : "api_error",
        message: err && err.message ? err.message : "upstream failed",
        ...(attempts.length > 0 ? { attempts } : {}),
      },
    },
  };
}

// Body limit for POST /v1/messages. It matches the contract lib/gateway.js uses
// for the OpenAI route: OVERRAIL_MAX_BODY_BYTES as an integer byte count, 32 MiB
// by default. On overflow the promise rejects at once and the rest of the stream
// is drained and discarded, never buffered, so the client still receives the 413.
function default_read_body(req, options = {}) {
  const limit_bytes = resolve_max_body_bytes(options.max_bytes);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      reject(too_large_body_error(limit_bytes));
      req.resume();
    };
    const declared = Number.parseInt(String((req.headers && req.headers["content-length"]) || ""), 10);
    if (Number.isFinite(declared) && declared > limit_bytes) {
      fail();
      return;
    }
    req.on("data", (chunk) => {
      if (failed) return;
      total += chunk.length;
      if (total > limit_bytes) {
        fail();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
  });
}

async function* upstream_sse_data(body) {
  const stream = Readable.fromWeb(body);
  let buffer = "";
  for await (const piece of stream) {
    buffer += piece.toString("utf8");
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data_lines = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (data_lines.length > 0) yield data_lines.join("\n");
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trimStart();
}

async function run_anthropic_request({ req, res, dispatch, on_done, fallback_model, read_body }) {
  let anthropic_body;
  let raw_body;
  try {
    raw_body = await read_body(req);
  } catch (err) {
    // a body-limit rejection carries its own status (413); do not mask it as a
    // JSON error or the client loses both the code and the reason
    const translate_err =
      err instanceof AnthropicTranslateError ? err : new AnthropicTranslateError("could not read the request body");
    const failure = failure_payload(translate_err);
    res.writeHead(failure.status, { "content-type": "application/json" });
    res.end(JSON.stringify(failure.payload));
    return;
  }
  try {
    anthropic_body = JSON.parse(raw_body);
  } catch {
    const failure = failure_payload(new AnthropicTranslateError("request body is not valid JSON"));
    res.writeHead(failure.status, { "content-type": "application/json" });
    res.end(JSON.stringify(failure.payload));
    return;
  }
  let openai_body;
  try {
    openai_body = anthropic_messages_to_openai(anthropic_body);
  } catch (err) {
    const failure = failure_payload(err instanceof AnthropicTranslateError ? err : new AnthropicTranslateError(err.message));
    res.writeHead(failure.status, { "content-type": "application/json" });
    res.end(JSON.stringify(failure.payload));
    return;
  }
  const want_stream = openai_body.stream === true;
  const translated_model =
    typeof openai_body.model === "string" ? openai_body.model : typeof fallback_model === "string" ? fallback_model : undefined;

  const usage_box = { input: 0, output: 0 };
  const report_done = (profile_name, upstream_model) => {
    if (typeof on_done !== "function") return;
    on_done({ prompt_tokens: usage_box.input, completion_tokens: usage_box.output }, profile_name, upstream_model);
  };

  let winner;
  try {
    winner = await dispatch(openai_body);
  } catch (err) {
    const failure = failure_payload(err);
    res.writeHead(failure.status, { "content-type": "application/json" });
    res.end(JSON.stringify(failure.payload));
    return;
  }

  if (!want_stream) {
    let openai_json;
    try {
      openai_json = JSON.parse(await winner.response.text());
    } catch {
      const failure = failure_payload(new AnthropicTranslateError("upstream returned a non-JSON completion", 502));
      res.writeHead(failure.status, { "content-type": "application/json" });
      res.end(JSON.stringify(failure.payload));
      return;
    }
    let anthropic_json;
    try {
      anthropic_json = openai_to_anthropic_response(openai_json, translated_model);
    } catch (err) {
      const failure = failure_payload(err);
      res.writeHead(failure.status, { "content-type": "application/json" });
      res.end(JSON.stringify(failure.payload));
      return;
    }
    usage_box.input = anthropic_json.usage.input_tokens;
    usage_box.output = anthropic_json.usage.output_tokens;
    report_done(winner.profile_name, winner.upstream_model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(anthropic_json));
    return;
  }

  const encoder = new AnthropicStreamEncoder({ model: translated_model });
  let headers_sent = false;
  const write_events = (events) => {
    if (events.length === 0) return;
    if (!headers_sent) {
      headers_sent = true;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
    }
    res.write(events.join(""));
  };

  try {
    if (!winner.response || !winner.response.body) throw new Error("empty stream");
    for await (const data of upstream_sse_data(winner.response.body)) {
      if (data === "[DONE]") break;
      write_events(encoder.feed(data));
    }
  } catch {
    // provider died mid-stream: close the anthropic message with what we have
  }
  usage_box.input = encoder.input_tokens;
  usage_box.output = encoder.output_tokens;
  if (!encoder.terminated) write_events(encoder.terminate());
  if (headers_sent) {
    report_done(winner.profile_name, winner.upstream_model);
    res.end();
  } else {
    // nothing reached the client yet: fall back to a JSON error
    const failure = failure_payload(new Error("all providers failed without producing stream data"));
    res.writeHead(failure.status, { "content-type": "application/json" });
    res.end(JSON.stringify(failure.payload));
  }
}

function createAnthropicMessagesHandler({ dispatch, on_done, fallback_model, read_body } = {}) {
  if (typeof dispatch !== "function") {
    throw new AnthropicTranslateError("createAnthropicMessagesHandler requires a dispatch function", 500);
  }
  const read = typeof read_body === "function" ? read_body : default_read_body;

  return async function handle_anthropic_messages(req, res) {
    try {
      let pathname;
      try {
        pathname = new URL(req.url, "http://127.0.0.1").pathname;
      } catch {
        pathname = req.url || "";
      }
      if (req.method !== "POST" || pathname !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no anthropic route for ${req.method} ${pathname}` } }));
        return;
      }
      await run_anthropic_request({
        req,
        res,
        dispatch,
        on_done,
        fallback_model,
        read_body: read,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err && err.message ? err.message : "gateway error" } }));
      } else {
        res.destroy();
      }
    }
  };
}

module.exports = {
  AnthropicTranslateError,
  AnthropicStreamEncoder,
  anthropic_messages_to_openai,
  openai_to_anthropic_response,
  parse_anthropic_sse,
  split_openai_sse,
  default_read_body,
  createAnthropicMessagesHandler,
};
