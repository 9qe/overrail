const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-anthropic-gateway-"));
os.homedir = () => tmp_dir;

const { createGateway } = require("../lib/gateway");
const { buildDefaultConfig } = require("../lib/config-defaults");
const { parse_anthropic_sse } = require("../lib/anthropic");

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
  delete process.env.OVERRAIL_CHAOS;
  for (const server of created) await close(server);
  os.homedir = real_homedir;
  fs.rmSync(tmp_dir, { recursive: true, force: true });
});

async function gateway_for(primary, backup) {
  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${primary.address().port}/v1`;
  if (backup) config.profiles.kimi.baseUrl = `http://127.0.0.1:${backup.address().port}/v1`;
  config.chains.default = backup ? ["deepseek", "kimi"] : ["deepseek"];
  const gateway = await listen(createGateway({ config }));
  created.push(gateway);
  return `http://127.0.0.1:${gateway.address().port}/v1/messages`;
}

function sse_chunk(id, delta, extra = {}) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;
}

function collect_body(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
  });
}

test("POST /v1/messages translates Anthropic JSON through the gateway", async () => {
  let upstream_body = null;
  const upstream = await listen(
    http.createServer(async (req, res) => {
      upstream_body = JSON.parse(await collect_body(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-msg1",
          model: "deepseek-chat",
          choices: [{ index: 0, message: { role: "assistant", content: "hello from deepseek" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 4 },
        })
      );
    })
  );
  created.push(upstream);

  const res = await fetch(await gateway_for(upstream, null), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek",
      max_tokens: 64,
      system: "Answer briefly.",
      messages: [{ role: "user", content: "greet me" }],
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.type, "message");
  assert.equal(json.content[0].text, "hello from deepseek");
  assert.equal(json.stop_reason, "end_turn");
  assert.deepEqual(json.usage, { input_tokens: 11, output_tokens: 4 });
  assert.equal(upstream_body.messages[0].role, "system");
  assert.equal(upstream_body.model, "deepseek-chat");
});

test("POST /v1/messages stitches a real provider drop through the backup", async () => {
  const primary = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("a1", { content: "half a " }));
      setTimeout(() => res.destroy(), 20);
    })
  );
  let backup_body = null;
  const backup = await listen(
    http.createServer(async (req, res) => {
      backup_body = JSON.parse(await collect_body(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("b1", { content: "sentence" }));
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(primary, backup);

  const res = await fetch(await gateway_for(primary, backup), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek", max_tokens: 64, stream: true, messages: [{ role: "user", content: "go" }] }),
  });
  assert.equal(res.status, 200);
  const events = parse_anthropic_sse(await res.text());
  const text = events
    .filter((event) => event.data.type === "content_block_delta" && event.data.delta.type === "text_delta")
    .map((event) => event.data.delta.text)
    .join("");
  assert.equal(text, "half a sentence");
  assert.deepEqual(backup_body.messages[backup_body.messages.length - 1], { role: "assistant", content: "half a " });
});

test("POST /v1/messages streams a buffered tool call as Anthropic tool_use", async () => {
  const upstream = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("t1", { content: "checking" }));
      res.write(
        sse_chunk("t1", {
          tool_calls: [{ index: 0, id: "call_msg", function: { name: "lookup", arguments: '{"q":"x"}' } }],
        })
      );
      res.write(sse_chunk("t1", {}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(upstream);

  const res = await fetch(await gateway_for(upstream, null), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "lookup x" }],
      tools: [{ name: "lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    }),
  });
  const events = parse_anthropic_sse(await res.text());
  const blocks = events.filter((event) => event.data.type === "content_block_start").map((event) => event.data.content_block.type);
  assert.deepEqual(blocks, ["text", "tool_use"]);
  const json = events
    .filter((event) => event.data.delta && event.data.delta.type === "input_json_delta")
    .map((event) => event.data.delta.partial_json)
    .join("");
  assert.equal(json, '{"q":"x"}');
  assert.equal(events.find((event) => event.data.type === "message_delta").data.delta.stop_reason, "tool_use");
});
