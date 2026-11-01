const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-gateway-"));
os.homedir = () => tmp_dir;

const { createGateway } = require("../lib/gateway");
const { buildDefaultConfig } = require("../lib/config-defaults");
const { USAGE_PATH } = require("../lib/config");

const created = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

before(() => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.MOONSHOT_API_KEY = "test-key-moonshot";
});

after(async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  for (const server of created) await close(server);
  os.homedir = real_homedir;
  fs.rmSync(tmp_dir, { recursive: true, force: true });
});

test("POST /v1/chat/completions proxies, injects auth, and logs usage", async () => {
  const hits = [];
  const upstream = await listen(
    http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        let model = null;
        try {
          model = JSON.parse(raw).model;
        } catch {
          model = null;
        }
        hits.push({ auth: req.headers.authorization || null, model });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            model: "deepseek-chat",
            usage: { prompt_tokens: 5, completion_tokens: 7 },
          })
        );
      });
    })
  );
  created.push(upstream);

  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config.chains.default = ["deepseek"];
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  const gw_url = `http://127.0.0.1:${gw.address().port}`;

  const malformed = await fetch(`${gw_url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(malformed.status, 400);

  const res = await fetch(`${gw_url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.usage.prompt_tokens, 5);
  assert.equal(body.usage.completion_tokens, 7);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].auth, "Bearer test-key");
  assert.equal(hits[0].model, "deepseek-chat");

  const lines = fs.readFileSync(USAGE_PATH, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.provider, "deepseek");
  assert.equal(entry.model, "deepseek-chat");
  assert.equal(entry.prompt_tokens, 5);
  assert.equal(entry.completion_tokens, 7);
  assert.equal(typeof entry.ts, "string");
});

test("GET /v1/models lists one entry per configured profile", async () => {
  const config = buildDefaultConfig();
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  const res = await fetch(`http://127.0.0.1:${gw.address().port}/v1/models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "list");
  assert.deepEqual(body.data.map((m) => m.id), ["deepseek", "kimi", "openrouter", "ollama"]);
  const by_id = Object.fromEntries(body.data.map((m) => [m.id, m]));
  assert.equal(by_id.deepseek.owned_by, "DeepSeek");
  assert.equal(by_id.openrouter.owned_by, "OpenRouter");
  assert.equal(by_id.ollama.owned_by, "Ollama (local, no key)");
});

test("failover moves down the chain and reports attempts", async () => {
  let dead_hits = 0;
  const dead = await listen(
    http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        dead_hits += 1;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "dead upstream" } }));
      });
    })
  );
  let flaky_hits = 0;
  const flaky = await listen(
    http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        flaky_hits += 1;
        if (flaky_hits === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "flaky first hit" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-2",
            object: "chat.completion",
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          })
        );
      });
    })
  );
  created.push(dead, flaky);

  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${dead.address().port}/v1`;
  config.profiles.kimi.baseUrl = `http://127.0.0.1:${flaky.address().port}/v1`;
  config.chains.default = ["deepseek", "kimi"];
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  const url = `http://127.0.0.1:${gw.address().port}/v1/chat/completions`;
  const post = () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "hi" }] }),
    });

  const first = await post();
  assert.equal(first.status, 502);
  const first_body = await first.json();
  assert.equal(first_body.error.message, "all providers failed");
  assert.deepEqual(first_body.error.details.map((d) => d.profile), ["deepseek", "kimi"]);

  const second = await post();
  assert.equal(second.status, 200);
  const second_body = await second.json();
  assert.equal(second_body.object, "chat.completion");
  assert.equal(second_body.usage.prompt_tokens, 2);
  assert.equal(dead_hits, 2);
  assert.equal(flaky_hits, 2);

  const usage_lines = fs.readFileSync(USAGE_PATH, "utf8").trim().split("\n");
  const last = JSON.parse(usage_lines[usage_lines.length - 1]);
  assert.equal(last.provider, "kimi");
  assert.equal(last.model, "kimi-k2");
});

test("streaming responses pipe through untouched", async () => {
  const chunks = ['data: {"id":"1"}\n\n', "data: [DONE]\n\n"];
  const upstream = await listen(
    http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunks[0]);
        setTimeout(() => {
          res.write(chunks[1]);
          res.end();
        }, 20);
      });
    })
  );
  created.push(upstream);

  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config.chains.default = ["deepseek"];
  const gw = await listen(createGateway({ config }));
  created.push(gw);

  const res = await fetch(`http://127.0.0.1:${gw.address().port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), chunks.join(""));
});

test("unknown paths return 404 JSON", async () => {
  const config = buildDefaultConfig();
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  const res = await fetch(`http://127.0.0.1:${gw.address().port}/v1/definitely-not-here`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.error && typeof body.error.message === "string");
});

function raw_chat_post(port, { headers = {}, chunks = [], send_body = true }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          settled = true;
          resolve({ status: res.statusCode, raw });
          request.destroy();
        });
      }
    );
    // writes queued before the gateway refuses the body may EPIPE once it destroys
    // the socket — only a pre-response error is a failed test
    request.on("error", (err) => {
      if (!settled) reject(err);
    });
    for (const chunk of chunks) request.write(chunk);
    if (send_body) request.end();
  });
}

test("oversized body on /v1/chat/completions gets 413 with an OpenAI-shaped error", { timeout: 10000 }, async () => {
  const config = buildDefaultConfig();
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  process.env.OVERRAIL_MAX_BODY_BYTES = "256";
  try {
    const res = await fetch(`http://127.0.0.1:${gw.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "x".repeat(4096) }] }),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    // field-by-field: exact message with the real limit, OpenAI error dialect
    assert.deepEqual(body, {
      error: {
        message: "request body exceeds the 256-byte limit (raise with OVERRAIL_MAX_BODY_BYTES)",
        type: "invalid_request_error",
        code: "request_too_large",
        param: null,
      },
    });
  } finally {
    delete process.env.OVERRAIL_MAX_BODY_BYTES;
  }
});

test("an oversized content-length is refused before any body byte is read", { timeout: 10000 }, async () => {
  const config = buildDefaultConfig();
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  process.env.OVERRAIL_MAX_BODY_BYTES = "256";
  try {
    // declare 70000 bytes and send only 2 — the running total never crosses the
    // 256-byte cap, so a 413 can only come from the content-length precheck
    const { status, raw } = await raw_chat_post(gw.address().port, {
      headers: { "content-length": "70000" },
      chunks: ["{}"],
    });
    assert.equal(status, 413);
    assert.equal(
      raw,
      JSON.stringify({
        error: {
          message: "request body exceeds the 256-byte limit (raise with OVERRAIL_MAX_BODY_BYTES)",
          type: "invalid_request_error",
          code: "request_too_large",
          param: null,
        },
      })
    );
  } finally {
    delete process.env.OVERRAIL_MAX_BODY_BYTES;
  }
});

test("a chunked body that crosses the cap mid-stream is refused with 413", { timeout: 10000 }, async () => {
  const config = buildDefaultConfig();
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  process.env.OVERRAIL_MAX_BODY_BYTES = "256";
  try {
    // no content-length header — chunked upload forces the running-total path
    const payload = JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "y".repeat(2048) }] });
    const pieces = [];
    for (let i = 0; i < payload.length; i += 64) pieces.push(payload.slice(i, i + 64));
    const { status } = await raw_chat_post(gw.address().port, { chunks: pieces });
    assert.equal(status, 413);
  } finally {
    delete process.env.OVERRAIL_MAX_BODY_BYTES;
  }
});

test("a body just under the limit completes normally with 200", { timeout: 10000 }, async () => {
  const upstream = await listen(
    http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-under",
            object: "chat.completion",
            model: "deepseek-chat",
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        );
      });
    })
  );
  created.push(upstream);

  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config.chains.default = ["deepseek"];
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  process.env.OVERRAIL_MAX_BODY_BYTES = "512";
  try {
    const payload = JSON.stringify({
      model: "deepseek",
      messages: [{ role: "user", content: "z".repeat(360) }],
    });
    assert.ok(Buffer.byteLength(payload) <= 512 && Buffer.byteLength(payload) >= 400);
    const res = await fetch(`http://127.0.0.1:${gw.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
  } finally {
    delete process.env.OVERRAIL_MAX_BODY_BYTES;
  }
});

test("an oversized malformed body answers 413, not 400 — size is checked first", { timeout: 10000 }, async () => {
  const config = buildDefaultConfig();
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  process.env.OVERRAIL_MAX_BODY_BYTES = "256";
  try {
    const res = await fetch(`http://127.0.0.1:${gw.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{not json at all ${"w".repeat(4096)}`,
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, "request_too_large");
  } finally {
    delete process.env.OVERRAIL_MAX_BODY_BYTES;
  }
});

test("a reused idempotency key on /v1/chat/completions answers 409 naming both hashes", { timeout: 10000 }, async () => {
  let upstream_hits = 0;
  const upstream = await listen(
    http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        upstream_hits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-conflict",
            object: "chat.completion",
            model: "deepseek-chat",
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        );
      });
    })
  );
  created.push(upstream);

  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config.chains.default = ["deepseek"];
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  const url = `http://127.0.0.1:${gw.address().port}/v1/chat/completions`;
  const post = (content) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "gateway-openai-conflict-key" },
      body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content }] }),
    });

  const first = await post("first leg");
  assert.equal(first.status, 200);
  const recovery_id = first.headers.get("x-overrail-recovery-id");
  assert.match(recovery_id, /^[a-f0-9]{64}$/);

  const second = await post("second leg");
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.error.code, "idempotency_key_conflict");
  assert.equal(body.error.recovery_id, recovery_id);
  assert.match(body.error.existing_request_hash, /^[a-f0-9]{64}$/);
  assert.match(body.error.request_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(body.error.existing_request_hash, body.error.request_hash);
  // the message itself carries the recovery id and both hashes
  assert.ok(body.error.message.includes(recovery_id));
  assert.ok(body.error.message.includes(body.error.existing_request_hash));
  assert.ok(body.error.message.includes(body.error.request_hash));
  assert.equal(upstream_hits, 1); // the conflicting request never reached an upstream
});

