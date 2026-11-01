// Opt-in LIVE provider matrix: DeepSeek, Moonshot/Kimi, OpenRouter, Ollama.
// Sends real paid traffic ONLY when keys are present in the documented env vars.
// Keys are read from process.env, sent only in Authorization headers, and never
// printed, logged, or persisted — every recorded string passes through scrub().
//
// Run:  node examples/live-provider-matrix.js
//       node examples/live-provider-matrix.js --providers deepseek,ollama --out docs/provider-matrix-results.json
// Env:  DEEPSEEK_API_KEY | MOONSHOT_API_KEY | OPENROUTER_API_KEY (Ollama needs none)
//       OVERRAIL_MATRIX_<PROVIDER>_MODEL  e.g. OVERRAIL_MATRIX_KIMI=kimi-k2-0711-preview
//       OVERRAIL_MATRIX_RATELIMIT=1       opt into the burst case (10 parallel requests)
// Exit: 0 evidence collected · 1 FAILs observed on a live provider · 2 no funded provider ran (no evidence)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-matrix-"));
os.homedir = () => tmp_dir; // keep gateway usage logs out of the real home

const { createGateway } = require("../lib/gateway");
const { buildDefaultConfig } = require("../lib/config-defaults");
const { PRESETS } = require("../lib/providers");
const { USAGE_PATH } = require("../lib/config");

const KEY_ENV = { deepseek: "DEEPSEEK_API_KEY", kimi: "MOONSHOT_API_KEY", openrouter: "OPENROUTER_API_KEY", ollama: null };
const ALL_PROVIDERS = ["deepseek", "kimi", "openrouter", "ollama"];

const argv = process.argv.slice(2);
function arg_value(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}
const providers = (arg_value("--providers") || ALL_PROVIDERS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
for (const p of providers) {
  if (!ALL_PROVIDERS.includes(p)) {
    console.error(`unknown provider "${p}" — known: ${ALL_PROVIDERS.join(", ")}`);
    process.exit(1);
  }
}
const out_path = arg_value("--out") || path.join("docs", "provider-matrix-results.json");
const RATELIMIT = process.env.OVERRAIL_MATRIX_RATELIMIT === "1";

// ---- secret scrubbing ----
const SECRET_VALUES = Object.values(KEY_ENV)
  .map((env_name) => (env_name ? process.env[env_name] : null))
  .filter((v) => typeof v === "string" && v.length >= 6);
function scrub(text) {
  let out = String(text == null ? "" : text);
  for (const secret of SECRET_VALUES) out = out.split(secret).join("[REDACTED-KEY]");
  out = out.replace(/sk-[A-Za-z0-9._-]{6,}/g, "[REDACTED-KEY]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]{6,}/gi, "Bearer [REDACTED-KEY]");
  return out.slice(0, 240);
}

// ---- classification ----
function classify_fetch_error(err) {
  const msg = scrub((err && err.message) || String(err));
  if (/AbortError|timeout/i.test(msg)) return { status: "FAIL", classification: "client-timeout", detail: msg };
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|fetch failed|socket/i.test(msg))
    return { status: "SKIP-UNREACHABLE", classification: "network-unreachable", detail: msg };
  return { status: "FAIL", classification: "transport-error", detail: msg };
}
function classify_http(status, body_snippet) {
  const low = String(body_snippet || "").toLowerCase();
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return { status: "FAIL", classification: "auth-rejected", detail: `http ${status}` };
  if (status === 402 || /insufficient|quota|balance|billing|credits|payment required|top.?up|arrears|exceeded_current/.test(low))
    return { status: "SKIP-UNFUNDED", classification: `http ${status} billing signal`, detail: scrub(body_snippet) };
  // the gateway wraps dead upstreams as 502 "all providers failed" — classify by the attempt detail
  if (status === 502 && /econnrefused|enotfound|eai_again|ehostunreach|fetch failed/i.test(low))
    return { status: "SKIP-UNREACHABLE", classification: "network-unreachable (gateway-wrapped)", detail: scrub(body_snippet) };
  if (status === 502) {
    // unwrap the real provider status from the gateway's attempt details ("http 401", "status 429", ...)
    const inner = low.match(/(?:http |status )(\d{3})/);
    if (inner) {
      const inner_status = Number(inner[1]);
      if (inner_status >= 200 && inner_status < 300) return { status: "FAIL", classification: "gateway-chain-exhausted", detail: scrub(body_snippet) };
      if (inner_status === 502) return { status: "FAIL", classification: "upstream-http-502 (gateway-wrapped)", detail: scrub(body_snippet) };
      const unwrapped = classify_http(inner_status, body_snippet);
      if (unwrapped) return { ...unwrapped, classification: `${unwrapped.classification} (gateway-wrapped ${inner_status})`, detail: scrub(body_snippet) };
    }
    return { status: "FAIL", classification: "gateway-chain-exhausted", detail: scrub(body_snippet) };
  }
  if (status === 429 || (status === 502 && /http 429/.test(low)))
    return { status: "FAIL", classification: "rate-limited-unexpectedly", detail: status === 502 ? "gateway chain exhausted on http 429" : "http 429" };
  if (status === 404 && /model|not found/.test(low))
    return { status: "FAIL", classification: "model-not-found (try OVERRAIL_MATRIX_<PROVIDER>_MODEL)", detail: scrub(body_snippet) };
  if (status >= 500) return { status: "FAIL", classification: `upstream-http-${status}`, detail: scrub(body_snippet) };
  return { status: "FAIL", classification: `http-${status}`, detail: scrub(body_snippet) };
}

async function timed_fetch(url, options, timeout_ms) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout_ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return { res, latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function model_for(provider) {
  const override = process.env[`OVERRAIL_MATRIX_${provider.toUpperCase()}_MODEL`];
  return override ? `${provider}/${override}` : provider;
}

const gateway_usage_entries = () => {
  try {
    return fs
      .readFileSync(USAGE_PATH, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

function sse_summary(text) {
  let content = "";
  let dones = 0;
  let tool_names = [];
  let unparsed = 0;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    if (!lines.length) continue;
    const payload = lines.map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (payload.trim() === "[DONE]") {
      dones += 1;
      continue;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      unparsed += 1;
      continue;
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    const delta = (choice && choice.delta) || {};
    if (typeof delta.content === "string") content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const c of delta.tool_calls) if (c.function && c.function.name) tool_names.push(c.function.name);
    }
  }
  return { content, dones, tool_names: [...new Set(tool_names)], unparsed };
}

// ---- cases ----
async function case_models_probe(P) {
  const headers = {};
  if (P.apiKeyEnv && process.env[P.apiKeyEnv]) headers.authorization = `Bearer ${process.env[P.apiKeyEnv]}`;
  for (const [k, v] of Object.entries(P.headers || {})) headers[k] = v;
  const base = String(P.baseUrl).replace(/\/+$/, "");
  let r;
  try {
    r = await timed_fetch(`${base}/models`, { headers }, 20000);
  } catch (err) {
    return { case: "models-probe", ...classify_fetch_error(err), latency_ms: 0 };
  }
  const body = await r.res.text().catch(() => "");
  const bad = classify_http(r.res.status, body);
  if (bad) return { case: "models-probe", http_status: r.res.status, ...bad, latency_ms: r.latency_ms };
  let count = null;
  try {
    const j = JSON.parse(body);
    count = Array.isArray(j.data) ? j.data.length : Array.isArray(j.models) ? j.models.length : null;
  } catch {}
  return { case: "models-probe", status: "PASS", http_status: r.res.status, classification: null, latency_ms: r.latency_ms, detail: count === null ? "list returned" : `${count} models listed` };
}

async function case_non_stream(gw_url, provider) {
  const started = Date.now();
  try {
    const { res, latency_ms } = await timed_fetch(
      gw_url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model_for(provider),
          messages: [{ role: "user", content: "Reply with exactly: PONG" }],
          max_tokens: 16,
          temperature: 0,
        }),
      },
      90000
    );
    const body = await res.text();
    const bad = classify_http(res.status, body);
    if (bad) return { case: "non-stream", http_status: res.status, ...bad, latency_ms };
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      return { case: "non-stream", http_status: res.status, status: "FAIL", classification: "non-json-body", detail: scrub(body), latency_ms };
    }
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const content = typeof msg.content === "string" ? msg.content : "";
    const ok = content.length > 0 || Array.isArray(msg.tool_calls);
    return {
      case: "non-stream",
      status: ok ? "PASS" : "FAIL",
      http_status: res.status,
      classification: ok ? null : "empty-completion",
      latency_ms,
      detail: ok ? `${content.length} chars${/PONG/.test(content) ? ", echoed PONG" : ""}` : "no content",
      usage: j.usage || null,
    };
  } catch (err) {
    return { case: "non-stream", ...classify_fetch_error(err), latency_ms: Date.now() - started };
  }
}

async function case_stream(gw_url, provider) {
  const started = Date.now();
  try {
    const { res, latency_ms } = await timed_fetch(
      gw_url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model_for(provider),
          stream: true,
          messages: [{ role: "user", content: "Count from one to five, comma separated." }],
          max_tokens: 32,
          temperature: 0,
        }),
      },
      120000
    );
    const body = await res.text();
    const bad = classify_http(res.status, body);
    if (bad) return { case: "stream", http_status: res.status, ...bad, latency_ms };
    const s = sse_summary(body);
    const ok = s.content.length > 0 && s.dones === 1 && s.unparsed === 0;
    return {
      case: "stream",
      status: ok ? "PASS" : "FAIL",
      http_status: res.status,
      classification: ok ? null : `content=${s.content.length}B dones=${s.dones} unparsed=${s.unparsed}`,
      latency_ms,
      detail: ok ? `${s.content.length} chars streamed, one [DONE]` : "stream contract broken",
    };
  } catch (err) {
    return { case: "stream", ...classify_fetch_error(err), latency_ms: Date.now() - started };
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Report the current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

async function case_tool_call(gw_url, provider) {
  const started = Date.now();
  try {
    const { res, latency_ms } = await timed_fetch(
      gw_url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model_for(provider),
          stream: true,
          messages: [{ role: "user", content: "You MUST call the get_weather function for Paris. Do not answer in prose." }],
          tools: TOOLS,
          tool_choice: "auto",
          max_tokens: 64,
          temperature: 0,
        }),
      },
      120000
    );
    const body = await res.text();
    const bad = classify_http(res.status, body);
    if (bad) return { case: "tool-call", http_status: res.status, ...bad, latency_ms };
    const s = sse_summary(body);
    const ok = s.tool_names.includes("get_weather") && s.dones === 1;
    return {
      case: "tool-call",
      status: ok ? "PASS" : "FAIL",
      http_status: res.status,
      classification: ok ? null : s.dones === 1 ? "no-tool-call-emitted (model or API capability)" : "stream-contract",
      latency_ms,
      detail: ok ? `tool: ${s.tool_names.join(",")}` : `names=[${s.tool_names.join(",")}] dones=${s.dones}`,
    };
  } catch (err) {
    return { case: "tool-call", ...classify_fetch_error(err), latency_ms: Date.now() - started };
  }
}

function case_malformed_upstream() {
  return {
    case: "malformed-upstream",
    status: "SKIP",
    classification: "not-applicable",
    latency_ms: 0,
    detail: "cannot inject malformed SSE frames at a real provider; covered locally by test/edge-stream.test.js",
  };
}

async function case_rate_limit(gw_url, provider) {
  if (!RATELIMIT)
    return {
      case: "rate-limit",
      status: "SKIP",
      classification: "opt-in-only",
      latency_ms: 0,
      detail: "set OVERRAIL_MATRIX_RATELIMIT=1 to send a 10-request burst (spends quota, may hit real rate limits)",
    };
  const started = Date.now();
  const codes = {};
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        timed_fetch(
          gw_url,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: model_for(provider), messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
          },
          60000
        ).then(({ res }) => res.status)
      )
    );
    for (const c of results) codes[c] = (codes[c] || 0) + 1;
    return {
      case: "rate-limit",
      status: "PASS",
      classification: "observed",
      latency_ms: Date.now() - started,
      detail: `gateway http status histogram: ${JSON.stringify(codes)} (a 502 whose details carry http 429 means the single-provider chain exhausted on rate limit)`,
    };
  } catch (err) {
    return { case: "rate-limit", ...classify_fetch_error(err), latency_ms: Date.now() - started };
  }
}

async function case_long_context(gw_url, provider) {
  const para = "The lighthouse keeper logged the wind, the swells and the passing ships every morning before the supply boat arrived. ";
  const filler = para.repeat(430); // ~40KB ≈ 10-12k tokens
  const started = Date.now();
  try {
    const { res, latency_ms } = await timed_fetch(
      gw_url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model_for(provider),
          messages: [{ role: "user", content: `${filler}\n\nQuestion: what did the keeper log? Answer in three words.` }],
          max_tokens: 16,
          temperature: 0,
        }),
      },
      240000
    );
    const body = await res.text();
    const bad = classify_http(res.status, body);
    if (bad) return { case: "long-context", http_status: res.status, ...bad, latency_ms };
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      return { case: "long-context", http_status: res.status, status: "FAIL", classification: "non-json-body", detail: scrub(body), latency_ms };
    }
    const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    return {
      case: "long-context",
      status: content.length > 0 ? "PASS" : "FAIL",
      http_status: res.status,
      classification: content.length > 0 ? null : "empty-completion",
      latency_ms,
      detail: `~${Math.round(filler.length / 4)}k-token prompt accepted, ${content.length} chars back`,
    };
  } catch (err) {
    return { case: "long-context", ...classify_fetch_error(err), latency_ms: Date.now() - started };
  }
}

function case_usage_reconcile(provider, non_stream_result) {
  if (!non_stream_result || non_stream_result.status !== "PASS")
    return {
      case: "usage-reconcile",
      status: "SKIP",
      classification: "depends-on-non-stream",
      latency_ms: 0,
      detail: `non-stream case was ${non_stream_result ? non_stream_result.status : "not-run"}`,
    };
  const upstream = non_stream_result.usage;
  const entries = gateway_usage_entries().filter((e) => e.provider === provider);
  const last = entries[entries.length - 1];
  if (!last)
    return { case: "usage-reconcile", status: "FAIL", classification: "gateway-logged-nothing", latency_ms: 0, detail: "no usage.jsonl entry for provider" };
  if (!upstream)
    return { case: "usage-reconcile", status: "FAIL", classification: "provider-omitted-usage", latency_ms: 0, detail: `gateway logged ${JSON.stringify({ p: last.prompt_tokens, c: last.completion_tokens })} but provider body carried no usage object` };
  const match = last.prompt_tokens === (upstream.prompt_tokens ?? null) && last.completion_tokens === (upstream.completion_tokens ?? null);
  return {
    case: "usage-reconcile",
    status: match ? "PASS" : "FAIL",
    classification: match ? null : "token-mismatch",
    latency_ms: 0,
    detail: `provider ${JSON.stringify({ p: upstream.prompt_tokens ?? null, c: upstream.completion_tokens ?? null })} vs gateway ${JSON.stringify({ p: last.prompt_tokens, c: last.completion_tokens, model: last.model })}`,
  };
}

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const servers = [];
function finish(code) {
  for (const s of servers) {
    try {
      s.closeAllConnections();
      s.close();
    } catch {}
  }
  try {
    fs.rmSync(tmp_dir, { recursive: true, force: true });
  } catch {}
  // let libuv settle the closing handles before exiting (avoids the
  // UV_HANDLE_CLOSING assertion when process.exit races a close callback)
  setTimeout(() => process.exit(code), 250);
}

async function main() {
  console.log("overrail live provider matrix — real traffic, keys from env only, output sanitized\n");
  const results = [];
  const report = {
    kind: "overrail-provider-matrix",
    generated_at: new Date().toISOString(),
    node: process.version,
    opt_in_rate_limit: RATELIMIT,
    providers_present: providers,
    note: "keys are read from the environment and never written to this file; all detail strings pass through scrub()",
    results,
    summary: {},
  };

  for (const name of providers) {
    const key_env = KEY_ENV[name];
    const has_key = key_env ? Boolean(process.env[key_env]) : true;
    const preset = PRESETS[name];
    const entry = {
      provider: name,
      key_env: key_env || null, // the NAME of the env var, never its value
      key_present: has_key,
      default_model: require("../lib/gateway").DEFAULT_MODELS[name],
      cases: [],
    };
    results.push(entry);

    if (!has_key) {
      for (const c of ["models-probe", "non-stream", "stream", "tool-call", "malformed-upstream", "rate-limit", "long-context", "usage-reconcile"])
        entry.cases.push({ case: c, status: "SKIP-MISSING-KEY", classification: `set ${key_env} in the environment`, latency_ms: 0, detail: "" });
      console.log(`[${name}] SKIP-MISSING-KEY (${key_env} not set) — nothing sent to the network`);
      continue;
    }

    // gateway wired to the REAL provider base URL for this profile only
    const config = buildDefaultConfig();
    config.chains.default = [name];
    const gw = await listen(createGateway({ config }));
    const gw_url = `http://127.0.0.1:${gw.address().port}/v1/chat/completions`;
    console.log(`[${name}] running live cases through the gateway (${preset.baseUrl})`);

    const probe = await case_models_probe(preset);
    entry.cases.push(probe);
    console.log(`  models-probe     ${probe.status} (${probe.latency_ms}ms)${probe.classification ? ` ${probe.classification}` : ""}`);

    const non_stream = await case_non_stream(gw_url, name);
    entry.cases.push(non_stream);
    console.log(`  non-stream       ${non_stream.status} (${non_stream.latency_ms}ms)${non_stream.classification ? ` ${non_stream.classification}` : ""}`);

    if (
      non_stream.status === "SKIP-UNFUNDED" ||
      non_stream.status === "SKIP-UNREACHABLE" ||
      (non_stream.status === "FAIL" && /50[0234]|network|transport|auth/i.test(non_stream.classification || ""))
    ) {
      const carry = non_stream.status.startsWith("SKIP") ? non_stream.status : "SKIP";
      for (const c of ["stream", "tool-call", "rate-limit", "long-context"])
        entry.cases.push({ case: c, status: carry, classification: "blocked-by-non-stream", latency_ms: 0, detail: non_stream.classification || "" });
      entry.cases.push(case_malformed_upstream());
      entry.cases.push(case_usage_reconcile(name, non_stream));
      console.log(`  → provider ${non_stream.status.replace("SKIP-", "")}; skipping spendy cases`);
      continue;
    }

    const stream = await case_stream(gw_url, name);
    entry.cases.push(stream);
    console.log(`  stream           ${stream.status} (${stream.latency_ms}ms)${stream.classification ? ` ${stream.classification}` : ""}`);

    const tool = await case_tool_call(gw_url, name);
    entry.cases.push(tool);
    console.log(`  tool-call        ${tool.status} (${tool.latency_ms}ms)${tool.classification ? ` ${tool.classification}` : ""}`);

    entry.cases.push(case_malformed_upstream());
    console.log(`  malformed-upstream SKIP (not-applicable — covered by test/edge-stream.test.js)`);

    const rl = await case_rate_limit(gw_url, name);
    entry.cases.push(rl);
    console.log(`  rate-limit       ${rl.status}${rl.classification ? ` (${rl.classification})` : ""}`);

    const long = await case_long_context(gw_url, name);
    entry.cases.push(long);
    console.log(`  long-context     ${long.status} (${long.latency_ms}ms)${long.classification ? ` ${long.classification}` : ""}`);

    const usage = case_usage_reconcile(name, non_stream);
    entry.cases.push(usage);
    console.log(`  usage-reconcile  ${usage.status}${usage.detail ? ` — ${scrub(usage.detail)}` : ""}`);
  }

  const flat = results.flatMap((r) => r.cases);
  const pass_core = results.filter((r) => r.cases.some((c) => c.case === "non-stream" && c.status === "PASS"));
  report.summary = {
    total_cases: flat.length,
    pass: flat.filter((c) => c.status === "PASS").length,
    fail: flat.filter((c) => c.status === "FAIL").length,
    skipped: flat.filter((c) => String(c.status).startsWith("SKIP")).length,
    funded_providers: pass_core.map((r) => r.provider),
    evidence_valid: pass_core.length > 0,
  };

  fs.mkdirSync(path.dirname(out_path), { recursive: true });
  fs.writeFileSync(out_path, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nsanitized report: ${out_path}`);
  console.log(`summary: ${JSON.stringify(report.summary)}`);

  if (report.summary.evidence_valid === false) {
    console.error("\nBLOCKED: no funded+reachable provider completed the core case — the matrix proves NOTHING about live compatibility.");
    console.error("Set a real key (DEEPSEEK_API_KEY / MOONSHOT_API_KEY / OPENROUTER_API_KEY) or start Ollama locally, then re-run.");
    finish(2);
    return;
  }
  if (report.summary.fail > 0) {
    console.error(`\n${report.summary.fail} case(s) FAILED against live providers — see the report for classifications.`);
    finish(1);
    return;
  }
  finish(0);
}

main().catch((err) => {
  console.error("matrix run failed:", scrub((err && err.message) || String(err)));
  finish(1);
});
