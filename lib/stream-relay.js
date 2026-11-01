const { Readable } = require("node:stream");

async function* sse_events(body) {
  const stream = Readable.fromWeb(body);
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
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

class Drop extends Error {}

async function relay_stream({ res, first_winner, parsed_body, attempt_chain, chaos_drop_at, on_done }) {
  const state = {
    base: null,
    content: "",
    sent_anything: false,
    finish_reason: null,
    saw_finish_chunk: false,
    usage: { prompt_tokens: null, completion_tokens: null },
    tools: new Map(),
    tool_chunks: [],
    heartbeat: null,
    leg: 0,
    winner: first_winner,
    headers_sent: false,
  };

  const ensure_headers = () => {
    if (state.headers_sent) return;
    state.headers_sent = true;
    res.writeHead(200, {
      "content-type": first_winner.response.headers.get("content-type") || "text/event-stream",
    });
  };

  const write = (text) => {
    ensure_headers();
    res.write(text);
  };

  const update_heartbeat = () => {
    const pending = state.tool_chunks.length > 0;
    if (pending && !state.heartbeat) {
      state.heartbeat = setInterval(() => write(": keep-alive\n\n"), 5000);
      state.heartbeat.unref();
    } else if (!pending && state.heartbeat) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
  };

  const forward = (chunk, raw) => {
    write(`data: ${state.leg === 0 ? raw : JSON.stringify(reidentify(chunk, state.base))}\n\n`);
    state.sent_anything = true;
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
    for (const pending of state.tool_chunks) forward(pending.chunk, pending.raw);
    state.tool_chunks = [];
    update_heartbeat();
  };

  const finish = () => {
    if (state.heartbeat) clearInterval(state.heartbeat);
    if (state.saw_finish_chunk || state.usage.completion_tokens !== null) {
      const final_chunk = {
        id: state.base ? state.base.id : "chatcmpl-overrail",
        object: "chat.completion.chunk",
        created: state.base ? state.base.created : Math.floor(Date.now() / 1000),
        model: state.base ? state.base.model : "unknown",
        choices: [{ index: 0, delta: {}, finish_reason: state.finish_reason || "stop" }],
      };
      if (state.usage.completion_tokens !== null) final_chunk.usage = state.usage;
      write(`data: ${JSON.stringify(final_chunk)}\n\n`);
    }
    write("data: [DONE]\n\n");
    res.end();
    on_done(state.usage, state.winner.profile_name, state.winner.upstream_model);
  };

  const abort = (err) => {
    if (state.heartbeat) clearInterval(state.heartbeat);
    if (!state.headers_sent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "all providers failed", details: err.attempts || [] } }));
      return;
    }
    res.destroy();
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
          if (!chunk.usage) forward(chunk, data); // usage-only chunks stay held
          continue;
        }
        if (choice.finish_reason) {
          state.finish_reason = choice.finish_reason;
          state.saw_finish_chunk = true;
          continue; // held until the whole relay completes
        }
        const delta = choice.delta || {};
        if (delta.content) {
          state.content += delta.content;
          content_events += 1;
          forward(chunk, data);
          if (state.leg === 0 && chaos_drop_at && content_events >= chaos_drop_at) {
            throw new Drop(`chaos midstream drop after ${chaos_drop_at} content events`);
          }
          continue;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call_delta of delta.tool_calls) {
            const key = typeof call_delta.index === "number" ? call_delta.index : 0;
            if (!state.tools.has(key)) state.tools.set(key, { args: "" });
            const tool = state.tools.get(key);
            if (call_delta.function && typeof call_delta.function.arguments === "string") {
              tool.args += call_delta.function.arguments;
            }
          }
          // hold chunks until every in-flight call's arguments parse as complete JSON
          state.tool_chunks.push({ chunk, raw: data });
          update_heartbeat();
          flush_tools();
          continue;
        }
        forward(chunk, data); // role-only and other deltas pass through
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
      // upstream ended cleanly but omitted [DONE]
      finish();
      return;
    }

    // dropped mid-stream: build a continuation and fail over
    if (!state.sent_anything) {
      try {
        state.winner = await attempt_chain(parsed_body, null);
      } catch (err) {
        abort(err);
        return;
      }
      state.leg += 1;
      continue;
    }
    if (!state.content) {
      // only partial tool-call arguments in flight: no safe cross-provider continuation
      abort(new Error("stream dropped during an incomplete tool call"));
      return;
    }
    const prefill = { role: "assistant", content: state.content };
    try {
      state.winner = await attempt_chain(parsed_body, prefill);
    } catch (err) {
      if (!/status 400/.test(err.message || "")) {
        abort(err);
        return;
      }
      // upstream rejected a trailing assistant message: synthetic continue prompt instead
      const synthetic = {
        role: "user",
        content: `Continue exactly from where this partial response stopped, with no preamble and no repetition:\n\n${state.content}`,
      };
      try {
        state.winner = await attempt_chain(parsed_body, synthetic);
      } catch (retry_err) {
        abort(retry_err);
        return;
      }
    }
    state.leg += 1;
  }
}

module.exports = { relay_stream };
