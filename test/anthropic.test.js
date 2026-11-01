const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { PassThrough } = require("node:stream");

const {
  AnthropicStreamEncoder,
  anthropic_messages_to_openai,
  default_read_body,
  openai_to_anthropic_response,
  parse_anthropic_sse,
  createAnthropicMessagesHandler,
} = require("../lib/anthropic");

// Block types the audit demands be rejected out loud rather than dropped.
const UNSUPPORTED_BLOCK_TYPES = [
  "document",
  "search_result",
  "thinking",
  "redacted_thinking",
  "tool_reference",
  "web_search_tool_result",
  "some_future_block",
];

function capture_error(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

function stream_req(buffers, headers = {}) {
  const req = new PassThrough();
  req.headers = headers;
  req.on("error", () => {});
  for (const buf of buffers) req.write(buf);
  req.end();
  return req;
}

async function drain(req) {
  if (!req.readableEnded) await new Promise((resolve) => req.once("end", resolve));
}

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
  assert.equal(openai.temperature, 0.7); // Anthropic's 0-1 scale, forwarded verbatim (no invented rescaling)
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

// section: object tool_choice forms

test("object tool_choice forms map to OpenAI and every unusable form raises a 400", () => {
  const with_choice = (tool_choice) =>
    anthropic_messages_to_openai({ max_tokens: 8, messages: [{ role: "user", content: "hi" }], tool_choice });

  assert.equal(with_choice("auto").tool_choice, "auto");
  assert.equal(with_choice("any").tool_choice, "required");
  assert.equal(with_choice("required").tool_choice, "required");
  assert.equal(with_choice("none").tool_choice, "none");
  assert.equal(with_choice({ type: "auto" }).tool_choice, "auto");
  assert.equal(with_choice({ type: "any" }).tool_choice, "required");
  assert.equal(with_choice({ type: "none" }).tool_choice, "none");
  assert.deepEqual(with_choice({ type: "tool", name: "lookup" }).tool_choice, {
    type: "function",
    function: { name: "lookup" },
  });
  assert.deepEqual(with_choice({ type: "function", function: { name: "lookup" } }).tool_choice, {
    type: "function",
    function: { name: "lookup" },
  });
  assert.equal(with_choice(undefined).tool_choice, undefined);
  assert.equal(with_choice(null).tool_choice, undefined);

  const rejected = [
    [{ type: "mcp_tool" }, "mcp_tool"],
    [{ type: "tool" }, '"tool"'],
    [{ type: "tool", name: "" }, '"tool"'],
    [{ type: "function" }, '"function"'],
    [{ type: "function", function: {} }, '"function"'],
    [{ type: "required" }, "required"],
    ["sometimes", "sometimes"],
    [42, "42"],
    [["auto"], "auto"],
  ];
  for (const [choice, needle] of rejected) {
    const err = capture_error(() => with_choice(choice));
    assert.ok(err, `expected tool_choice ${JSON.stringify(choice)} to be rejected, not ignored`);
    assert.equal(err.name, "AnthropicTranslateError");
    assert.equal(err.status, 400);
    assert.match(err.message, new RegExp(needle));
    assert.match(err.message, /supported forms/);
  }
});

// section: sampling params keep Anthropic's own scale

test("temperature and top_p travel on Anthropic's 0-1 scale and bad values raise a 400", () => {
  const base = { max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
  assert.equal(anthropic_messages_to_openai({ ...base, temperature: 0 }).temperature, 0);
  assert.equal(anthropic_messages_to_openai({ ...base, temperature: 0.25 }).temperature, 0.25);
  assert.equal(anthropic_messages_to_openai({ ...base, temperature: 1 }).temperature, 1);
  assert.equal(anthropic_messages_to_openai({ ...base, top_p: 0.01 }).top_p, 0.01);
  assert.equal(anthropic_messages_to_openai({ ...base, top_p: 1 }).top_p, 1);

  for (const bad of [1.5, -0.1, "hot", Number.NaN, Number.POSITIVE_INFINITY, true]) {
    const err = capture_error(() => anthropic_messages_to_openai({ ...base, temperature: bad }));
    assert.ok(err, `expected temperature ${String(bad)} to be rejected`);
    assert.equal(err.name, "AnthropicTranslateError");
    assert.match(err.message, /temperature/);
    assert.match(err.message, /between 0 and 1/);
  }
  for (const bad of [2, -1]) {
    const err = capture_error(() => anthropic_messages_to_openai({ ...base, top_p: bad }));
    assert.ok(err, `expected top_p ${bad} to be rejected`);
    assert.match(err.message, /top_p/);
  }
});

test("top_k is accepted and dropped, never smuggled into another field", () => {
  const openai = anthropic_messages_to_openai({ max_tokens: 8, top_k: 40, messages: [{ role: "user", content: "hi" }] });
  assert.equal(openai.top_k, undefined);
  assert.equal(openai.temperature, undefined);
  assert.equal(openai.top_p, undefined);
});

// section: image blocks

test("base64 and url image blocks become OpenAI image_url parts in arrival order", () => {
  const openai = anthropic_messages_to_openai({
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in these?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
          { type: "text", text: "answer briefly" },
        ],
      },
    ],
  });
  assert.deepEqual(openai.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "what is in these?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        { type: "text", text: "answer briefly" },
      ],
    },
  ]);
});

test("an image-only user turn still reaches the model as vision content", () => {
  const openai = anthropic_messages_to_openai({
    max_tokens: 64,
    messages: [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/gif", data: "R0lGODdh" } }] },
    ],
  });
  assert.deepEqual(openai.messages, [
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/gif;base64,R0lGODdh" } }] },
  ]);
});

test("assistant history mixing text, image and tool_use keeps every part", () => {
  const openai = anthropic_messages_to_openai({
    max_tokens: 64,
    messages: [
      { role: "user", content: "screenshot then open it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "image", source: { type: "base64", media_type: "image/webp", data: "UklGRhoA" } },
          { type: "tool_use", id: "tc_1", name: "open", input: { url: "x" } },
        ],
      },
    ],
  });
  const assistant = openai.messages[1];
  assert.deepEqual(assistant.content, [
    { type: "text", text: "looking" },
    { type: "image_url", image_url: { url: "data:image/webp;base64,UklGRhoA" } },
  ]);
  assert.deepEqual(assistant.tool_calls, [
    { id: "tc_1", type: "function", function: { name: "open", arguments: '{"url":"x"}' } },
  ]);
});

test("tool_result content with text and image blocks becomes a parts array on the tool message", () => {
  const openai = anthropic_messages_to_openai({
    max_tokens: 64,
    messages: [
      { role: "user", content: "capture the screen" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shot", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "captured" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
            ],
          },
        ],
      },
    ],
  });
  const tool = openai.messages[2];
  assert.equal(tool.role, "tool");
  assert.equal(tool.tool_call_id, "t1");
  assert.deepEqual(tool.content, [
    { type: "text", text: "captured" },
    { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
  ]);
});

test("unsupported image media types and malformed image sources raise a 400 naming the value", () => {
  const message_with = (block) =>
    capture_error(() =>
      anthropic_messages_to_openai({ max_tokens: 8, messages: [{ role: "user", content: [block] }] })
    );

  const pdf = message_with({ type: "image", source: { type: "base64", media_type: "application/pdf", data: "JV" } });
  assert.equal(pdf.name, "AnthropicTranslateError");
  assert.equal(pdf.status, 400);
  assert.match(pdf.message, /application\/pdf/);
  assert.match(pdf.message, /image\/jpeg, image\/png, image\/gif, image\/webp/);

  const no_media = message_with({ type: "image", source: { type: "base64", data: "iVBOR" } });
  assert.match(no_media.message, /undefined/);
  assert.match(no_media.message, /media_type/);

  const no_source = message_with({ type: "image" });
  assert.match(no_source.message, /image content block/i);
  assert.match(no_source.message, /source/);

  const no_data = message_with({ type: "image", source: { type: "base64", media_type: "image/png" } });
  assert.match(no_data.message, /data/);

  const no_url = message_with({ type: "image", source: { type: "url" } });
  assert.match(no_url.message, /url/);

  const bad_source_type = message_with({ type: "image", source: { type: "file", media_type: "image/png", data: "x" } });
  assert.match(bad_source_type.message, /"file"/);
  assert.match(bad_source_type.message, /base64/);
});

test("a large base64 image is translated, not clipped; only the body limit gates size", () => {
  const big_data = "A".repeat(3 * 1024 * 1024);
  const openai = anthropic_messages_to_openai({
    max_tokens: 64,
    messages: [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: big_data } }] },
    ],
  });
  assert.equal(openai.messages[0].content[0].image_url.url, `data:image/png;base64,${big_data}`);
});

// section: unsupported blocks are rejected, never dropped

test("unsupported content block types raise a 400 naming the block, in every position", () => {
  for (const type of UNSUPPORTED_BLOCK_TYPES) {
    const in_user = capture_error(() =>
      anthropic_messages_to_openai({ max_tokens: 8, messages: [{ role: "user", content: [{ type, id: 1 }] }] })
    );
    for (const [err, where] of [
      [in_user, "user content"],
      [
        capture_error(() =>
          anthropic_messages_to_openai({
            max_tokens: 8,
            messages: [
              { role: "user", content: "go" },
              { role: "assistant", content: [{ type }] },
            ],
          })
        ),
        "assistant content",
      ],
      [
        capture_error(() =>
          anthropic_messages_to_openai({
            max_tokens: 8,
            messages: [
              { role: "user", content: "go" },
              { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
              { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type }] }] },
            ],
          })
        ),
        "tool_result content",
      ],
      [
        capture_error(() =>
          anthropic_messages_to_openai({ max_tokens: 8, system: [{ type }], messages: [{ role: "user", content: "go" }] })
        ),
        "system prompt",
      ],
    ]) {
      assert.ok(err, `${where}: expected block type "${type}" to be rejected instead of silently dropped`);
      assert.equal(err.name, "AnthropicTranslateError", where);
      assert.equal(err.status, 400, where);
      assert.match(err.message, new RegExp(`"${type}"`), where);
      assert.match(err.message, /unsupported/i, where);
      assert.match(err.message, /does not translate it/, where);
    }
  }
});

test("a non-text block in the system prompt is rejected with the system prompt named", () => {
  const err = capture_error(() =>
    anthropic_messages_to_openai({
      max_tokens: 8,
      system: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
      messages: [{ role: "user", content: "hi" }],
    })
  );
  assert.equal(err.status, 400);
  assert.match(err.message, /image/);
  assert.match(err.message, /system prompt/);
});

test("content blocks that are not objects, and text blocks without string text, are rejected", () => {
  const string_block = capture_error(() =>
    anthropic_messages_to_openai({ max_tokens: 8, messages: [{ role: "user", content: ["just a string"] }] })
  );
  assert.equal(string_block.status, 400);
  assert.match(string_block.message, /must be objects/);

  const no_type = capture_error(() =>
    anthropic_messages_to_openai({ max_tokens: 8, messages: [{ role: "user", content: [{ text: "orphan" }] }] })
  );
  assert.equal(no_type.status, 400);
  assert.match(no_type.message, /missing a string "type" field/);

  const bad_text = capture_error(() =>
    anthropic_messages_to_openai({ max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: 42 }] }] })
  );
  assert.equal(bad_text.status, 400);
  assert.match(bad_text.message, /text content block/);
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

// section: request body size limit

test("default_read_body rejects over the limit with 413 and never buffers the remainder", async () => {
  const req = stream_req([Buffer.alloc(400, 0x61), Buffer.alloc(400, 0x62), Buffer.alloc(400, 0x63)]);
  const delivered = [];
  req.on("data", (chunk) => delivered.push(chunk.length));

  let err = null;
  let resolved = null;
  try {
    resolved = await default_read_body(req, { max_bytes: 1000 });
  } catch (caught) {
    err = caught;
  }
  assert.equal(resolved, null, "an oversized body must not resolve");
  assert.equal(err.name, "AnthropicTranslateError");
  assert.equal(err.status, 413);
  assert.match(err.message, /1000 byte limit exceeded/);
  assert.match(err.message, /OVERRAIL_MAX_BODY_BYTES/);
  // the rejection lands the moment the running total passes the limit, and the
  // rest is drained off the socket instead of being buffered
  assert.deepEqual(delivered, [400, 400, 400]);
  await drain(req);
});

test("default_read_body accepts a body under the limit and returns it whole", async () => {
  const body = Buffer.from('{"max_tokens":8}', "utf8");
  const req = stream_req([body], { "content-length": String(body.length) });
  const text = await default_read_body(req, { max_bytes: 1000 });
  assert.equal(text, '{"max_tokens":8}');
});

test("default_read_body rejects a content-length header that already exceeds the limit", async () => {
  const req = stream_req([Buffer.from("tiny")], { "content-length": "5000" });
  let err = null;
  try {
    await default_read_body(req, { max_bytes: 1000 });
  } catch (caught) {
    err = caught;
  }
  assert.equal(err.status, 413);
  assert.match(err.message, /1000 byte limit exceeded/);
  await drain(req);
});

test("default_read_body takes the limit from OVERRAIL_MAX_BODY_BYTES and falls back when it is unusable", async () => {
  process.env.OVERRAIL_MAX_BODY_BYTES = "300";
  try {
    let err = null;
    try {
      await default_read_body(stream_req([Buffer.alloc(400, 0x61)]));
    } catch (caught) {
      err = caught;
    }
    assert.equal(err.status, 413);
    assert.match(err.message, /300 byte limit exceeded/);

    process.env.OVERRAIL_MAX_BODY_BYTES = "not-a-number";
    const text = await default_read_body(stream_req([Buffer.alloc(400, 0x61)]));
    assert.equal(text.length, 400, "an unparseable env value falls back to the 32 MiB default, not to zero");
  } finally {
    delete process.env.OVERRAIL_MAX_BODY_BYTES;
  }
});

test("handler answers an Anthropic-shaped 413 before the body is fully uploaded", async () => {
  const dispatch = async () => {
    throw new Error("dispatch must not run for an oversized body");
  };
  const env = await handler_env({ dispatch });
  const previous = process.env.OVERRAIL_MAX_BODY_BYTES;
  process.env.OVERRAIL_MAX_BODY_BYTES = "512";
  try {
    const res = await post(env.url, {
      model: "deepseek",
      max_tokens: 10,
      messages: [{ role: "user", content: "x".repeat(4000) }],
    });
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.type, "error");
    assert.match(json.error.message, /512 byte limit exceeded/);
    assert.match(json.error.message, /OVERRAIL_MAX_BODY_BYTES/);
  } finally {
    if (previous === undefined) delete process.env.OVERRAIL_MAX_BODY_BYTES;
    else process.env.OVERRAIL_MAX_BODY_BYTES = previous;
    await close(env.server);
  }
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
