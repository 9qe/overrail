const http = require("node:http");

const { resolveProfile } = require("./config");
const { withFailover } = require("./failover");
const { logUsage } = require("./usage");
const { relay_stream } = require("./stream-relay");

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

function read_body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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
  // chaos flag: first upstream attempt of the process returns a synthetic 529
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
    // cancel the unread body so the socket is released before the next attempt
    try {
      if (upstream_res.body) await upstream_res.body.cancel();
    } catch {}
    return { ok: false, status };
  }
  return { ok: true, status: upstream_res.status, response: upstream_res, profile_name, upstream_model };
}

async function handle_chat_completions(req, res, config) {
  const raw = await read_body(req);
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
  const default_chain = config.chains && Array.isArray(config.chains.default) ? config.chains.default : [];
  const chain = [requested_profile, ...default_chain.filter((name) => name !== requested_profile)];

  let winner;
  try {
    winner = await withFailover(chain, (name) =>
      attempt_profile(config, name, requested_profile, model_part, parsed)
    );
  } catch (err) {
    return send_json(res, 502, {
      error: {
        message: "all providers failed",
        details: err.attempts || [{ profile: requested_profile, error: err.message }],
      },
    });
  }

  const upstream_res = winner.response;
  const content_type = upstream_res.headers.get("content-type") || "application/json";
  if (content_type.includes("json")) {
    // non-stream JSON: buffer only here, so usage can be captured before forwarding
    const text = await upstream_res.text();
    try {
      const upstream_json = JSON.parse(text);
      const usage = (upstream_json && upstream_json.usage) || {};
      logUsage({
        ts: new Date().toISOString(),
        provider: winner.profile_name,
        model: winner.upstream_model,
        prompt_tokens: num_or_null(usage.prompt_tokens),
        completion_tokens: num_or_null(usage.completion_tokens),
      });
    } catch {}
    res.writeHead(upstream_res.status, { "content-type": content_type });
    res.end(text);
    return;
  }
  const remaining = chain.slice(chain.indexOf(winner.profile_name) + 1);
  const attempt_chain = (body, extra) =>
    withFailover(remaining, (name) => {
      if (!extra) return attempt_profile(config, name, requested_profile, model_part, body);
      const extra_messages = Array.isArray(extra) ? extra : [extra];
      let next_body = { ...body, messages: [...body.messages, ...extra_messages] };
      let next_config = config;
      // DeepSeek only honors assistant prefill as an explicit prefix on its beta endpoint
      if (name === "deepseek" && !Array.isArray(extra) && extra.role === "assistant") {
        next_body = {
          ...body,
          messages: [...body.messages, { ...extra, prefix: true }],
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
  const chaos_match = /^midstream_drop@(\d+)$/.exec(process.env.OVERRAIL_CHAOS || "");
  await relay_stream({
    res,
    first_winner: winner,
    parsed_body: parsed,
    attempt_chain,
    chaos_drop_at: chaos_match ? Number(chaos_match[1]) : null,
    on_done: (usage, provider_name, model) => {
      logUsage({
        ts: new Date().toISOString(),
        provider: provider_name,
        model,
        prompt_tokens: num_or_null(usage.prompt_tokens),
        completion_tokens: num_or_null(usage.completion_tokens),
      });
    },
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
  send_json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
}

// createGateway never binds by itself — the CLI must call server.listen(port, "127.0.0.1") so the gateway is loopback-only.
function createGateway({ config }) {
  return http.createServer((req, res) => {
    res.on("error", () => {}); // client aborts mid-response must not crash the server
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
