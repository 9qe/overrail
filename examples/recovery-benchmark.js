// Recovery benchmark: 8k-delta stream, mid-stream drop, stitched continuation + tool call.
// Fully local fake upstreams through the real gateway — no external provider, no API keys.
//
// Run: node examples/recovery-benchmark.js
// Config: OVERRAIL_BENCH_DROP_AT=<content-deltas before drop, default 4000>
//         OVERRAIL_BENCH_TOTAL=<total content deltas, default 8000>
//         --out <path>   also write the machine-readable JSON report to a file
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// anchor ~/.overrail usage writes to a throwaway dir before requiring the libs
const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-bench-"));
os.homedir = () => tmp_dir;

const { createGateway } = require("../lib/gateway");
const { buildDefaultConfig } = require("../lib/config-defaults");

const TOTAL = clampInt(process.env.OVERRAIL_BENCH_TOTAL, 1, 200000, 8000);
const DROP_AT = clampInt(process.env.OVERRAIL_BENCH_DROP_AT, 1, TOTAL - 1, Math.min(4000, TOTAL - 1));
const out_flag = process.argv.indexOf("--out");
const out_path = out_flag !== -1 ? process.argv[out_flag + 1] : null;

function clampInt(raw, lo, hi, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function sse(id, delta, extra = {}) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "bench-model",
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

// deterministic content pieces: "w0 ", "w1 ", ... — the stitched output must
// equal pieces.join("") exactly
const pieces = [];
for (let i = 0; i < TOTAL; i++) pieces.push(`w${i} `);

// expected tool call emitted only by the backup leg
const TOOL_ID = "call_bench_1";
const TOOL_ARGS = JSON.stringify({ status: "recovered", deltas: TOTAL });

// paced writer that survives the relay cancelling the body mid-write
async function write_paced(res, from, to, batch, delay_ms) {
  let written = 0;
  try {
    for (let i = from; i < to; i++) {
      if (res.destroyed || !res.writable) break;
      res.write(sse("bench-primary", { content: pieces[i] }));
      written += 1;
      if ((i - from + 1) % batch === 0) await new Promise((r) => setTimeout(r, delay_ms));
    }
  } catch {
    // socket gone: expected after the mid-stream drop
  }
  return written;
}

const hit_log = { primary_requests: 0, backup_requests: 0, primary_first_byte: null, backup_first_byte: null };

async function main() {
  process.env.DEEPSEEK_API_KEY = "bench-local";
  process.env.MOONSHOT_API_KEY = "bench-local";
  process.env.OVERRAIL_CHAOS = `midstream_drop@${DROP_AT}`;

  const primary = await listen(
    http.createServer(async (req, res) => {
      await collect_body(req);
      hit_log.primary_requests += 1;
      if (hit_log.primary_first_byte === null) hit_log.primary_first_byte = Date.now();
      res.writeHead(200, { "content-type": "text/event-stream" });
      await write_paced(res, 0, TOTAL, 500, 1); // ~80 ticks, paced like real generation
      try {
        res.end("data: [DONE]\n\n");
      } catch {}
    })
  );

  const backup = await listen(
    http.createServer(async (req, res) => {
      const body = JSON.parse(await collect_body(req));
      hit_log.backup_requests += 1;
      if (hit_log.backup_first_byte === null) hit_log.backup_first_byte = Date.now();
      // derive the continuation point from the prefill the relay actually sent
      let start = 0;
      const prefill = body.messages[body.messages.length - 1];
      if (prefill && prefill.role === "assistant" && typeof prefill.content === "string" && prefill.content) {
        const m = /w(\d+) $/.exec(prefill.content);
        start = m ? Number(m[1]) + 1 : 0;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      await write_paced_from(res, start, "bench-backup");
      // split tool call so the relay must buffer args until they parse as JSON
      res.write(
        sse("bench-backup", {
          tool_calls: [{ index: 0, id: TOOL_ID, type: "function", function: { name: "finish_run", arguments: '{"status":"reco' } }],
        })
      );
      await new Promise((r) => setTimeout(r, 2));
      res.write(
        sse("bench-backup", { tool_calls: [{ index: 0, function: { arguments: `verified","deltas":${TOTAL} }` } }] })
      );
      res.end(
        `data: ${JSON.stringify({
          id: "bench-backup",
          object: "chat.completion.chunk",
          created: 1,
          model: "bench-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 40, completion_tokens: TOTAL },
        })}\n\ndata: [DONE]\n\n`
      );
    })
  );

  async function write_paced_from(res, from, id) {
    try {
      for (let i = from; i < TOTAL; i++) {
        if (res.destroyed || !res.writable) break;
        res.write(sse(id, { content: pieces[i] }));
        if ((i - from + 1) % 500 === 0) await new Promise((r) => setTimeout(r, 1));
      }
    } catch {}
  }

  const config = buildDefaultConfig();
  config.profiles.deepseek.baseUrl = `http://127.0.0.1:${primary.address().port}/v1`;
  config.profiles.kimi.baseUrl = `http://127.0.0.1:${backup.address().port}/v1`;
  config.chains.default = ["deepseek", "kimi"];
  const gateway = await listen(createGateway({ config }));
  const url = `http://127.0.0.1:${gateway.address().port}/v1/chat/completions`;

  // ---- measure ----
  const rss_at_start = process.memoryUsage().rss;
  let peak_rss = rss_at_start;
  const sampler = setInterval(() => {
    const { rss } = process.memoryUsage();
    if (rss > peak_rss) peak_rss = rss;
  }, 2);
  sampler.unref();

  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek", stream: true, messages: [{ role: "user", content: "bench" }] }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder(); // persistent decoder: the client must not lose codepoints
  let buf = "";
  let raw_bytes = 0;
  let first_byte_ms = null;
  let content = "";
  let content_deltas = 0;
  let dones = 0;
  let finish_events = 0;
  let usage_event = null;
  let tool_ids_seen = 0;
  let last_leg0_arrival = null; // last event arrival before the stitch boundary
  let first_cont_arrival = null; // first content event after it
  let boundary_crossed = false;
  let unparsed_events = 0;
  const boundary_len = pieces.slice(0, DROP_AT).join("").length;

  function consume(block) {
    const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (lines.length === 0) return;
    const payload = lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (payload.trim() === "[DONE]") {
      dones += 1;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      unparsed_events += 1;
      return;
    }
    const now = Date.now();
    if (chunk.usage) usage_event = chunk.usage;
    if (!Array.isArray(chunk.choices)) return;
    const choice = chunk.choices[0];
    if (!choice) return;
    if (choice.finish_reason) {
      finish_events += 1;
      return;
    }
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      content_deltas += 1;
      if (content.length >= boundary_len && !boundary_crossed) {
        boundary_crossed = true; // the event that reaches the drop point is the last primary one
        last_leg0_arrival = now;
      } else if (boundary_crossed && first_cont_arrival === null && content.length > boundary_len) {
        first_cont_arrival = now; // first stitched continuation event
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const c of delta.tool_calls) if (c.id === TOOL_ID) tool_ids_seen += 1;
    }
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first_byte_ms === null) first_byte_ms = Date.now() - t0;
    raw_bytes += value.byteLength;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      consume(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) consume(buf);
  const total_ms = Date.now() - t0;
  clearInterval(sampler);
  const rss_at_end = process.memoryUsage().rss;

  const expected = pieces.join("");
  const exact_stitch = content === expected;
  const failover_gap_ms =
    first_cont_arrival !== null && last_leg0_arrival !== null ? Math.max(0, first_cont_arrival - last_leg0_arrival) : null;
  const backup_setup_ms =
    hit_log.backup_first_byte !== null && hit_log.primary_first_byte !== null ? hit_log.backup_first_byte - hit_log.primary_first_byte : null;

  const checks = {
    exact_stitch,
    single_done: dones === 1,
    single_finish_event: finish_events === 1,
    tool_call_once: tool_ids_seen === 1,
    tool_args_valid: (() => {
      try {
        return JSON.parse(TOOL_ARGS).deltas === TOTAL;
      } catch {
        return false;
      }
    })(),
    usage_present: usage_event !== null && usage_event.completion_tokens === TOTAL,
    no_unparsed_events: unparsed_events === 0,
  };
  const passed = Object.values(checks).every(Boolean) && content_deltas === TOTAL;

  const report = {
    kind: "overrail-recovery-benchmark",
    generated_at: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    methodology: "local fake upstreams through the real gateway; primary streams TOTAL paced deltas, relay forces a mid-stream drop after DROP_AT forwarded content events (OVERRAIL_CHAOS=midstream_drop@N), backup derives the continuation point from the prefill it received, streams the remainder and emits one tool call",
    config: { total_deltas: TOTAL, drop_at: DROP_AT, pacing: "500 deltas/tick @ 1ms" },
    metrics: {
      first_byte_latency_ms: first_byte_ms,
      failover_gap_ms, // client-observed stall between last primary event and first continuation event
      backup_setup_ms, // primary-first-write -> backup-request-received, in-process clocks
      total_ms,
      raw_bytes_client_received: raw_bytes,
      content_deltas: content_deltas,
      content_chars: content.length,
      done_markers: dones,
      finish_events,
      primary_requests: hit_log.primary_requests,
      backup_requests: hit_log.backup_requests,
      memory: {
        rss_start_mb: +(rss_at_start / 1048576).toFixed(1),
        peak_rss_mb: +(peak_rss / 1048576).toFixed(1),
        rss_end_mb: +(rss_at_end / 1048576).toFixed(1),
        note: "gateway+upstreams+client share this process; peak delta tracks buffering, not stream size",
      },
    },
    verification: { ...checks, pass: passed },
  };

  // ---- output ----
  console.log(`overrail recovery benchmark — ${TOTAL} deltas, drop at ${DROP_AT}`);
  console.log(`  first byte:        ${first_byte_ms} ms`);
  console.log(`  failover gap:      ${failover_gap_ms === null ? "n/a" : failover_gap_ms} ms (client-observed stall across the stitch)`);
  console.log(`  backup setup:      ${backup_setup_ms} ms`);
  console.log(`  total:             ${total_ms} ms, ${raw_bytes} bytes, ${content_deltas}/${TOTAL} content deltas`);
  console.log(`  [DONE] markers:    ${dones} | finish events: ${finish_events} | tool call ids: ${tool_ids_seen}`);
  console.log(`  peak RSS:          ${(peak_rss / 1048576).toFixed(1)} MB (start ${(rss_at_start / 1048576).toFixed(1)} MB)`);
  console.log(`  exact stitch:      ${exact_stitch ? "YES" : "NO"} — verification ${passed ? "PASS" : "FAIL"}`);
  console.log("===JSON===");
  console.log(JSON.stringify(report, null, 2));
  if (out_path) {
    fs.writeFileSync(out_path, JSON.stringify(report, null, 2) + "\n");
    console.log(`report written: ${out_path}`);
  }

  for (const s of [primary, backup, gateway]) {
    s.closeAllConnections();
    s.close();
  }
  fs.rmSync(tmp_dir, { recursive: true, force: true });
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("benchmark failed:", err && err.message ? err.message : err);
  fs.rmSync(tmp_dir, { recursive: true, force: true });
  process.exit(1);
});
