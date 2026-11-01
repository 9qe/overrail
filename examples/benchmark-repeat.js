// language: JavaScript, file: examples/benchmark-repeat.js, target: Node >= 18, no dependencies
// Runs examples/recovery-benchmark.js N times and reports percentiles, because a single run
// of a local stream is not evidence. Everything stays on 127.0.0.1 against mock upstreams.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const RUNS = Math.max(3, Math.min(51, parseInt(process.argv[2], 10) || 11));
const out_flag = process.argv.indexOf("--out");
const out_path = out_flag !== -1 ? process.argv[out_flag + 1] : null;
const bench = path.join(__dirname, "recovery-benchmark.js");

const METRICS = [
  "first_byte_latency_ms",
  "failover_gap_ms",
  "backup_setup_ms",
  "total_ms",
  "raw_bytes_client_received",
];
const MEMORY_METRICS = ["peak_rss_mb"];

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

const samples = [];
const failures = [];

for (let i = 0; i < RUNS; i += 1) {
  const run = spawnSync(process.execPath, [bench], { encoding: "utf8" });
  const marker = run.stdout.indexOf("===JSON===");
  if (marker === -1) {
    failures.push({ iteration: i + 1, reason: "no report emitted", stderr: run.stderr.slice(0, 400) });
    continue;
  }
  let report;
  try {
    report = JSON.parse(run.stdout.slice(marker + "===JSON===".length).trim());
  } catch {
    failures.push({ iteration: i + 1, reason: "unparseable report" });
    continue;
  }
  if (run.status !== 0 || !report.verification || report.verification.pass !== true) {
    failures.push({ iteration: i + 1, reason: "verification failed", verification: report.verification });
    continue;
  }
  samples.push({
    iteration: i + 1,
    ...report.metrics,
    peak_rss_mb: report.metrics.memory ? report.metrics.memory.peak_rss_mb : null,
    total_deltas: report.config ? report.config.total_deltas : null,
    drop_at: report.config ? report.config.drop_at : null,
  });
}

if (samples.length === 0) {
  console.error("no successful run to measure:");
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}

const stats = {};
for (const metric of [...METRICS, ...MEMORY_METRICS]) {
  const values = samples
    .map((sample) => sample[metric])
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (values.length === 0) continue;
  stats[metric] = {
    n: values.length,
    min: values[0],
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: values[values.length - 1],
  };
}

const invariants = {};
for (const key of [
  "total_deltas",
  "drop_at",
  "content_deltas",
  "content_chars",
  "done_markers",
  "finish_events",
  "primary_requests",
  "backup_requests",
]) {
  const values = new Set(samples.map((sample) => sample[key]).filter((v) => v !== undefined));
  invariants[key] = values.size === 1 ? [...values][0] : { varied: [...values] };
}

const report = {
  kind: "overrail-recovery-benchmark-repeat",
  generated_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  runs_attempted: RUNS,
  runs_verified: samples.length,
  run_failures: failures,
  env: { OVERRAIL_BENCH_TOTAL: process.env.OVERRAIL_BENCH_TOTAL || null, OVERRAIL_BENCH_DROP_AT: process.env.OVERRAIL_BENCH_DROP_AT || null },
  stats,
  invariants,
  interpretation: "client-observed timings on localhost mock upstreams in one process; a real backup provider over the internet is a different measurement",
};

console.log(`recovery benchmark: ${samples.length}/${RUNS} runs verified`);
for (const [metric, s] of Object.entries(stats)) {
  console.log(`  ${metric.padEnd(24)} p50 ${s.p50}  p90 ${s.p90}  min ${s.min}  max ${s.max} (n=${s.n})`);
}
console.log(`  invariants: ${JSON.stringify(invariants)}`);
console.log("===JSON===");
console.log(JSON.stringify(report, null, 2));

if (out_path) {
  fs.writeFileSync(out_path, JSON.stringify(report, null, 2) + "\n");
  console.log(`report written: ${out_path}`);
}
