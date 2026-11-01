const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrouter-gateway-"));
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
