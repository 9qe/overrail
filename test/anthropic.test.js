const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  AnthropicStreamEncoder,
  anthropic_messages_to_openai,
  openai_to_anthropic_response,
  parse_anthropic_sse,
  createAnthropicMessagesHandler,
} = require("../lib/anthropic");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

function openai_chunk(delta, extra = {}) {
  return JSON.stringify({
    id: "chatcmpl-test1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "upstream-model",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });
}

function finish_chunk(finish_reason, usage) {
  return JSON.stringify({
    id: "chatcmpl-test1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "upstream-model",
    choices: [{ index: 0, delta: {}, finish_reason }],
    ...(usage ? { usage } : {}),
  });
}

function validate_stream_events(events) {
  const kinds = events.map((e) => e.data.type);
  assert.equal(kinds[0], "message_start", "stream must open with message_start");
  assert.equal(kinds[kinds.length - 1], "message_stop", "stream must close with message_stop");
  assert.equal(kinds.filter((k) => k === "message_start").length, 1);
  assert.equal(kinds.filter((k) => k === "message_stop").length, 1);
  assert.equal(kinds.filter((k) => k === "message_delta").length, 1);
  const message_delta = events.find((e) => e.data.type === "message_delta");
  assert.equal(typeof message_delta.data.delta.stop_reason, "string");
  assert.equal(typeof message_delta.data.usage.output_tokens, "number");

  const started = new Set();
  const stopped = new Set();
  let active = null;
  let max_started_index = -1;
  for (const ev of events) {
    const d = ev.data;
    if (d.type === "content_block_start") {
      assert.ok(!started.has(d.index), `block ${d.index} started twice`);
      assert.ok(d.index > max_started_index, `indices must increase (saw ${d.index} after ${max_started_index})`);
      max_started_index = d.index;
      started.add(d.index);
      assert.equal(active, null, "a block was started while another was still open");
      active = d.index;
    } else if (d.type === "content_block_stop") {
      assert.ok(started.has(d.index), `block ${d.index} stopped before it started`);
      assert.ok(!stopped.has(d.index), `block ${d.index} stopped twice`);
      assert.equal(active, d.index, "stop must close the currently open block");
      stopped.add(d.index);
      active = null;
    } else if (d.type === "content_block_delta") {
      assert.ok(started.has(d.index) && !stopped.has(d.index), `delta on unstarted or stopped block ${d.index}`);
      assert.equal(active, d.index, "delta must target the currently open block");
    }
  }
  assert.equal(active, null, "stream ended with an open content block");
  return events;
}

function encode_all(chunks, options = {}) {
  const encoder = new AnthropicStreamEncoder(options);
  const frames = [];
  for (const chunk of chunks) frames.push(...encoder.feed(chunk));
  frames.push(...encoder.terminate());
  return parse_anthropic_sse(frames.join(""));
}

// section: request translation

test("system + user text with sampling params translates to an OpenAI chat body", () => {
  const openai = anthropic_messages_to_openai({
    model: "deepseek",
    max_tokens: 4096,
    temperature: 0.7,
    top_p: 0.9,
    stop_sequences: ["\nHuman:", "quick"],
    system: [{ type: "text", text: "You are a coding agent." }],
    messages: [{ role: "user", content: "fix the bug" }],
  });
  assert.equal(openai.model, "deepseek");
  assert.equal(openai.max_tokens, 4096);
  assert.equal(openai.temperature, 1.4); // anthropic 0-1 rescaled to OpenAI 0-2
  assert.equal(openai.top_p, 0.9);
  assert.deepEqual(openai.stop, ["\nHuman:", "quick"]);
  assert.deepEqual(openai.messages, [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "fix the bug" },
  ]);
  assert.equal(openai.stream, undefined);
});

test("string system prompt and multi-text blocks are accepted", () => {
  const openai = anthropic_messages_to_openai({
    model: "kimi",
    max_tokens: 100,
    system: "plain string system",
    messages: [{ role: "user", content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] }],
  });
  assert.deepEqual(openai.messages, [
    { role: "system", content: "plain string system" },
    { role: "user", content: "line one\nline two" },
  ]);
});

test("Claude Code style tool_use / tool_result history maps to assistant + tool messages", () => {
  const openai = anthropic_messages_to_openai({
    model: "openrouter/claude",
    max_tokens: 2048,
    messages: [
      { role: "user", content: [{ type: "text", text: "read package.json" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it now." },
          { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "package.json" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "{\"name\":\"overrail\"}" }] },
        ],
      },
      { role: "user", content: "thanks" },
    ],
  });
  assert.deepEqual(openai.messages, [
    { role: "user", content: "read package.json" },
    {
      role: "assistant",
      content: "Reading it now.",
      tool_calls: [
        { id: "toolu_01", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } },
      ],
    },
    { role: "tool", tool_call_id: "toolu_01", content: "{\"name\":\"overrail\"}" },
    { role: "user", content: "thanks" },
  ]);
});

test("assistant turn with multiple tool_use blocks keeps order and empty text content as null", () => {
  const openai = anthropic_messages_to_openai({
    max_tokens: 512,
    messages: [
      { role: "user", content: "two reads" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc_a", name: "read", input: { p: "a" } },
          { type: "tool_use", id: "tc_b", name: "read", input: { p: "b" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tc_a", content: "A" }, { type: "tool_result", tool_use_id: "tc_b", content: "B" }] },
    ],
  });
  const assistant = openai.messages[1];
  assert.equal(assistant.content, null);
  assert.deepEqual(assistant.tool_calls.map((c) => c.id), ["tc_a", "tc_b"]);
  assert.deepEqual(
    openai.messages.slice(2).map((m) => [m.role, m.tool_call_id, m.content]),
    [
      ["tool", "tc_a", "A"],
      ["tool", "tc_b", "B"],
    ]
  );
});

test("tools with input_schema map to OpenAI function tools and tool_choice maps reasonably", () => {
  const openai = anthropic_messages_to_openai({
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "get_weather",
        description: "Fetch weather",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ],
    tool_choice: { type: "tool", name: "get_weather" },
  });
  assert.deepEqual(openai.tools, [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Fetch weather",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ]);
  assert.deepEqual(openai.tool_choice, { type: "function", function: { name: "get_weather" } });

  assert.equal(anthropic_messages_to_openai({ max_tokens: 1, messages: [{ role: "user", content: "x" }], tool_choice: "any" }).tool_choice, "required");
  assert.equal(anthropic_messages_to_openai({ max_tokens: 1, messages: [{ role: "user", content: "x" }], tool_choice: "none" }).tool_choice, "none");
});

test("invalid requests raise structured AnthropicTranslateError", () => {
  const cases = [
    [{ role: "user", content: "hi" }, "messages"], // no messages array at all
    [{ messages: [{ role: "user", content: "hi" }] }, "max_tokens"], // missing max_tokens
    [{ max_tokens: "many", messages: [{ role: "user", content: "hi" }] }, "max_tokens"],
    [{ max_tokens: 1, messages: "not-an-array" }, "messages"],
    [{ max_tokens: 1, messages: [{ role: "wizard", content: "hi" }] }, "role"],
    [{ max_tokens: 1, messages: [{ role: "user", content: [{ type: "tool_result", content: "orphan" }] }] }, "tool_use_id"],
    [{ max_tokens: 1, messages: [{ role: "assistant", content: [{ type: "tool_use", name: "x", input: {} }] }] }, "tool_use"],
  ];
  for (const [body, needle] of cases) {
    let caught = null;
    try {
      anthropic_messages_to_openai(body);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, `expected rejection for ${JSON.stringify(body)}`);
    assert.equal(caught.name, "AnthropicTranslateError");
    assert.equal(caught.status, 400);
    assert.match(caught.message, new RegExp(needle));
  }
});

// section: non-stream response translation

test("plain OpenAI completion maps to an Anthropic message with end_turn", () => {
  const anthropic = openai_to_anthropic_response(
    {
      id: "chatcmpl-abc123",
      object: "chat.completion",
      model: "deepseek-chat",
      choices: [{ index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    },
    "deepseek"
  );
  assert.equal(anthropic.type, "message");
  assert.equal(anthropic.role, "assistant");
  assert.equal(anthropic.id, "msg_abc123");
  assert.equal(anthropic.model, "deepseek-chat");
  assert.deepEqual(anthropic.content, [{ type: "text", text: "hello there" }]);
  assert.equal(anthropic.stop_reason, "end_turn");
  assert.deepEqual(anthropic.usage, { input_tokens: 12, output_tokens: 34 });
});

test("finish reason and tool_calls translate to max_tokens, tool_use, and refusal", () => {
  const truncated = openai_to_anthropic_response(
    { choices: [{ message: { content: "cut off" }, finish_reason: "length" }], usage: {} },
    "m"
  );
  assert.equal(truncated.stop_reason, "max_tokens");
  assert.deepEqual(truncated.usage, { input_tokens: 0, output_tokens: 0 });

  const tool = openai_to_anthropic_response(
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_9", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    "m"
  );
  assert.equal(tool.stop_reason, "tool_use");
  assert.deepEqual(tool.content, [{ type: "tool_use", id: "call_9", name: "bash", input: { cmd: "ls" } }]);

  const filtered = openai_to_anthropic_response(
    { choices: [{ message: { content: "no" }, finish_reason: "content_filter" }] },
    "m"
  );
  assert.equal(filtered.stop_reason, "refusal");
});

test("text plus tool calls in one completion keeps block order and parses bad arguments to {}", () => {
  const anthropic = openai_to_anthropic_response(
    {
      choices: [
        {
          message: {
            content: "working",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "f", arguments: "{broken json" } },
              { id: "c2", type: "function", function: { name: "g", arguments: "" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    "fallback-model"
  );
  assert.equal(anthropic.model, "fallback-model");
  assert.equal(anthropic.content[0].type, "text");
  assert.deepEqual(anthropic.content[1], { type: "tool_use", id: "c1", name: "f", input: {} });
  assert.deepEqual(anthropic.content[2], { type: "tool_use", id: "c2", name: "g", input: {} });
});

// section: streaming reducer

test("streamed text produces a valid anthropic SSE sequence with usage and stop mapping", () => {
  const chunks = [
    openai_chunk({ role: "assistant", content: null }),
    openai_chunk({ content: "Hello " }),
    openai_chunk({ content: "world" }),
    finish_chunk("length", { prompt_tokens: 20, completion_tokens: 5 }),
  ];
  const events = encode_all(chunks, { model: "kimi-k2" });
  validate_stream_events(events);

  const types = events.map((e) => e.data.type);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(events[0].data.message.model, "upstream-model"); // provider model replaces the fallback
  assert.equal(events[0].data.message.role, "assistant");
  const deltas = events.filter((e) => e.data.type === "content_block_delta").map((e) => e.data.delta.text);
  assert.equal(deltas.join(""), "Hello world");
  assert.equal(events.find((e) => e.data.type === "message_delta").data.delta.stop_reason, "max_tokens");
});

test("provider id replaces the synthetic message id and message_start is never repeated", () => {
  const encoder = new AnthropicStreamEncoder({ model: "fallback-m" });
  const first = encoder.feed(openai_chunk({ content: "x" }));
  const events = parse_anthropic_sse(first.join(""));
  assert.equal(events[0].data.message.id, "msg_test1"); // chatcmpl- prefix stripped
  assert.equal(events[0].data.message.model, "upstream-model"); // chunk model wins over fallback
  const more = encoder.feed(openai_chunk({ content: "y" }));
  assert.ok(!more.join("").includes("message_start"), "message_start must not repeat");
});

test("malformed JSON data and chunks without choices are survived; usage-only chunks still start the message", () => {
  const encoder = new AnthropicStreamEncoder({ model: "m" });
  assert.deepEqual(encoder.feed("data: {not json}\n\n"), []);
  assert.deepEqual(encoder.feed(""), []);
  const usage_only = encoder.feed({ id: "chatcmpl-u1", model: "upstream", usage: { prompt_tokens: 7, completion_tokens: 2 } });
  const events = parse_anthropic_sse(usage_only.join(""));
  assert.equal(events[0].data.type, "message_start");
  assert.equal(events[0].data.message.id, "msg_u1");
  assert.equal(events[0].data.message.model, "upstream"); // provider model replaces the fallback
  const tail = parse_anthropic_sse(encoder.terminate().join(""));
  validate_stream_events(events.concat(tail));
  const final_usage = tail.find((e) => e.data.type === "message_delta").data.usage;
  assert.equal(final_usage.output_tokens, 2);
});

test("terminal [DONE] string terminates the stream and further feeds are inert", () => {
  const encoder = new AnthropicStreamEncoder({ model: "m" });
  const first = encoder.feed(openai_chunk({ content: "a" }));
  const closing = encoder.feed("[DONE]");
  const events = parse_anthropic_sse(first.concat(closing).join(""));
  validate_stream_events(events);
  assert.equal(events[events.length - 1].data.type, "message_stop");
  assert.equal(encoder.done, true);
  assert.deepEqual(encoder.feed(openai_chunk({ content: "b" })), []);
  assert.deepEqual(encoder.terminate(), []);
});

test("streamed multiple tool calls open one block per call and close each exactly once", () => {
  const chunks = [
    openai_chunk({
      tool_calls: [
        { index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "" } },
        { index: 1, id: "call_b", type: "function", function: { name: "write", arguments: "" } },
      ],
    }),
    openai_chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path' } }] }),
    openai_chunk({ tool_calls: [{ index: 0, function: { arguments: '":"a.txt"}' } }] }),
    openai_chunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"b.txt"}' } }] }),
    finish_chunk("tool_calls", { prompt_tokens: 30, completion_tokens: 12 }),
    "[DONE]",
  ];
  const encoder = new AnthropicStreamEncoder({ model: "m" });
  const frames = [];
  for (const chunk of chunks) frames.push(...encoder.feed(chunk));
  const events = parse_anthropic_sse(frames.join(""));
  validate_stream_events(events);

  const starts = events.filter((e) => e.data.type === "content_block_start");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map((e) => e.data.content_block.id), ["call_a", "call_b"]);
  assert.deepEqual(starts.map((e) => e.data.content_block.name), ["read", "write"]);
  assert.deepEqual(starts.map((e) => e.data.index), [0, 1]);
  const stops = events.filter((e) => e.data.type === "content_block_stop");
  assert.deepEqual(stops.map((e) => e.data.index), [0, 1]);

  const json_a = events
    .filter((e) => e.data.type === "content_block_delta" && e.data.index === 0)
    .map((e) => e.data.delta.partial_json)
    .join("");
  assert.equal(json_a, '{"path":"a.txt"}');
  const message_delta = events.find((e) => e.data.type === "message_delta");
  assert.equal(message_delta.data.delta.stop_reason, "tool_use");
  assert.equal(message_delta.data.usage.output_tokens, 12);
});

test("text then tool then text yields three sequentially indexed blocks", () => {
  const chunks = [
    openai_chunk({ content: "before " }),
    openai_chunk({ content: "text" }),
    openai_chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }] }),
    openai_chunk({ content: "after" }),
    finish_chunk("stop"),
  ];
  const events = encode_all(chunks, { model: "m" });
  validate_stream_events(events);
  const starts = events.filter((e) => e.data.type === "content_block_start");
  assert.deepEqual(starts.map((e) => [e.data.index, e.data.content_block.type]), [
    [0, "text"],
    [1, "tool_use"],
    [2, "text"],
  ]);
  const last_text = events.filter((e) => e.data.type === "content_block_delta" && e.data.delta.type === "text_delta" && e.data.index === 2);
  assert.equal(last_text.map((e) => e.data.delta.text).join(""), "after");
});

test("mid-stream provider failure still closes blocks once with a synthesized terminal frame", () => {
  const encoder = new AnthropicStreamEncoder({ model: "m" });
  const frames = [];
  frames.push(...encoder.feed(openai_chunk({ content: "half a sentence" })));
  frames.push(...encoder.feed(openai_chunk({ tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: '{"a"' } }] })));
  // provider socket dies here — the gateway calls terminate()
  frames.push(...encoder.terminate());
  const events = parse_anthropic_sse(frames.join(""));
  validate_stream_events(events);
  const stop_reason = events.find((e) => e.data.type === "message_delta").data.delta.stop_reason;
  assert.equal(stop_reason, "end_turn"); // no finish_reason arrived
});

test("include_ping emits a ping right after message_start", () => {
  const events = encode_all([openai_chunk({ content: "hi" })], { model: "m", include_ping: true });
  assert.equal(events[0].data.type, "message_start");
  assert.equal(events[1].data.type, "ping");
  validate_stream_events(events);
});

// section: route handler end-to-end (local stub servers only, no provider traffic)

function post(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function handler_env({ dispatch, on_done }) {
  const handler = createAnthropicMessagesHandler({ dispatch, on_done });
  const server = await listen(http.createServer((req, res) => {
    res.on("error", () => {});
    handler(req, res);
  }));
  return { url: `http://127.0.0.1:${server.address().port}/v1/messages`, server };
}

test("handler translates an Aider-style non-stream request and returns an Anthropic JSON message", async () => {
  let dispatched_body = null;
  const upstream = {
    id: "chatcmpl-real9",
    model: "deepseek-chat",
    choices: [{ index: 0, message: { role: "assistant", content: "const x = 1;" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 15, completion_tokens: 4 },
  };
  const dispatch = async (openai_body) => {
    dispatched_body = openai_body;
    return {
      response: new Response(JSON.stringify(upstream), { headers: { "content-type": "application/json" } }),
      profile_name: "deepseek",
      upstream_model: "deepseek-chat",
    };
  };
  let done_usage = null;
  const on_done = (usage, profile, model) => {
    done_usage = { usage, profile, model };
  };
  const env = await handler_env({ dispatch, on_done });
  try {
    const res = await post(env.url, {
      model: "deepseek",
      max_tokens: 1000,
      system: "You pair-program.",
      messages: [{ role: "user", content: "declare x = 1" }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const json = await res.json();
    assert.equal(json.type, "message");
    assert.equal(json.content[0].text, "const x = 1;");
    assert.equal(json.stop_reason, "end_turn");
    assert.deepEqual(json.usage, { input_tokens: 15, output_tokens: 4 });

    assert.equal(dispatched_body.messages[0].role, "system");
    assert.equal(dispatched_body.max_tokens, 1000);
    assert.equal(dispatched_body.stream, undefined);
    assert.deepEqual(done_usage, {
      usage: { prompt_tokens: 15, completion_tokens: 4 },
      profile: "deepseek",
      model: "deepseek-chat",
    });
  } finally {
    await close(env.server);
  }
});

test("handler streams Anthropic SSE for a stream:true request ending in [DONE]", async () => {
  const sse = [
    `data: ${openai_chunk({ content: "strea" })}\n\n`,
    `data: ${openai_chunk({ content: "ming" })}\n\n`,
    `data: ${finish_chunk("stop", { prompt_tokens: 9, completion_tokens: 2 })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const dispatch = async () => ({
    response: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    profile_name: "kimi",
    upstream_model: "kimi-k2",
  });
  let done_usage = null;
  const env = await handler_env({ dispatch, on_done: (u) => (done_usage = u) });
  try {
    const res = await post(env.url, {
      model: "kimi",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "stream it" }],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const events = parse_anthropic_sse(await res.text());
    validate_stream_events(events);
    const text = events
      .filter((e) => e.data.type === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join("");
    assert.equal(text, "streaming");
    assert.equal(events[0].data.message.model, "upstream-model"); // first chunk's model wins
    assert.equal(done_usage.completion_tokens, 2);
    assert.equal(done_usage.prompt_tokens, 9);
  } finally {
    await close(env.server);
  }
});

test("handler streams tool_use blocks for a streamed tool call", async () => {
  const sse = [
    `data: ${openai_chunk({ tool_calls: [{ index: 0, id: "call_x", function: { name: "grep", arguments: "" } }] })}\n\n`,
    `data: ${openai_chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pat' } }] })}\n\n`,
    `data: ${openai_chunk({ tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] })}\n\n`,
    `data: ${finish_chunk("tool_calls")}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const dispatch = async () => ({
    response: new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    profile_name: "ollama",
    upstream_model: "qwen3:8b",
  });
  const env = await handler_env({ dispatch });
  try {
    const res = await post(env.url, {
      model: "ollama/qwen3:8b",
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: "grep x" }],
      tools: [{ name: "grep", input_schema: { type: "object", properties: { pattern: { type: "string" } } } }],
    });
    const events = parse_anthropic_sse(await res.text());
    validate_stream_events(events);
    const start = events.find((e) => e.data.type === "content_block_start");
    assert.equal(start.data.content_block.type, "tool_use");
    assert.equal(start.data.content_block.id, "call_x");
    const json = events
      .filter((e) => e.data.delta && e.data.delta.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    assert.equal(json, '{"pattern":"x"}');
    assert.equal(events.find((e) => e.data.type === "message_delta").data.delta.stop_reason, "tool_use");
  } finally {
    await close(env.server);
  }
});

test("handler rejects invalid bodies with Anthropic-shaped 400 and failover with 502 attempts", async () => {
  const dispatch_fail = async () => {
    const err = new Error("all providers failed");
    err.attempts = [{ profile: "deepseek", error: "http 503" }];
    throw err;
  };
  const env = await handler_env({ dispatch: dispatch_fail });
  try {
    const bad = await post(env.url, { model: "deepseek", messages: [{ role: "user", content: "no max_tokens" }] });
    assert.equal(bad.status, 400);
    const bad_json = await bad.json();
    assert.equal(bad_json.error.type, "invalid_request_error");
    assert.match(bad_json.error.message, /max_tokens/);

    const down = await post(env.url, { model: "deepseek", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    assert.equal(down.status, 502);
    const down_json = await down.json();
    assert.equal(down_json.error.message, "all providers failed");
    assert.deepEqual(down_json.error.attempts, [{ profile: "deepseek", error: "http 503" }]);

    const missing = await post(env.url.replace("/v1/messages", "/v1/nope"), { model: "m", max_tokens: 1, messages: [] });
    assert.equal(missing.status, 404);
  } finally {
    await close(env.server);
  }
});

test("mid-stream drop still emits a complete Anthropic message for what arrived", async () => {
  // same socket-death pattern as test/midstream.test.js: bytes are flushed to
  // the wire before destroy(), so the client keeps what it already received
  const upstream = await listen(
    http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${openai_chunk({ content: "partial words" })}\n\n`);
      setTimeout(() => res.destroy(), 30); // die after the frame is on the wire, before [DONE]
    })
  );
  const dispatch = async (openai_body) => {
    const response = await fetch(`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(openai_body),
    });
    return { response, profile_name: "stub", upstream_model: "stub-model" };
  };
  const env = await handler_env({ dispatch });
  try {
    const res = await post(env.url, { model: "stub", max_tokens: 32, stream: true, messages: [{ role: "user", content: "go" }] });
    const events = parse_anthropic_sse(await res.text());
    validate_stream_events(events);
    const text = events.filter((e) => e.data.delta && e.data.delta.type === "text_delta").map((e) => e.data.delta.text).join("");
    assert.equal(text, "partial words");
  } finally {
    await close(env.server);
    await close(upstream);
  }
});
