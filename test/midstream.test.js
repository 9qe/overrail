const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-midstream-"));
os.homedir = () => tmp_dir;

const { createGateway } = require("../lib/gateway");
const { buildDefaultConfig } = require("../lib/config-defaults");

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
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
  });
}

async function gateway_for(deepseek, kimi) {
  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${deepseek.address().port}/v1`;
  if (kimi) config.profiles.kimi.baseUrl = `http://127.0.0.1:${kimi.address().port}/v1`;
  config.chains.default = kimi ? ["deepseek", "kimi"] : ["deepseek"];
  const gw = await listen(createGateway({ config }));
  created.push(gw);
  return `http://127.0.0.1:${gw.address().port}/v1/chat/completions`;
}

function post_stream(url) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
}

test("mid-stream drop stitches the next provider with assistant prefill", async () => {
  const deepseek = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("a1", { role: "assistant", content: "Hello" }));
      res.write(sse_chunk("a1", { content: " wor" }));
      setTimeout(() => res.destroy(), 20); // socket dies before [DONE]
    })
  );
  let kimi_body = null;
  const kimi = await listen(
    http.createServer(async (req, res) => {
      kimi_body = JSON.parse(await collect_body(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("b2", { content: "ld" }));
      res.end(
        `data: ${JSON.stringify({
          id: "b2",
          object: "chat.completion.chunk",
          created: 1,
          model: "kimi-k2",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        })}\n\ndata: [DONE]\n\n`
      );
    })
  );
  created.push(deepseek, kimi);

  const res = await post_stream(await gateway_for(deepseek, kimi));
  assert.equal(res.status, 200);
  const text = await res.text();

  assert.deepEqual(kimi_body.messages[kimi_body.messages.length - 1], {
    role: "assistant",
    content: "Hello wor",
  });
  assert.ok(text.includes('"content":"Hello"'));
  assert.ok(text.includes('"content":" wor"'));
  assert.ok(text.includes('"content":"ld"'));
  assert.equal(text.split("data: [DONE]").length - 1, 1);
  const final_event = text.split("data: [DONE]")[0].trim().split("\n\n").pop();
  const final_chunk = JSON.parse(final_event.replace(/^data: /, ""));
  assert.equal(final_chunk.choices[0].finish_reason, "stop");
  assert.equal(final_chunk.usage.completion_tokens, 3);
  assert.equal(final_chunk.id, "a1"); // client sees one continuous identity
});

test("OVERRAIL_CHAOS=529 fails over before contacting the primary", async () => {
  let deepseek_hits = 0;
  const deepseek = await listen(
    http.createServer(async (req, res) => {
      deepseek_hits += 1;
      await collect_body(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    })
  );
  let kimi_hits = 0;
  const kimi = await listen(
    http.createServer(async (req, res) => {
      kimi_hits += 1;
      await collect_body(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "chat.completion", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    })
  );
  created.push(deepseek, kimi);

  process.env.OVERRAIL_CHAOS = "529";
  try {
    const url = await gateway_for(deepseek, kimi);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(deepseek_hits, 0);
    assert.equal(kimi_hits, 1);
  } finally {
    delete process.env.OVERRAIL_CHAOS;
  }
});

test("OVERRAIL_CHAOS=midstream_drop@2 continues with the partial content prefilled", async () => {
  let deepseek_body_seen = 0;
  const deepseek = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      deepseek_body_seen += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of ["a", "b", "c", "d"]) res.write(sse_chunk("c1", { content: piece }));
      res.end(`${sse_chunk("c1", {}, {})}data: [DONE]\n\n`);
    })
  );
  let kimi_body = null;
  const kimi = await listen(
    http.createServer(async (req, res) => {
      kimi_body = JSON.parse(await collect_body(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("d2", { content: "XY" }));
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(deepseek, kimi);

  process.env.OVERRAIL_CHAOS = "midstream_drop@2";
  try {
    const res = await post_stream(await gateway_for(deepseek, kimi));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(deepseek_body_seen, 1);
    assert.deepEqual(kimi_body.messages[kimi_body.messages.length - 1], { role: "assistant", content: "ab" });
    assert.ok(text.includes('"content":"XY"'));
  } finally {
    delete process.env.OVERRAIL_CHAOS;
  }
});

test("tool-call argument deltas are held until the JSON is complete", async () => {
  const deepseek = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse_chunk("t1", {
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: '{"path":' } }],
        })
      );
      setTimeout(() => {
        res.write(sse_chunk("t1", { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }));
        res.end("data: [DONE]\n\n");
      }, 60);
    })
  );
  created.push(deepseek);

  const started = Date.now();
  const res = await post_stream(await gateway_for(deepseek, null));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(Date.now() - started >= 40);
  const first = text.indexOf("path");
  const second = text.indexOf("a.txt");
  assert.ok(first !== -1 && second !== -1 && first < second);
  assert.ok(text.includes('"name":"write"'));
  assert.equal(text.split("data: [DONE]").length - 1, 1);
});
