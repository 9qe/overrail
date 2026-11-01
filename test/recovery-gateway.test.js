const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-recovery-gateway-"));
os.homedir = () => tmp_dir;

const { createGateway } = require("../lib/gateway");
const { buildDefaultConfig } = require("../lib/config-defaults");
const { parse_anthropic_sse } = require("../lib/anthropic");
const { load_state } = require("../lib/recovery");

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
});

after(async () => {
  delete process.env.DEEPSEEK_API_KEY;
  for (const server of created) await close(server);
  os.homedir = real_homedir;
  fs.rmSync(tmp_dir, { recursive: true, force: true });
});

test("an opt-in recovery key records emitted tool calls and accepts an idempotent ack", async () => {
  const upstream = await listen(
    http.createServer(async (req, res) => {
      await new Promise((resolve) => {
        req.on("data", () => {});
        req.on("end", resolve);
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "call-stream",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: "call_unique", function: { name: "lookup", arguments: '{"q":"x"}' } }],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    })
  );
  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config.chains.default = ["deepseek"];
  const gateway = await listen(createGateway({ config }));
  created.push(upstream, gateway);
  const base = `http://127.0.0.1:${gateway.address().port}`;

  const stream_response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "gateway-recovery-test",
    },
    body: JSON.stringify({ model: "deepseek", stream: true, messages: [{ role: "user", content: "lookup" }] }),
  });
  assert.equal(stream_response.status, 200);
  await stream_response.text();
  const recovery_id = stream_response.headers.get("x-overrail-recovery-id");
  assert.match(recovery_id, /^[a-f0-9]{64}$/);
  assert.equal(load_state(recovery_id).calls.call_unique.status, "offered");

  const ack_url = `${base}/v1/recovery/${recovery_id}/ack`;
  const first_ack = await fetch(ack_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_call_id: "call_unique" }),
  });
  const first_json = await first_ack.json();
  assert.equal(first_json.status, "acknowledged");
  assert.equal(first_json.replay, false);
  const second_ack = await fetch(ack_url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_call_id: "call_unique" }),
  });
  assert.equal((await second_ack.json()).replay, true);
  assert.equal(load_state(recovery_id).calls.call_unique.status, "acknowledged");
});

test("Anthropic tool_use streams expose the same opt-in recovery identity", async () => {
  const upstream = await listen(
    http.createServer(async (req, res) => {
      await new Promise((resolve) => {
        req.on("data", () => {});
        req.on("end", resolve);
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "anthropic-call",
          object: "chat.completion.chunk",
          created: 1,
          model: "deepseek-chat",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: "call_anthropic", function: { name: "lookup", arguments: '{"q":"x"}' } }],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    })
  );
  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  config.chains.default = ["deepseek"];
  const gateway = await listen(createGateway({ config }));
  created.push(upstream, gateway);

  const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "anthropic-recovery-test",
    },
    body: JSON.stringify({
      model: "deepseek",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "lookup" }],
      tools: [{ name: "lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    }),
  });
  assert.equal(response.status, 200);
  const recovery_id = response.headers.get("x-overrail-recovery-id");
  assert.match(recovery_id, /^[a-f0-9]{64}$/);
  const events = parse_anthropic_sse(await response.text());
  assert.ok(events.some((event) => event.data.type === "content_block_start" && event.data.content_block.id === "call_anthropic"));
  assert.equal(load_state(recovery_id).calls.call_anthropic.status, "offered");
});
