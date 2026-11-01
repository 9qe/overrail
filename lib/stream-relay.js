const { Readable } = require("node:stream");
const { StringDecoder } = require("node:string_decoder");

async function* sse_events(body) {
  const stream = Readable.fromWeb(body);
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data_lines = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (data_lines.length > 0) yield data_lines.join("\n");
    }
  }
  buffer += decoder.end();
  const tail = buffer.trim();
  if (tail) {
    const data_lines = tail
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (data_lines.length > 0) yield data_lines.join("\n");
  }
}

function sum_usage(total, usage) {
  if (!usage || typeof usage !== "object") return;
  for (const key of ["prompt_tokens", "completion_tokens"]) {
    if (typeof usage[key] === "number" && Number.isFinite(usage[key])) {
      total[key] = (total[key] || 0) + usage[key];
    }
  }
}

function reidentify(chunk, base) {
  return { ...chunk, id: base.id, created: base.created, model: base.model };
}

// a delta can carry content AND tool_calls at once: the live content frame is
// stripped of the (not yet validated) tool args, and the buffered frame is
// stripped of the (already delivered) content, so each field reaches the
// client exactly once and partial args never leak. finish_reason is stripped
// from any forwarded frame too — the gateway synthesizes the one authoritative
// finish chunk (with merged usage), and the client must not see two.
function strip_chunk_fields(chunk, fields) {
  const copy = { ...chunk };
  if (Array.isArray(copy.choices)) {
    copy.choices = copy.choices.map((choice, i) => {
      if (i !== 0 || !choice) return choice;
      const stripped = { ...choice };
      for (const field of fields) delete stripped[field];
      if (stripped.delta) {
        stripped.delta = { ...stripped.delta };
        for (const field of fields) delete stripped.delta[field];
      }
      return stripped;
    });
  }
  return copy;
}

function sse_frame(data) {
  return `data: ${String(data).split(/\r?\n/).join("\ndata: ")}\n\n`;
}

function openai_error(res, err) {
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "all providers failed", details: err.attempts || [] } }));
}

function create_openai_client({ res, content_type }) {
  let headers_sent = false;
  const ensure_headers = () => {
    if (headers_sent) return;
    headers_sent = true;
    res.writeHead(200, { "content-type": content_type || "text/event-stream" });
  };
  const write = (text) => {
    ensure_headers();
    res.write(text);
  };

  return {
    protocol: "openai",
    ensure_headers,
    heartbeat: () => write(": keep-alive\n\n"),
    forward: ({ chunk, raw, base }) => {
      write(sse_frame(chunk && base ? JSON.stringify(reidentify(chunk, base)) : raw));
    },
    finish: ({ finish_reason, usage, base }) => {
      if (!usage.saw_finish_chunk && usage.usage.completion_tokens === null) return;
      const final_chunk = {
        id: base ? base.id : "chatcmpl-overrail",
        object: "chat.completion.chunk",
        created: base ? base.created : Math.floor(Date.now() / 1000),
        model: base ? base.model : "unknown",
        choices: [{ index: 0, delta: {}, finish_reason: finish_reason || "stop" }],
      };
      if (usage.usage.completion_tokens !== null) final_chunk.usage = usage.usage;
      write(sse_frame(JSON.stringify(final_chunk)));
    },
    complete: () => {
      write("data: [DONE]\n\n");
      res.end();
    },
    abort: (err) => {
      if (!headers_sent) {
        openai_error(res, err);
        return;
      }
      res.destroy();
    },
  };
}

class Drop extends Error {}

async function relay_stream({
  res,
  first_winner,
  parsed_body,
  attempt_chain,
  chaos_drop_at,
  on_done,
  client = create_openai_client({
    res,
    content_type: first_winner && first_winner.response ? first_winner.response.headers.get("content-type") : null,
  }),
  recovery = null,
}) {
  const state = {
    base: null,
    content: "",
    sent_anything: false,
    finish_reason: null,
    saw_finish_chunk: false,
    usage: { prompt_tokens: null, completion_tokens: null },
    tools: new Map(),
    tool_chunks: [],
    completed_tools: [],
    heartbeat: null,
    leg: 0,
    winner: first_winner,
  };

  const update_heartbeat = () => {
    const pending = state.tool_chunks.length > 0;
    if (pending && !state.heartbeat) {
      state.heartbeat = setInterval(() => client.heartbeat(), 5000);
      state.heartbeat.unref();
    } else if (!pending && state.heartbeat) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
  };

  const tool_values = () =>
    [...state.tools.values()].filter((tool) => tool.id && tool.name).map((tool) => ({
      id: tool.id,
      type: "function",
      function: { name: tool.name, arguments: tool.args },
    }));

  const record_generated = () => {
    if (!recovery || !recovery.record) return;
    recovery.record(tool_values(), "generated", state.winner);
  };

  const flush_tools = () => {
    const all_complete = [...state.tools.values()].every((tool) => {
      try {
        JSON.parse(tool.args);
        return true;
      } catch {
        return false;
      }
    });
    if (!all_complete) return;
    const newly_completed = tool_values();
    for (const pending of state.tool_chunks) {
      client.forward({ chunk: pending.chunk, raw: pending.raw, base: state.base });
      state.sent_anything = true;
    }
    state.completed_tools.push(...newly_completed);
    if (recovery && recovery.record && newly_completed.length > 0) {
      recovery.record(newly_completed, "offered", state.winner);
    }
    state.tools.clear();
    state.tool_chunks = [];
    update_heartbeat();
  };

  const stop_heartbeat = () => {
    if (state.heartbeat) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
  };

  const finish = () => {
    stop_heartbeat();
    client.finish({
      finish_reason: state.finish_reason || "stop",
      usage: state,
      base: state.base,
    });
    client.complete();
    on_done(state.usage, state.winner.profile_name, state.winner.upstream_model);
  };

  const abort = (err) => {
    stop_heartbeat();
    client.abort(err);
  };

  const continuation_for_completed_tools = async () => {
    if (recovery && recovery.history) {
      const known_arguments = Object.fromEntries(
        state.completed_tools.map((call) => [call.id, call.function.arguments]),
      );
      const history = recovery.history({ known_arguments, assistant_content: state.content });
      const messages = Array.isArray(history.messages) ? history.messages : [];
      if (messages.length > 0) {
        state.winner = await attempt_chain(parsed_body, messages);
        state.completed_tools = [];
        state.leg += 1;
        return true;
      }
    }

    const history = [
      {
        role: "assistant",
        content: state.content || null,
        tool_calls: state.completed_tools,
      },
      ...state.completed_tools.map((call) => ({
        role: "tool",
        tool_call_id: call.id,
        content: "(already received by the client; generate only the remaining tool calls)",
      })),
    ];
    state.winner = await attempt_chain(parsed_body, history);
    state.completed_tools = [];
    state.leg += 1;
    return true;
  };

  for (;;) {
    if (state.leg >= 6) {
      abort(new Error("too many mid-stream continuations"));
      return;
    }
    let dropped = false;
    let content_events = 0;
    let saw_done = false;
    const response = state.winner.response;
    try {
      if (!response.body) throw new Drop("empty stream");
      for await (const data of sse_events(response.body)) {
        if (data === "[DONE]") {
          saw_done = true;
          break;
        }
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new Drop(chunk.error.message || "upstream error event");
        if (!state.base && chunk.id) {
          state.base = { id: chunk.id, created: chunk.created, model: chunk.model };
        }
        if (chunk.usage) sum_usage(state.usage, chunk.usage);
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
        if (!choice) {
          if (!chunk.usage) {
            client.forward({ chunk, raw: data, base: state.base });
            state.sent_anything = true;
          }
          continue;
        }
        if (choice.finish_reason) {
          state.finish_reason = choice.finish_reason;
          state.saw_finish_chunk = true;
          // no continue: a finish frame can still carry final content or tool deltas
        }
        const delta = choice.delta || {};
        const has_content = Boolean(delta.content);
        const has_tools = Array.isArray(delta.tool_calls);
        if (has_content) {
          state.content += delta.content;
          content_events += 1;
          const live_fields = [];
          if (has_tools) live_fields.push("tool_calls");
          if (choice.finish_reason) live_fields.push("finish_reason");
          const live_chunk = live_fields.length ? strip_chunk_fields(chunk, live_fields) : chunk;
          client.forward({ chunk: live_chunk, raw: data, base: state.base });
          state.sent_anything = true;
          if (state.leg === 0 && chaos_drop_at && content_events >= chaos_drop_at) {
            throw new Drop(`chaos midstream drop after ${chaos_drop_at} content events`);
          }
        }
        if (has_tools) {
          for (const call_delta of delta.tool_calls) {
            const key = typeof call_delta.index === "number" ? call_delta.index : 0;
            if (!state.tools.has(key)) state.tools.set(key, { args: "", id: null, name: null });
            const tool = state.tools.get(key);
            if (call_delta.id) tool.id = call_delta.id;
            if (call_delta.function) {
              if (call_delta.function.name) tool.name = call_delta.function.name;
              if (typeof call_delta.function.arguments === "string") {
                tool.args += call_delta.function.arguments;
              }
            }
          }
          const buffered_fields = [];
          if (has_content) buffered_fields.push("content");
          if (choice.finish_reason) buffered_fields.push("finish_reason");
          const buffered_chunk = buffered_fields.length ? strip_chunk_fields(chunk, buffered_fields) : chunk;
          state.tool_chunks.push({ chunk: buffered_chunk, raw: data });
          update_heartbeat();
          flush_tools();
        }
        if (!has_content && !has_tools && !choice.finish_reason) {
          client.forward({ chunk, raw: data, base: state.base });
          state.sent_anything = true;
        }
      }
    } catch (err) {
      dropped = true;
      try {
        if (response.body) await response.body.cancel();
      } catch {}
    }

    if (!dropped && saw_done) {
      finish();
      return;
    }
    if (!dropped && state.saw_finish_chunk) {
      finish();
      return;
    }

    record_generated();
    state.tools.clear();
    state.tool_chunks = [];
    update_heartbeat();

    try {
      if (state.completed_tools.length > 0) {
        await continuation_for_completed_tools();
        continue;
      }

      if (!state.sent_anything || !state.content) {
        state.winner = await attempt_chain(parsed_body, null);
        state.leg += 1;
        continue;
      }

      const prefill = { role: "assistant", content: state.content };
      const recovery_history =
        recovery && recovery.history
          ? recovery.history({ known_arguments: {}, assistant_content: state.content })
          : null;
      const extra = recovery_history && recovery_history.messages.length > 0 ? [prefill, ...recovery_history.messages.filter((m) => m.role !== "assistant" || m.tool_calls)] : prefill;
      try {
        state.winner = await attempt_chain(parsed_body, extra);
      } catch (err) {
        if (!/status 400/.test(err.message || "")) throw err;
        const synthetic = {
          role: "user",
          content: `Continue exactly from where this partial response stopped, with no preamble and no repetition:\n\n${state.content}`,
        };
        state.winner = await attempt_chain(parsed_body, Array.isArray(extra) ? [synthetic, ...extra.slice(1)] : synthetic);
      }
      state.leg += 1;
    } catch (err) {
      abort(err);
      return;
    }
  }
}

module.exports = { relay_stream, create_openai_client, sse_frame };
