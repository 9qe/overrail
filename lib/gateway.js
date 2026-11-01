const http = require("node:http");

const { resolveProfile } = require("./config");
const { withFailover } = require("./failover");
const { logUsage } = require("./usage");
const { relay_stream, create_openai_client } = require("./stream-relay");
const recovery = require("./recovery");
const {
  AnthropicStreamEncoder,
  AnthropicTranslateError,
  anthropic_messages_to_openai,
  openai_to_anthropic_response,
} = require("./anthropic");

const DEFAULT_MODELS = {
  deepseek: "deepseek-chat",
  kimi: "kimi-k2",
  openrouter: "anthropic/claude-sonnet-4.5",
  ollama: "qwen3:8b",
};

function send_json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

// The cap is read per request (not at module load) so OVERRAIL_MAX_BODY_BYTES can
// change between cases without a restart; unset/NaN/non-positive falls back to 32 MiB.
function max_body_bytes() {
  const parsed = parseInt(process.env.OVERRAIL_MAX_BODY_BYTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32 * 1024 * 1024;
}

function body_too_large_message(limit) {
  return `request body exceeds the ${limit}-byte limit (raise with OVERRAIL_MAX_BODY_BYTES)`;
}

function make_body_too_large_error(limit) {
  const err = new Error(body_too_large_message(limit));
  err.code = "request_too_large";
  err.limit = limit;
  return err;
}

function is_body_too_large(err) {
  return Boolean(err) && err.code === "request_too_large" && typeof err.limit === "number";
}

function openai_body_too_large(limit) {
  return {
    error: {
      message: body_too_large_message(limit),
      type: "invalid_request_error",
      code: "request_too_large",
      param: null,
    },
  };
}

function anthropic_body_too_large(limit) {
  return {
    type: "error",
    error: { type: "request_too_large", message: body_too_large_message(limit) },
  };
}

function read_body(req) {
  return new Promise((resolve, reject) => {
    const limit = max_body_bytes();
    const declared = parseInt(req.headers["content-length"], 10);
    if (Number.isFinite(declared) && declared > limit) {
      // the header alone proves the body cannot fit — refuse before buffering a byte
      req.on("error", () => {}); // the post-413 socket destroy must not surface unhandled
      req.resume(); // drain so the socket does not stall while we answer
      reject(make_body_too_large_error(limit));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0; // early fail: drop what was buffered, stop growing
        req.removeAllListeners("data");
        req.resume();
        reject(make_body_too_large_error(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// On both POST routes read_body runs before anything writes to res, so a size
// rejection can never race a streaming response; the guard is belt-and-braces.
function refuse_body(req, res, payload) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  send_json(res, 413, payload);
  // cut the still-uploading socket once the 413 is flushed; a fully drained
  // keep-alive request needs no destroy
  res.on("finish", () => {
    if (!req.readableEnded) req.destroy();
  });
}

function split_model(raw) {
  const idx = raw.indexOf("/");
  if (idx === -1) return { profile_name: raw, model_part: null };
  return { profile_name: raw.slice(0, idx), model_part: raw.slice(idx + 1) };
}

function num_or_null(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function attempt_profile(config, profile_name, requested_profile, model_part, client_body) {
  if (process.env.OVERRAIL_CHAOS === "529" && !config._chaos529_fired) {
    config._chaos529_fired = true;
    return { ok: false, status: 529 };
  }
  const profile = resolveProfile(config, profile_name);
  const upstream_model =
    profile_name === requested_profile && model_part ? model_part : DEFAULT_MODELS[profile_name];
  if (!upstream_model) {
    throw new Error(`profile "${profile_name}" has no default model — request "${profile_name}/<model>" instead`);
  }
  const headers = { "content-type": "application/json", ...(profile.headers || {}) };
  if (profile.apiKeyEnv) {
    const key = process.env[profile.apiKeyEnv];
    if (!key) throw new Error(`missing ${profile.apiKeyEnv} in environment`);
    headers.authorization = `Bearer ${key}`;
  }
  const upstream_url = `${String(profile.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const upstream_body = JSON.stringify({ ...client_body, model: upstream_model });
  let upstream_res;
  try {
    upstream_res = await fetch(upstream_url, { method: "POST", headers, body: upstream_body });
  } catch (err) {
    const cause = err && err.cause ? err.cause.code || err.cause.message : err.message;
    throw new Error(`${profile_name}: fetch failed (${cause})`);
  }
  if (!upstream_res.ok) {
    const status = upstream_res.status;
    try {
      if (upstream_res.body) await upstream_res.body.cancel();
    } catch {}
    return { ok: false, status };
  }
  return { ok: true, status: upstream_res.status, response: upstream_res, profile_name, upstream_model };
}

function make_attempt(config, requested_profile, model_part) {
  return (name, body) => attempt_profile(config, name, requested_profile, model_part, body);
}

function make_attempt_chain(config, remaining, requested_profile, model_part) {
  const attempt = make_attempt(config, requested_profile, model_part);
  return (body, extra) =>
    withFailover(remaining, (name) => {
      if (!extra) return attempt(name, body);
      const extra_messages = Array.isArray(extra) ? extra : [extra];
      let next_body = { ...body, messages: [...(body.messages || []), ...extra_messages] };
      let next_config = config;
      if (name === "deepseek" && !Array.isArray(extra) && extra.role === "assistant") {
        next_body = {
          ...body,
          messages: [...(body.messages || []), { ...extra, prefix: true }],
        };
        next_config = {
          ...config,
          profiles: {
            ...config.profiles,
            deepseek: {
              ...config.profiles.deepseek,
              baseUrl: String(config.profiles.deepseek.baseUrl).replace(/\/v1\/?$/, "/beta"),
            },
          },
        };
      }
      return attempt_profile(next_config, name, requested_profile, model_part, next_body);
    });
}

function recovery_adapter(session) {
  if (!session || !session.ok) return null;
  return {
    id: session.recovery_id,
    record(calls, phase, winner) {
      recovery.record_emitted_calls({
        recovery_id: session.recovery_id,
        calls,
        phase,
        profile: winner && winner.profile_name,
        provider: winner && winner.profile_name,
        request_hash: session.request_hash,
      });
    },
    history(options) {
      return recovery.continuation_history(session.recovery_id, options);
    },
  };
}

function has_recovery_header(headers) {
  if (!headers) return false;
  return recovery.HEADER_NAMES.some((name) => {
    if (typeof headers.get === "function") return typeof headers.get(name) === "string" && headers.get(name).trim() !== "";
    const value = headers[name] || headers[name.toUpperCase()];
    return typeof value === "string" && value.trim() !== "";
  });
}

// Everything except content: sampling and generation settings change what the model produces,
// so they belong in the idempotency identity even though they are not part of the conversation.
const RECOVERY_CONTENT_KEYS = ["messages", "tools", "tool_config"];
function recovery_params(body) {
  if (!body || typeof body !== "object") return undefined;
  const params = {};
  for (const [key, value] of Object.entries(body)) {
    if (RECOVERY_CONTENT_KEYS.includes(key) || value === undefined) continue;
    params[key] = value;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function make_recovery_session(req, endpoint, request) {
  if (!has_recovery_header(req.headers)) return null;
  return recovery.open_session({ ...request, headers: req.headers, endpoint });
}

// Dialect payloads for an open_session contract violation. The idempotency conflict
// names both hashes and the recovery id so a client that reused a key for a different
// request sees exactly what it collided with; other codes degrade to a generic refusal.
// A missing/undefined `ok` never reaches here — the callers treat it as "continue".
function recovery_conflict_message(session) {
  if (session.code === "idempotency_key_conflict") {
    return (
      `idempotency key is already bound to a different request: recovery ${session.recovery_id}, ` +
      `existing_request_hash ${session.existing_request_hash}, request_hash ${session.request_hash}`
    );
  }
  return `recovery session refused (${session.code || "unknown_code"})`;
}

function recovery_conflict_error(session) {
  return {
    message: recovery_conflict_message(session),
    code: session.code || null,
    recovery_id: session.recovery_id ?? null,
    existing_request_hash: session.existing_request_hash ?? null,
    request_hash: session.request_hash ?? null,
  };
}

function openai_recovery_conflict(session) {
  return { error: recovery_conflict_error(session) };
}

function anthropic_recovery_conflict(session) {
  return { type: "error", error: { type: "invalid_request_error", ...recovery_conflict_error(session) } };
}

function log_completion_usage(winner, usage, recovery_id) {
  logUsage({
    ts: new Date().toISOString(),
    provider: winner.profile_name,
    model: winner.upstream_model,
    prompt_tokens: num_or_null(usage.prompt_tokens),
    completion_tokens: num_or_null(usage.completion_tokens),
    ...(recovery_id ? { recovery_id } : {}),
  });
}

function openai_error(res, err) {
  send_json(res, 502, {
    error: {
      message: "all providers failed",
      details: err.attempts || [{ profile: "unknown", error: err.message }],
    },
  });
}

async function run_stream({
  res,
  config,
  body,
  requested_profile,
  model_part,
  client,
  recovery_session,
}) {
  const default_chain = Array.isArray(config.chains && config.chains.default) ? config.chains.default : [];
  const chain = [requested_profile, ...default_chain.filter((name) => name !== requested_profile)];
  const attempt = make_attempt(config, requested_profile, model_part);

  let winner;
  try {
    winner = await withFailover(chain, (name) => attempt(name, body));
  } catch (err) {
    client.abort(err);
    return;
  }

  const content_type = winner.response.headers.get("content-type") || "application/json";
  if (!content_type.includes("json")) {
    const remaining = chain.slice(chain.indexOf(winner.profile_name) + 1);
    const chaos_match = /^midstream_drop@(\d+)$/.exec(process.env.OVERRAIL_CHAOS || "");
    await relay_stream({
      res,
      first_winner: winner,
      parsed_body: body,
      attempt_chain: make_attempt_chain(config, remaining, requested_profile, model_part),
      chaos_drop_at: chaos_match ? Number(chaos_match[1]) : null,
      client: client.make_stream_client(winner),
      recovery: recovery_adapter(recovery_session),
      on_done: (usage, provider_name, model) =>
        log_completion_usage(
          { profile_name: provider_name, upstream_model: model },
          usage,
          recovery_session && recovery_session.recovery_id,
        ),
    });
    return;
  }

  const text = await winner.response.text();
  let upstream_json;
  try {
    upstream_json = JSON.parse(text);
  } catch {
    client.abort(new Error("upstream returned non-JSON completion"));
    return;
  }
  client.complete_json(text, upstream_json, winner, recovery_session);
}

async function handle_chat_completions(req, res, config) {
  let raw;
  try {
    raw = await read_body(req);
  } catch (err) {
    if (is_body_too_large(err)) return refuse_body(req, res, openai_body_too_large(err.limit));
    throw err; // genuine stream errors keep the old 500 path
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return send_json(res, 400, { error: { message: "request body is not valid JSON" } });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof parsed.model !== "string" ||
    parsed.model === ""
  ) {
    return send_json(res, 400, {
      error: { message: 'request body must be a JSON object with a "model" field' },
    });
  }
  const { profile_name: requested_profile, model_part } = split_model(parsed.model);
  try {
    resolveProfile(config, requested_profile);
  } catch (err) {
    return send_json(res, 400, { error: { message: err.message } });
  }

  const recovery_session = make_recovery_session(req, "/v1/chat/completions", {
    profile_name: requested_profile,
    model: parsed.model,
    messages: parsed.messages,
    tools: parsed.tools,
    params: recovery_params(parsed),
  });
  // `ok === false` only ever comes from a deliberate contract violation; an absent
  // `ok` means the recovery module predates the conflict contract — continue as before.
  if (recovery_session && recovery_session.ok === false) {
    return send_json(res, 409, openai_recovery_conflict(recovery_session));
  }
  if (recovery_session) res.setHeader("x-overrail-recovery-id", recovery_session.recovery_id);

  await run_stream({
    res,
    config,
    body: parsed,
    requested_profile,
    model_part,
    recovery_session,
    client: {
      abort: (err) => openai_error(res, err),
      complete_json: (text, upstream_json, winner, session) => {
        log_completion_usage(
          winner,
          (upstream_json && upstream_json.usage) || {},
          session && session.recovery_id,
        );
        res.writeHead(200, {
          "content-type": "application/json",
          ...(session ? { "x-overrail-recovery-id": session.recovery_id } : {}),
        });
        res.end(text);
      },
      make_stream_client: (winner) =>
        create_openai_client({
          res,
          content_type: winner.response.headers.get("content-type") || "text/event-stream",
        }),
    },
  });
}

function create_anthropic_client(res, fallback_model, recovery_id) {
  const encoder = new AnthropicStreamEncoder({ model: fallback_model });
  let headers_sent = false;
  const ensure_headers = () => {
    if (headers_sent) return;
    headers_sent = true;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      ...(recovery_id ? { "x-overrail-recovery-id": recovery_id } : {}),
    });
  };
  const write_events = (events) => {
    if (events.length === 0) return;
    ensure_headers();
    res.write(events.join(""));
  };

  const client = {
    protocol: "anthropic",
    ensure_headers,
    heartbeat: () => {
      ensure_headers();
      res.write(": keep-alive\n\n");
    },
    forward: ({ chunk }) => write_events(encoder.feed(chunk)),
    finish: ({ finish_reason, usage, base }) => {
      if (encoder.done) return;
      const final_chunk = {
        id: base ? base.id : "chatcmpl-overrail-anthropic",
        object: "chat.completion.chunk",
        created: base ? base.created : Math.floor(Date.now() / 1000),
        model: base ? base.model : fallback_model,
        choices: [{ index: 0, delta: {}, finish_reason: finish_reason || "stop" }],
        usage: usage.usage,
      };
      write_events(encoder.feed(final_chunk));
    },
    complete: () => {
      if (!encoder.done) write_events(encoder.terminate());
      else ensure_headers();
      res.end();
    },
    abort: (err) => {
      if (!headers_sent) {
        const status = err && err.status === 400 ? 400 : 502;
        const type = status === 400 ? "invalid_request_error" : "api_error";
        const payload = {
          type: "error",
          error: { type, message: err.message || "upstream failed" },
        };
        if (Array.isArray(err.attempts)) payload.error.attempts = err.attempts;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      if (!encoder.done) write_events(encoder.terminate());
      res.end();
    },
    complete_json: (text, upstream_json, winner, recovery_session) => {
      let anthropic_json;
      try {
        anthropic_json = openai_to_anthropic_response(upstream_json, winner.upstream_model);
      } catch (err) {
        const failure = new AnthropicTranslateError(err.message || "upstream response could not be translated", 502);
        res.writeHead(failure.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: failure.message } }));
        return;
      }
      log_completion_usage(
        winner,
        {
          prompt_tokens: anthropic_json.usage.input_tokens,
          completion_tokens: anthropic_json.usage.output_tokens,
        },
        recovery_session && recovery_session.recovery_id,
      );
      res.writeHead(200, {
        "content-type": "application/json",
        ...(recovery_session ? { "x-overrail-recovery-id": recovery_session.recovery_id } : {}),
      });
      res.end(JSON.stringify(anthropic_json));
    },
    make_stream_client: () => client,
  };
  return client;
}

async function handle_anthropic_messages(req, res, config) {
  let raw;
  try {
    raw = await read_body(req);
  } catch (err) {
    if (is_body_too_large(err)) return refuse_body(req, res, anthropic_body_too_large(err.limit));
    throw err; // genuine stream errors keep the old 500 path
  }
  let anthropic_body;
  try {
    anthropic_body = JSON.parse(raw);
  } catch {
    return send_json(res, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: "request body is not valid JSON" },
    });
  }

  let body;
  try {
    body = anthropic_messages_to_openai(anthropic_body);
  } catch (err) {
    const status = err instanceof AnthropicTranslateError ? err.status : 400;
    return send_json(res, status, {
      type: "error",
      error: { type: status === 400 ? "invalid_request_error" : "api_error", message: err.message },
    });
  }
  if (typeof body.model !== "string" || body.model === "") {
    return send_json(res, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: 'the Anthropic "model" field is required' },
    });
  }
  const { profile_name: requested_profile, model_part } = split_model(body.model);
  try {
    resolveProfile(config, requested_profile);
  } catch (err) {
    return send_json(res, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: err.message },
    });
  }

  const recovery_session = make_recovery_session(req, "/v1/messages", {
    profile_name: requested_profile,
    model: body.model,
    messages: body.messages,
    tools: body.tools,
    params: recovery_params(body),
  });
  // same defensive rule as the OpenAI route: only an explicit ok:false conflicts
  if (recovery_session && recovery_session.ok === false) {
    return send_json(res, 409, anthropic_recovery_conflict(recovery_session));
  }
  if (recovery_session) res.setHeader("x-overrail-recovery-id", recovery_session.recovery_id);

  await run_stream({
    res,
    config,
    body,
    requested_profile,
    model_part,
    recovery_session,
    client: create_anthropic_client(res, body.model, recovery_session && recovery_session.recovery_id),
  });
}

function handle_models(res, config) {
  const data = Object.entries(config.profiles || {}).map(([name, profile]) => ({
    id: name,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: (profile && profile.label) || name,
  }));
  send_json(res, 200, { object: "list", data });
}

async function handle_request(req, res, config) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/v1/models") return handle_models(res, config);
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    return handle_chat_completions(req, res, config);
  }
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    return handle_anthropic_messages(req, res, config);
  }
  const ack = recovery.match_recovery_ack(url.pathname);
  if (ack && req.method === "POST") return recovery.handle_recovery_ack(req, res, ack.recovery_id);
  send_json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
}

function createGateway({ config }) {
  return http.createServer((req, res) => {
    res.on("error", () => {});
    handle_request(req, res, config).catch((err) => {
      if (!res.headersSent) {
        send_json(res, 500, { error: { message: err && err.message ? err.message : "gateway error" } });
      } else {
        res.destroy();
      }
    });
  });
}

module.exports = { createGateway, DEFAULT_MODELS };
