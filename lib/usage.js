const fs = require("node:fs");
const path = require("node:path");

const { CONFIG_DIR, USAGE_PATH } = require("./config");

function logUsage(entry) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.appendFileSync(USAGE_PATH, `${JSON.stringify(entry)}\n`);
}

function readUsage(limit = 100) {
  let raw;
  try {
    raw = fs.readFileSync(USAGE_PATH, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const entries = [];
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // torn or corrupt line — skip it
    }
  }
  return entries;
}

function summarize() {
  const entries = readUsage(10000);
  const summary = { totalRequests: 0, totalPromptTokens: 0, totalCompletionTokens: 0, byProvider: {} };
  for (const entry of entries) {
    const prompt_tokens = typeof entry.prompt_tokens === "number" ? entry.prompt_tokens : 0;
    const completion_tokens = typeof entry.completion_tokens === "number" ? entry.completion_tokens : 0;
    summary.totalRequests += 1;
    summary.totalPromptTokens += prompt_tokens;
    summary.totalCompletionTokens += completion_tokens;
    const provider = entry.provider || "unknown";
    if (!summary.byProvider[provider]) {
      summary.byProvider[provider] = { requests: 0, promptTokens: 0, completionTokens: 0 };
    }
    summary.byProvider[provider].requests += 1;
    summary.byProvider[provider].promptTokens += prompt_tokens;
    summary.byProvider[provider].completionTokens += completion_tokens;
  }
  return summary;
}

module.exports = { logUsage, readUsage, summarize };
