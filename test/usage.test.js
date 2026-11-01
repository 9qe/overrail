const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-usage-"));
os.homedir = () => tmp_dir;

const { logUsage, readUsage, summarize } = require("../lib/usage");
const { USAGE_PATH } = require("../lib/config");

after(() => {
  os.homedir = real_homedir;
  fs.rmSync(tmp_dir, { recursive: true, force: true });
});

test("readUsage returns an empty array when the log does not exist yet", () => {
  assert.deepEqual(readUsage(), []);
});

test("logUsage appends lines and readUsage returns them in order", () => {
  logUsage({ ts: "t1", provider: "deepseek", model: "deepseek-chat", prompt_tokens: 5, completion_tokens: 7 });
  logUsage({ ts: "t2", provider: "kimi", model: "kimi-k2", prompt_tokens: 10, completion_tokens: 3 });
  logUsage({ ts: "t3", provider: "deepseek", model: "deepseek-reasoner", prompt_tokens: 1, completion_tokens: 2 });
  const entries = readUsage();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].ts, "t1");
  assert.equal(entries[1].provider, "kimi");
  assert.equal(entries[2].model, "deepseek-reasoner");
});

test("readUsage skips unparseable lines and respects the limit", () => {
  fs.appendFileSync(USAGE_PATH, "not-json-at-all\n");
  const all = readUsage();
  assert.equal(all.length, 3);
  const limited = readUsage(2);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].ts, "t3");
});

test("summarize aggregates totals and per-provider counts", () => {
  const summary = summarize();
  assert.equal(summary.totalRequests, 3);
  assert.equal(summary.totalPromptTokens, 16);
  assert.equal(summary.totalCompletionTokens, 12);
  assert.deepEqual(summary.byProvider.deepseek, { requests: 2, promptTokens: 6, completionTokens: 9 });
  assert.deepEqual(summary.byProvider.kimi, { requests: 1, promptTokens: 10, completionTokens: 3 });
});
