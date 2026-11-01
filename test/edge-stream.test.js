// Edge-case SSE stream tests through the real gateway against local fake upstreams.
// Zero external network. Run: node --test test/edge-stream.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-edge-"));
os.homedir = () => tmp_dir; // USAGE_PATH below is anchored to this dir before require-time

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

function post_stream(url, body = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      ...body,
    }),
  });
}

// Parse gateway output the way a tolerant SSE client does: split on blank-line
// event boundaries, keep blocks carrying data: lines, JSON.parse the joined
// payload (JSON whitespace tolerates intra-object newlines from multi-line
// framing). Comments/keep-alives carry no data: line and are dropped.
function parse_gateway_sse(text) {
  const chunks = [];
  let dones = 0;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data_lines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (data_lines.length === 0) continue;
    const payload = data_lines.join("\n");
    if (payload.trim() === "[DONE]") {
      dones += 1;
      continue;
    }
    try {
      chunks.push(JSON.parse(payload));
    } catch {
      chunks.push({ __unparsed__: payload });
    }
  }
  return { chunks, dones };
}

function assembled_text(chunks) {
  let out = "";
  for (const c of chunks) {
    const choice = Array.isArray(c.choices) ? c.choices[0] : null;
    if (choice && choice.delta && typeof choice.delta.content === "string") out += choice.delta.content;
  }
  return out;
}

function usage_lines() {
  try {
    return fs
      .readFileSync(USAGE_PATH, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("malformed SSE frames, non-data fields and stray blank lines are tolerated", async () => {
  const upstream = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ping\n\n"); // named event, no data line
      res.write("\n\n\n"); // stray blank lines between events
      res.write("this line is not an SSE field at all\n\n"); // garbage frame, no data: line
      res.write(`id: 7\ndata: {"id":"g1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"good"},"finish_reason":null}]}\n\n`); // data with id: sibling field
      res.write(`data:  {"id":"g1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":" frame"},"finish_reason":null}]}\n\n`); // two spaces after data:
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(upstream);

  const res = await post_stream(await gateway_for(upstream, null));
  assert.equal(res.status, 200);
  const { chunks, dones } = parse_gateway_sse(await res.text());
  assert.equal(dones, 1);
  assert.equal(assembled_text(chunks), "good frame");
  assert.equal(chunks.filter((c) => c.__unparsed__).length, 0);
});

test("invalid JSON data payloads are skipped without breaking the stream", async () => {
  const upstream = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("j1", { content: "before" }));
      res.write("data: {not valid json at all\n\n");
      res.write("data: \n\n"); // empty data payload
      res.write("data: {\"truncated\": true\n\n");
      res.write(sse_chunk("j1", { content: " after" }));
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(upstream);

  const res = await post_stream(await gateway_for(upstream, null));
  assert.equal(res.status, 200);
  const { chunks, dones } = parse_gateway_sse(await res.text());
  assert.equal(dones, 1);
  assert.equal(assembled_text(chunks), "before after");
});

test("SSE comments and keep-alives are framing-only and leave content intact", async () => {
  const upstream = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open-probe\n\n"); // comment-only event
      res.write(sse_chunk("k1", { content: "Alpha" }));
      res.write(": keep-alive\n\n"); // comment mid-stream
      await new Promise((r) => setTimeout(r, 30));
      res.write(sse_chunk("k1", { content: "Beta" }));
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(upstream);

  const res = await post_stream(await gateway_for(upstream, null));
  assert.equal(res.status, 200);
  const text = await res.text();
  const { chunks, dones } = parse_gateway_sse(text);
  assert.equal(dones, 1);
  assert.equal(assembled_text(chunks), "AlphaBeta");
});

test("multi-line data framing is joined and parsed as one chunk", async () => {
    const upstream = await listen(
      http.createServer(async (req, res) => {
        await collect_body(req);
        res.writeHead(200, { "content-type": "text/event-stream" });
        // one chunk whose JSON is split across two data: lines in one event
        res.write('data: {"id":"m1","object":"chat.completion.chunk","created":1,\n');
        res.write('data: "model":"test-model","choices":[{"index":0,"delta":{"content":"multi-line"},"finish_reason":null}]}\n\n');
        res.end("data: [DONE]\n\n");
      })
    );
    created.push(upstream);

    const res = await post_stream(await gateway_for(upstream, null));
    assert.equal(res.status, 200);
    const { chunks, dones } = parse_gateway_sse(await res.text());
    assert.equal(dones, 1);
    assert.equal(assembled_text(chunks), "multi-line");
    assert.equal(chunks.filter((c) => c.__unparsed__).length, 0);
  }
);

test("UTF-8 sequences split across network chunks stay intact", async () => {
    const expected = "naïve 🌍🌍 café ☕";
    const event = sse_chunk("u1", { content: expected });
    const bytes = Buffer.from(event, "utf8");
    const idx = bytes.indexOf(Buffer.from("🌍", "utf8"));
    const split = idx + 2; // cut the 4-byte emoji mid-sequence

    const upstream = await listen(
      http.createServer(async (req, res) => {
        await collect_body(req);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(bytes.slice(0, split)); // ends mid-codepoint
        await new Promise((r) => setTimeout(r, 40)); // force a separate read chunk
        res.write(bytes.slice(split));
        res.end("data: [DONE]\n\n");
      })
    );
    created.push(upstream);

    const res = await post_stream(await gateway_for(upstream, null));
    assert.equal(res.status, 200);
    const { chunks, dones } = parse_gateway_sse(await res.text());
    assert.equal(dones, 1);
    assert.equal(assembled_text(chunks), expected);
  }
);

test("usage-only chunks are held and merged; choices-less chunks pass through", async () => {
  const upstream = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("p1", { content: "streamed" }));
      // choices entirely absent, usage present: held, summed, re-emitted on the final chunk
      res.write(
        `data: ${JSON.stringify({ id: "p1", object: "chat.completion.chunk", created: 1, model: "test-model", usage: { prompt_tokens: 11, completion_tokens: 5 } })}\n\n`
      );
      // choices: [] and no usage: passes through as a live event
      res.write(
        `data: ${JSON.stringify({ id: "p1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [] })}\n\n`
      );
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(upstream);

  const res = await post_stream(await gateway_for(upstream, null));
  assert.equal(res.status, 200);
  const text = await res.text();
  const { chunks, dones } = parse_gateway_sse(text);
  assert.equal(dones, 1);
  assert.equal(assembled_text(chunks), "streamed");

  // the usage-only chunk must not appear as a live event; its totals surface once
  // on the synthesized final chunk
  const held = chunks.filter((c) => c.usage);
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].usage, { prompt_tokens: 11, completion_tokens: 5 });
  assert.equal(held[0].choices[0].finish_reason, "stop");
  assert.equal(held[0].id, "p1"); // re-identified to the stream base id

  // the choices-less, usage-less chunk passes through untouched
  const passthrough = chunks.filter((c) => Array.isArray(c.choices) && c.choices.length === 0);
  assert.equal(passthrough.length, 1);
});

test("clean upstream end without [DONE] still finishes with exactly one [DONE]", async () => {
  const upstream = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("e1", { content: "tail" }));
      res.write(
        `data: ${JSON.stringify({
          id: "e1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.end(); // closes cleanly, never sends [DONE]
    })
  );
  created.push(upstream);

  const res = await post_stream(await gateway_for(upstream, null));
  assert.equal(res.status, 200);
  const text = await res.text();
  const { chunks, dones } = parse_gateway_sse(text);
  assert.equal(dones, 1);
  assert.equal(assembled_text(chunks), "tail");
  const finals = chunks.filter((c) => c.choices && c.choices[0] && c.choices[0].finish_reason === "stop");
  assert.equal(finals.length, 1); // upstream finish held, exactly one synthesized
  assert.equal(finals[0].id, "e1");
});

test("429 before first byte fails over to the next provider", async () => {
  let primary_hits = 0;
  const primary = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      primary_hits += 1;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: "rate limit exceeded" } }));
    })
  );
  let backup_hits = 0;
  const backup = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      backup_hits += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("r1", { content: "from backup" }));
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(primary, backup);

  const before_count = usage_lines().length;
  const res = await post_stream(await gateway_for(primary, backup));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const { chunks, dones } = parse_gateway_sse(await res.text());
  assert.equal(primary_hits, 1);
  assert.equal(backup_hits, 1);
  assert.equal(dones, 1);
  assert.equal(assembled_text(chunks), "from backup");

  const entries = usage_lines().slice(before_count);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, "kimi"); // backup profile served the stream
  assert.equal(entries[0].model, "kimi-k2");
});

test("socket death mid-text stitches the backup with the exact partial prefill", async () => {
  const primary = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("d1", { content: "once upon" }));
      setTimeout(() => res.destroy(), 20); // die after text, before [DONE]
    })
  );
  let backup_body = null;
  const backup = await listen(
    http.createServer(async (req, res) => {
      backup_body = JSON.parse(await collect_body(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("d2", { content: " a time" }));
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(primary, backup);

  const res = await post_stream(await gateway_for(primary, backup));
  assert.equal(res.status, 200);
  const { chunks, dones } = parse_gateway_sse(await res.text());
  assert.equal(dones, 1);
  assert.equal(assembled_text(chunks), "once upon a time");
  assert.deepEqual(backup_body.messages[backup_body.messages.length - 1], {
    role: "assistant",
    content: "once upon",
  });
  assert.equal(chunks[chunks.length - 1].id, "d1"); // re-identified to the primary's id
});

test("socket death after a completed tool call continues with synthesized history", async () => {
  const primary = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse_chunk("f1", {
          tool_calls: [
            { index: 0, id: "call_done", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
          ],
        })
      );
      setTimeout(() => res.destroy(), 20); // dies after a fully flushed tool call
    })
  );
  let backup_body = null;
  const backup = await listen(
    http.createServer(async (req, res) => {
      backup_body = JSON.parse(await collect_body(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse_chunk("f2", {
          tool_calls: [
            { index: 1, id: "call_two", type: "function", function: { name: "write", arguments: '{"n":1}' } },
          ],
        })
      );
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(primary, backup);

  const res = await post_stream(await gateway_for(primary, backup));
  assert.equal(res.status, 200);
  const text = await res.text();
  const { dones } = parse_gateway_sse(text);
  assert.equal(dones, 1);
  assert.equal(text.split("call_done").length - 1, 1); // completed call exactly once
  assert.ok(text.includes("call_two"));
  const history = backup_body.messages[backup_body.messages.length - 2];
  assert.equal(history.role, "assistant");
  assert.equal(history.tool_calls[0].id, "call_done");
  assert.equal(backup_body.messages[backup_body.messages.length - 1].role, "tool");
});

test("socket death mid-partial-tool discards unflushed args and regenerates clean", async () => {
  const primary = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("h1", { content: "thinking" }));
      res.write(
        sse_chunk("h1", {
          tool_calls: [{ index: 0, id: "call_part", type: "function", function: { name: "write", arguments: '{"path"' } }],
        })
      );
      setTimeout(() => res.destroy(), 20); // dies with args still unparseable
    })
  );
  let backup_body = null;
  const backup = await listen(
    http.createServer(async (req, res) => {
      backup_body = JSON.parse(await collect_body(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse_chunk("h2", {
          tool_calls: [
            { index: 0, id: "call_full", type: "function", function: { name: "write", arguments: '{"path":"z.txt"}' } },
          ],
        })
      );
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(primary, backup);

  const res = await post_stream(await gateway_for(primary, backup));
  assert.equal(res.status, 200);
  const text = await res.text();
  const { dones } = parse_gateway_sse(text);
  assert.equal(dones, 1);
  assert.ok(text.includes("thinking"));
  assert.ok(!text.includes("call_part")); // never flushed to the client
  assert.ok(!text.includes('"path"')); // partial args never leaked
  assert.equal(text.split("call_full").length - 1, 1);
  // content was already forwarded, so the backup continues from the text prefill
  assert.deepEqual(backup_body.messages[backup_body.messages.length - 1], {
    role: "assistant",
    content: "thinking",
  });
});

test("8000-delta stream with midstream drop stitches exactly, one [DONE]", async () => {
  const N = 8000;
  const DROP_AT = 4000;
  const pieces = [];
  for (let i = 0; i < N; i++) pieces.push(`w${i} `);

  const primary = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < N; i++) res.write(sse_chunk("big1", { content: pieces[i] }));
      res.end("data: [DONE]\n\n");
    })
  );
  let backup_body = null;
  const backup = await listen(
    http.createServer(async (req, res) => {
      backup_body = JSON.parse(await collect_body(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = DROP_AT; i < N; i++) res.write(sse_chunk("big2", { content: pieces[i] }));
      res.end("data: [DONE]\n\n");
    })
  );
  created.push(primary, backup);

  process.env.OVERRAIL_CHAOS = `midstream_drop@${DROP_AT}`;
  try {
    const url = await gateway_for(primary, backup);
    const started = Date.now();
    const res = await post_stream(url);
    assert.equal(res.status, 200);
    const { chunks, dones } = parse_gateway_sse(await res.text());
    const elapsed = Date.now() - started;

    assert.equal(dones, 1);
    assert.equal(assembled_text(chunks), pieces.join(""));
    const content_events = chunks.filter((c) => c.choices && c.choices[0] && c.choices[0].delta.content).length;
    assert.equal(content_events, N); // each delta reaches the client exactly once
    assert.deepEqual(backup_body.messages[backup_body.messages.length - 1], {
      role: "assistant",
      content: pieces.slice(0, DROP_AT).join(""),
    });
    assert.ok(elapsed < 30000, `8k-delta recovery took ${elapsed}ms`);
  } finally {
    delete process.env.OVERRAIL_CHAOS;
  }
});

test("usage merged across both legs; usage log carries backup provider evidence", async () => {
  const primary = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("g1", { content: "leg one " }, { usage: { prompt_tokens: 100, completion_tokens: 2 } }));
      setTimeout(() => res.destroy(), 20);
    })
  );
  const backup = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse_chunk("g2", { content: "leg two" }));
      res.end(
        `data: ${JSON.stringify({
          id: "g2",
          object: "chat.completion.chunk",
          created: 1,
          model: "kimi-k2",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 8 },
        })}\n\ndata: [DONE]\n\n`
      );
    })
  );
  created.push(primary, backup);

  const before_count = usage_lines().length;
  const res = await post_stream(await gateway_for(primary, backup));
  assert.equal(res.status, 200);
  const { chunks, dones } = parse_gateway_sse(await res.text());
  assert.equal(dones, 1);
  assert.equal(assembled_text(chunks), "leg one leg two");

  // leg 0 forwards the primary's chunk with its partial usage raw; the merged
  // totals surface on the single synthesized final chunk
  const with_usage = chunks.filter((c) => c.usage);
  assert.equal(with_usage.length, 2);
  assert.deepEqual(with_usage[0].usage, { prompt_tokens: 100, completion_tokens: 2 }); // partial, pre-drop leg
  assert.deepEqual(with_usage[with_usage.length - 1].usage, { prompt_tokens: 150, completion_tokens: 10 }); // merged total
  const final = with_usage[with_usage.length - 1];
  assert.equal(final.choices[0].finish_reason, "stop");
  assert.equal(final.id, "g1"); // client sees one continuous identity

  const entries = usage_lines().slice(before_count);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, "kimi"); // profile that ultimately served the stream
  assert.equal(entries[0].model, "kimi-k2");
  assert.equal(entries[0].prompt_tokens, 150);
  assert.equal(entries[0].completion_tokens, 10);
});
