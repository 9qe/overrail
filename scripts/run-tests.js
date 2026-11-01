// language: JavaScript, file: scripts/run-tests.js, runs on Node >= 18 (no glob args, no shell expansion)
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const test_dir = path.join(__dirname, "..", "test");
const files = fs
  .readdirSync(test_dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(test_dir, name));

if (files.length === 0) {
  console.error("no *.test.js files found in test/");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
