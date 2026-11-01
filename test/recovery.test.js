const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-recovery-"));
os.homedir = () => tmp_dir; // must precede require: lib/config resolves CONFIG_DIR at load

const recovery = require("../lib/recovery");
const { CONFIG_DIR } = require("../lib/config");

const servers = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

after(async () => {
  delete process.env.OVERRAIL_RECOVERY_DIR;
  for (const server of servers) await close(server);
  os.homedir = real_homedir;
  fs.rmSync(tmp_dir, { recursive: true, force: true });
});

const JOURNAL_FIELDS = new Set([
  "v",
  "ts",
  "recovery_id",
  "request_hash",
  "tool_call_id",
  "function",
  "args_sha256",
  "phase",
  "profile",
  "provider",
  "model",
  "source",
]);

function base_request(overrides = {}) {
  return {
    endpoint: "/v1/chat/completions",
    profile_name: "deepseek",
    model: "deepseek/deepseek-chat",
    messages: [
      { role: "system", content: "You are a careful agent." },
      { role: "user", content: "write the config file" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "write",
          description: "Write a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      },
    ],
    ...overrides,
  };
}

function lines_for(recovery_id) {
  return recovery.read_journal(0).filter((entry) => entry.recovery_id === recovery_id);
}

function phase_lines(recovery_id, phase, tool_call_id) {
  return lines_for(recovery_id).filter(
    (entry) => entry.phase === phase && (tool_call_id === undefined || entry.tool_call_id === tool_call_id)
  );
}

test("the recovery key is stable for the same normalized request", () => {
  const first = recovery.derive_recovery_key(base_request());
  const second = recovery.derive_recovery_key(base_request());
  assert.equal(first.recovery_id, second.recovery_id);
  assert.equal(first.request_hash, second.request_hash);
  assert.equal(first.source, "derived");
  assert.equal(first.recovery_id, first.request_hash);
  assert.match(first.recovery_id, /^[0-9a-f]{64}$/);
});

test("normalization ignores key order, whitespace and non-semantic fields", () => {
  const plain = recovery.derive_recovery_key(base_request());
  const shuffled_messages = recovery.derive_recovery_key(
    base_request({
      messages: [
        { content: "You are a careful agent.", role: "system" },
        { content: "write the config file", role: "user" },
      ],
    })
  );
  assert.equal(plain.recovery_id, shuffled_messages.recovery_id);

  const with_tool_history = recovery.derive_recovery_key(
    base_request({
      messages: [
        { role: "system", content: "You are a careful agent." },
        { role: "user", content: "write the config file" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { arguments: '{"mode":"w","path":"a.txt"}', name: "write" } }],
        },
      ],
    })
  );
  const reordered_args = recovery.derive_recovery_key(
    base_request({
      messages: [
        { role: "system", content: "You are a careful agent." },
        { role: "user", content: "write the config file" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "write", arguments: '{ "path" : "a.txt", "mode" : "w" }' } }],
        },
      ],
    })
  );
  assert.equal(with_tool_history.recovery_id, reordered_args.recovery_id);

  const with_noise = recovery.derive_recovery_key({
    ...base_request(),
    headers: { "x-request-id": "random-per-attempt" },
    endpoint: "/v1/chat/completions?stream=true",
  });
  assert.equal(plain.recovery_id, with_noise.recovery_id); // query string and unmapped fields drop out

  const changed_content = recovery.derive_recovery_key(
    base_request({ messages: [{ role: "user", content: "write the OTHER config file" }] })
  );
  assert.notEqual(plain.recovery_id, changed_content.recovery_id);

  const reordered_tools = recovery.derive_recovery_key(
    base_request({
      tools: [
        { type: "function", function: { name: "read", parameters: { type: "object" } } },
        { type: "function", function: { name: "write", parameters: { type: "object" } } },
      ],
    })
  );
  const swapped_tools = recovery.derive_recovery_key(
    base_request({
      tools: [
        { type: "function", function: { name: "write", parameters: { type: "object" } } },
        { type: "function", function: { name: "read", parameters: { type: "object" } } },
      ],
    })
  );
  assert.notEqual(reordered_tools.recovery_id, swapped_tools.recovery_id); // tool order is semantic
});

test("arguments hash is format-independent", () => {
  const a = recovery.hash_arguments('{"path":"a.txt","mode":"w"}');
  const b = recovery.hash_arguments('{"mode": "w", "path": "a.txt"}');
  const c = recovery.hash_arguments({ path: "a.txt", mode: "w" });
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(a, recovery.hash_arguments('{"path":"b.txt","mode":"w"}'));
  // non-JSON payloads still hash deterministically
  assert.equal(recovery.hash_arguments("  raw text "), recovery.hash_arguments("raw text"));
});

test("a caller-supplied key wins over derivation and is case-insensitive", () => {
  const lower = recovery.derive_recovery_key({ ...base_request(), headers: { "idempotency-key": "attempt-7" } });
  const mixed = recovery.derive_recovery_key({ ...base_request(), headers: { "Idempotency-Key": "attempt-7" } });
  const via_headers = recovery.derive_recovery_key({
    ...base_request(),
    headers: new Headers({ "OVERRAIL-RECOVERY-KEY": "attempt-7" }),
  });
  assert.equal(lower.source, "header");
  assert.equal(lower.recovery_id, mixed.recovery_id);
  assert.equal(lower.recovery_id, via_headers.recovery_id);
  assert.notEqual(lower.recovery_id, lower.request_hash); // header ids are digests of the key, not the body

  const other_body = recovery.derive_recovery_key({
    ...base_request({ messages: [{ role: "user", content: "totally different ask" }] }),
    headers: { "idempotency-key": "attempt-7" },
  });
  assert.equal(other_body.recovery_id, lower.recovery_id); // same key -> same session
  assert.notEqual(other_body.request_hash, lower.request_hash);
  assert.equal(recovery.derive_recovery_key(base_request()).recovery_id !== lower.recovery_id, true);

  // Idempotency-Key takes precedence when both are present
  const both = recovery.derive_recovery_key({
    ...base_request(),
    headers: { "idempotency-key": "primary", "overrail-recovery-key": "fallback" },
  });
  const fallback = recovery.derive_recovery_key({
    ...base_request(),
    headers: { "overrail-recovery-key": "fallback" },
  });
  const primary = recovery.derive_recovery_key({ ...base_request(), headers: { "idempotency-key": "primary" } });
  assert.equal(both.recovery_id, primary.recovery_id);
  assert.notEqual(both.recovery_id, fallback.recovery_id);

  // blank headers fall back to derivation
  assert.equal(recovery.derive_recovery_key({ ...base_request(), headers: { "idempotency-key": "  " } }).source, "derived");
});

test("the journal lives under ~/.overrail/recovery.jsonl", () => {
  assert.equal(CONFIG_DIR, path.join(tmp_dir, ".overrail"));
  assert.equal(recovery.journal_path(), path.join(tmp_dir, ".overrail", "recovery.jsonl"));
});

test("open_session is idempotent and refuses a reused key with a different request", () => {
  const request = base_request();
  const first = recovery.open_session(request);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  const second = recovery.open_session(request);
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.recovery_id, first.recovery_id);
  assert.equal(phase_lines(first.recovery_id, "created").length, 1);

  const headers = { "idempotency-key": "reused-key" };
  const opened = recovery.open_session({ ...base_request(), headers });
  assert.equal(opened.created, true);
  const conflict = recovery.open_session({
    ...base_request({ messages: [{ role: "user", content: "a different request under the same key" }] }),
    headers,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "idempotency_key_conflict");
  assert.equal(phase_lines(opened.recovery_id, "created").length, 1); // no second creation, no merge
});

test("the journal persists metadata only — never arguments or prompt content", () => {
  const opened = recovery.open_session({
    ...base_request(),
    messages: [{ role: "user", content: "SECRET PROMPT TOKEN read it back" }],
    headers: { "idempotency-key": "metadata-only-1" },
  });
  recovery.record_tool_call({
    recovery_id: opened.recovery_id,
    tool_call_id: "call_secret",
    name: "write",
    arguments: '{"path":"/etc/secret.conf","body":"SECRET ARGUMENT TOKEN do not persist"}',
    phase: "offered",
    profile: "deepseek",
    provider: "kimi",
  });
  recovery.acknowledge_execution({ recovery_id: opened.recovery_id, tool_call_id: "call_secret" });

  const raw = fs.readFileSync(recovery.journal_path(), "utf8");
  assert.equal(raw.includes("SECRET PROMPT TOKEN"), false);
  assert.equal(raw.includes("SECRET ARGUMENT TOKEN"), false);
  assert.equal(raw.includes("secret.conf"), false);
  assert.equal(raw.includes("read it back"), false);
  for (const entry of lines_for(opened.recovery_id)) {
    for (const key of Object.keys(entry)) assert.ok(JOURNAL_FIELDS.has(key), `unexpected field ${key}`);
    assert.equal(typeof entry.ts, "string");
    assert.equal(entry.v, 1);
  }
  const offered = phase_lines(opened.recovery_id, "offered", "call_secret")[0];
  assert.equal(offered.function, "write");
  assert.match(offered.args_sha256, /^[0-9a-f]{64}$/);
  assert.equal(offered.args_sha256, recovery.hash_arguments('{"path":"/etc/secret.conf","body":"SECRET ARGUMENT TOKEN do not persist"}'));
  assert.equal(offered.provider, "kimi");
  assert.equal(offered.profile, "deepseek");
  assert.equal(Object.keys(offered).some((key) => key === "arguments"), false);
  const acked = phase_lines(opened.recovery_id, "acknowledged", "call_secret")[0];
  assert.equal(acked.phase, "acknowledged");
});

test("record_tool_call dedupes a repeated phase but allows regenerated arguments", () => {
  const opened = recovery.open_session({ ...base_request(), headers: { "idempotency-key": "dedupe-1" } });
  const id = opened.recovery_id;
  const one = recovery.record_tool_call({ recovery_id: id, tool_call_id: "call_1", name: "write", arguments: '{"p":"a"}', phase: "generated" });
  assert.equal(one.ok, true);
  assert.equal(one.deduped, false);
  const again = recovery.record_tool_call({ recovery_id: id, tool_call_id: "call_1", name: "write", arguments: '{"p":"a"}', phase: "generated" });
  assert.equal(again.deduped, true);
  assert.equal(phase_lines(id, "generated", "call_1").length, 1);

  // the backup provider re-emits the same call id with completed arguments
  const offer = recovery.record_tool_call({ recovery_id: id, tool_call_id: "call_1", name: "write", arguments: '{"p":"a","q":"b"}', phase: "offered" });
  assert.equal(offer.deduped, false);
  assert.equal(offer.status, "offered");
  assert.equal(lines_for(id).length, 3); // created + generated + offered
  assert.equal(recovery.load_state(id).calls.call_1.delivered, true);
});

test("acknowledgement is idempotent and writes exactly one execution record", () => {
  const opened = recovery.open_session({ ...base_request(), headers: { "idempotency-key": "ack-1" } });
  const id = opened.recovery_id;
  recovery.record_tool_call({ recovery_id: id, tool_call_id: "call_x", name: "write", arguments: "{}", phase: "offered" });
  assert.equal(recovery.is_executed(id, "call_x"), false);

  const first = recovery.acknowledge_execution({ recovery_id: id, tool_call_id: "call_x" });
  assert.equal(first.ok, true);
  assert.equal(first.replay, false);
  assert.equal(first.status, "acknowledged");
  assert.equal(recovery.is_executed(id, "call_x"), true);

  const second = recovery.acknowledge_execution({ recovery_id: id, tool_call_id: "call_x" });
  assert.equal(second.ok, true);
  assert.equal(second.replay, true);
  assert.equal(phase_lines(id, "acknowledged", "call_x").length, 1);

  // an executed call cannot be re-offered silently
  const reoffer = recovery.record_tool_call({ recovery_id: id, tool_call_id: "call_x", name: "write", arguments: '{"again":true}', phase: "offered" });
  assert.equal(reoffer.deduped, true);
  assert.equal(reoffer.conflict, "already_executed");
  assert.equal(phase_lines(id, "offered", "call_x").length, 1);
  assert.equal(recovery.load_state(id).calls.call_x.status, "acknowledged");
});

test("unknown ids and malformed input are refusals, not exceptions", () => {
  const opened = recovery.open_session({ ...base_request(), headers: { "idempotency-key": "errors-1" } });
  assert.deepEqual(recovery.acknowledge_execution({ recovery_id: "a".repeat(64), tool_call_id: "call_missing" }), {
    ok: false,
    code: "unknown_recovery_id",
    recovery_id: "a".repeat(64),
  });
  assert.equal(
    recovery.acknowledge_execution({ recovery_id: opened.recovery_id, tool_call_id: "call_never_recorded" }).code,
    "unknown_tool_call_id"
  );
  assert.equal(recovery.acknowledge_execution({ recovery_id: "not valid!!", tool_call_id: "call_1" }).code, "invalid_recovery_id");
  assert.equal(
    recovery.record_tool_call({ recovery_id: opened.recovery_id, tool_call_id: "call space", name: "x" }).code,
    "invalid_tool_call_id"
  );
  assert.equal(
    recovery.record_tool_call({ recovery_id: opened.recovery_id, tool_call_id: "call_1", name: "x", phase: "executed" }).code,
    "invalid_phase"
  );
  assert.equal(recovery.load_state("nope no").exists, false);
  assert.deepEqual(recovery.read_journal(0).length > 0, true);
});

test("abandon then a late ack records the duplicate side-effect risk", () => {
  const opened = recovery.open_session({ ...base_request(), headers: { "idempotency-key": "abandon-1" } });
  const id = opened.recovery_id;
  recovery.record_tool_call({ recovery_id: id, tool_call_id: "call_a", name: "write", arguments: "{}", phase: "offered" });
  const abandoned = recovery.abandon_call({ recovery_id: id, tool_call_id: "call_a" });
  assert.equal(abandoned.status, "abandoned");
  assert.equal(recovery.abandon_call({ recovery_id: id, tool_call_id: "call_a" }).deduped, true);
  assert.equal(phase_lines(id, "abandoned", "call_a").length, 1);

  const late = recovery.acknowledge_execution({ recovery_id: id, tool_call_id: "call_a" });
  assert.equal(late.ok, true);
  assert.equal(late.status, "acknowledged");
  assert.equal(late.was, "abandoned");
  assert.equal(late.conflict, "duplicate_side_effect_risk");
  assert.equal(recovery.load_state(id).calls.call_a.status, "acknowledged");

  // and an ack cannot be walked back by a later abandon
  const blocked = recovery.abandon_call({ recovery_id: id, tool_call_id: "call_a" });
  assert.equal(blocked.status, "acknowledged");
  assert.equal(blocked.deduped, true);
  assert.equal(blocked.conflict, "already_executed");
  assert.equal(phase_lines(id, "abandoned", "call_a").length, 1);
  assert.equal(recovery.load_state(id).calls.call_a.status, "acknowledged");
});

test("continuation history separates executed, unknown and must-regenerate calls", () => {
  const opened = recovery.open_session({ ...base_request(), headers: { "idempotency-key": "history-1" } });
  const id = opened.recovery_id;
  recovery.record_emitted_calls({
    recovery_id: id,
    phase: "offered",
    calls: [
      { id: "call_done", type: "function", function: { name: "read", arguments: '{"path":"SECRET-READ.txt"}' } },
      { id: "call_unknown", type: "function", function: { name: "write", arguments: '{"path":"SECRET-WRITE.txt"}' } },
    ],
  });
  recovery.record_tool_call({ recovery_id: id, tool_call_id: "call_half", name: "mail", arguments: '{"to":"SECRET-MAIL"}', phase: "generated" });
  recovery.acknowledge_execution({ recovery_id: id, tool_call_id: "call_done" });

  const history = recovery.continuation_history(id);
  assert.deepEqual(history.executed, ["call_done"]);
  assert.deepEqual(history.execution_unknown, ["call_unknown"]);
  assert.deepEqual(history.must_regenerate, ["call_half"]);
  assert.equal(history.arguments_persisted, false);
  assert.equal(history.acknowledged[0].function, "read");
  assert.equal(history.acknowledged[0].executed, true);
  assert.equal(history.delivered_unacknowledged[0].delivered, true);
  assert.equal(history.generated_unacknowledged[0].delivered, false);

  const assistant = history.messages.find((message) => message.role === "assistant");
  // both delivered calls are conversation history — the client saw them; only the acked
  // one is claimed as executed
  assert.deepEqual(
    assistant.tool_calls.map((call) => call.id),
    ["call_done", "call_unknown"]
  );
  assert.equal(assistant.tool_calls[0].function.name, "read");
  const sentinel = JSON.parse(assistant.tool_calls[0].function.arguments);
  assert.equal(sentinel._overrail_recovery, "arguments_not_persisted"); // never fabricated
  assert.equal(sentinel.args_sha256, recovery.hash_arguments('{"path":"SECRET-READ.txt"}'));
  const tool_messages = history.messages.filter((message) => message.role === "tool");
  assert.equal(tool_messages.length, 2);
  assert.equal(tool_messages[0].tool_call_id, "call_done");
  assert.ok(tool_messages[0].content.includes("the client acknowledged this call as executed"));
  assert.ok(tool_messages[1].content.includes("never acknowledged"));
  const directive = history.messages[history.messages.length - 1];
  assert.equal(directive.role, "user");
  assert.ok(directive.content.includes("call_unknown"));
  assert.ok(directive.content.includes("regenerate these calls: mail(call_half)"));
  assert.equal(JSON.stringify(history.messages).includes("SECRET-"), false);
  // the never-delivered call is absent from history — the client can never have seen it
  assert.equal(JSON.stringify(assistant.tool_calls).includes("call_half"), false);

  // with live arguments in memory, the relay can hand the real call back
  const with_live = recovery.continuation_history(id, { known_arguments: { call_done: '{"path":"SECRET-READ.txt"}' } });
  const live_assistant = with_live.messages.find((message) => message.role === "assistant");
  assert.deepEqual(JSON.parse(live_assistant.tool_calls[0].function.arguments), { path: "SECRET-READ.txt" });
});

test("a torn journal line is skipped instead of breaking state", () => {
  const opened = recovery.open_session({ ...base_request(), headers: { "idempotency-key": "torn-1" } });
  recovery.record_tool_call({ recovery_id: opened.recovery_id, tool_call_id: "call_t", name: "read", arguments: "{}", phase: "offered" });
  fs.appendFileSync(recovery.journal_path(), '{"v":1,"recovery_id":"cut');
  const state = recovery.load_state(opened.recovery_id);
  assert.equal(state.exists, true);
  assert.equal(state.calls.call_t.status, "offered");
  assert.equal(recovery.acknowledge_execution({ recovery_id: opened.recovery_id, tool_call_id: "call_t" }).ok, true);
});

test("a racing abandon in the journal cannot undo an acknowledgement", () => {
  const opened = recovery.open_session({ ...base_request(), headers: { "idempotency-key": "race-1" } });
  const id = opened.recovery_id;
  recovery.record_tool_call({ recovery_id: id, tool_call_id: "call_race", name: "write", arguments: "{}", phase: "offered" });
  recovery.acknowledge_execution({ recovery_id: id, tool_call_id: "call_race" });
  // simulate a second leg that wrote its abandon after the ack landed
  fs.appendFileSync(
    recovery.journal_path(),
    `${JSON.stringify({ v: 1, ts: new Date().toISOString(), recovery_id: id, tool_call_id: "call_race", phase: "abandoned" })}\n`
  );
  const state = recovery.load_state(id);
  assert.equal(state.calls.call_race.status, "acknowledged"); // absorbing
  assert.equal(state.calls.call_race.conflict, "acknowledged_wins_over_abandon");
  assert.equal(recovery.is_executed(id, "call_race"), true);
  const history = recovery.continuation_history(id);
  assert.deepEqual(history.executed, ["call_race"]);
  assert.deepEqual(history.abandoned, []);
});

test("OVERRAIL_RECOVERY_DIR redirects the journal", () => {
  const alt = path.join(tmp_dir, "alt-root");
  process.env.OVERRAIL_RECOVERY_DIR = alt;
  try {
    assert.equal(recovery.journal_path(), path.join(alt, "recovery.jsonl"));
    const opened = recovery.open_session({ ...base_request(), headers: { "idempotency-key": "redirect-1" } });
    assert.equal(opened.ok, true);
    const raw = fs.readFileSync(path.join(alt, "recovery.jsonl"), "utf8");
    assert.ok(raw.includes(opened.recovery_id));
    assert.equal(raw.includes("write the config file"), false);
  } finally {
    delete process.env.OVERRAIL_RECOVERY_DIR;
  }
  assert.equal(recovery.journal_path(), path.join(CONFIG_DIR, "recovery.jsonl"));
});

test("POST /v1/recovery/:id/ack acks, replays and rejects without throwing", async () => {
  const opened = recovery.open_session({ ...base_request(), headers: { "idempotency-key": "http-1" } });
  const id = opened.recovery_id;
  recovery.record_tool_call({ recovery_id: id, tool_call_id: "call_http", name: "write", arguments: '{"p":"a"}', phase: "offered" });

  const server = await listen(
    http.createServer((req, res) => {
      res.on("error", () => {});
      // exactly the wiring the gateway needs
      const match = recovery.match_recovery_ack(new URL(req.url, "http://127.0.0.1").pathname);
      if (match) return recovery.handle_recovery_ack(req, res, match.recovery_id);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no route" } }));
    })
  );
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;

  const ack = await fetch(`${origin}/v1/recovery/${id}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_call_id: "call_http" }),
  });
  assert.equal(ack.status, 200);
  assert.equal(ack.headers.get("content-type"), "application/json");
  const body = await ack.json();
  assert.equal(body.status, "acknowledged");
  assert.equal(body.replay, false);
  assert.equal(body.recovery_id, id);
  assert.equal(recovery.is_executed(id, "call_http"), true);

  const replay = await fetch(`${origin}/v1/recovery/${id}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_call_id: "call_http" }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replay, true);
  assert.equal(phase_lines(id, "acknowledged", "call_http").length, 1);

  const unknown_call = await fetch(`${origin}/v1/recovery/${id}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_call_id: "call_nope" }),
  });
  assert.equal(unknown_call.status, 404);
  assert.equal((await unknown_call.json()).error.code, "unknown_tool_call_id");

  const unknown_session = await fetch(`${origin}/v1/recovery/${"b".repeat(64)}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_call_id: "call_http" }),
  });
  assert.equal(unknown_session.status, 404);
  assert.equal((await unknown_session.json()).error.code, "unknown_recovery_id");

  const bad_json = await fetch(`${origin}/v1/recovery/${id}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(bad_json.status, 400);
  assert.equal((await bad_json.json()).error.code, "invalid_json");

  const missing_field = await fetch(`${origin}/v1/recovery/${id}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolCallId: "call_http" }),
  });
  assert.equal(missing_field.status, 400);
  assert.equal((await missing_field.json()).error.code, "missing_tool_call_id");

  const wrong_method = await fetch(`${origin}/v1/recovery/${id}/ack`, { method: "GET" });
  assert.equal(wrong_method.status, 405);
  assert.equal((await wrong_method.json()).error.code, "method_not_allowed");

  const malformed = await fetch(`${origin}/v1/recovery/not%20valid/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_call_id: "call_http" }),
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "invalid_recovery_id");

  // nothing above may have killed the server
  const still_alive = await fetch(`${origin}/v1/recovery/${id}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool_call_id: "call_http" }),
  });
  assert.equal(still_alive.status, 200);

  assert.equal(recovery.match_recovery_ack("/v1/recovery/abc/ack").recovery_id, "abc");
  assert.equal(recovery.match_recovery_ack("/v1/recovery/abc/ack/").recovery_id, "abc");
  assert.equal(recovery.match_recovery_ack("/v1/chat/completions"), null);
  assert.equal(recovery.match_recovery_ack("/v1/recovery/abc"), null);
});
