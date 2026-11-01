const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const real_homedir = os.homedir;
const tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrail-config-"));
os.homedir = () => tmp_dir;

const { CONFIG_DIR, CONFIG_PATH, loadConfig, saveConfig, resolveProfile, resolveEnv } = require("../lib/config");

after(() => {
  os.homedir = real_homedir;
  fs.rmSync(tmp_dir, { recursive: true, force: true });
});

test("CONFIG paths live under the patched homedir", () => {
  assert.equal(CONFIG_DIR, path.join(tmp_dir, ".overrail"));
  assert.equal(CONFIG_PATH, path.join(tmp_dir, ".overrail", "config.json"));
});

test("saveConfig then loadConfig round-trips profiles and chains", () => {
  const written = {
    profiles: {
      deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
      kimi: { label: "Kimi / Moonshot", baseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY" },
    },
    chains: { default: ["deepseek", "kimi"], local: ["ollama"] },
    active: "deepseek",
    gatewayPort: 8787,
  };
  saveConfig(written);
  assert.deepEqual(loadConfig(), written);
  const on_disk = fs.readFileSync(CONFIG_PATH, "utf8");
  assert.ok(on_disk.endsWith("\n"));
  assert.ok(on_disk.includes('\n  "profiles"'));
});

test("loadConfig falls back to defaults on missing or corrupt file", () => {
  fs.rmSync(CONFIG_PATH, { force: true });
  assert.deepEqual(loadConfig(), { profiles: {}, chains: {}, active: null, gatewayPort: 8787 });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, "{broken json");
  assert.deepEqual(loadConfig(), { profiles: {}, chains: {}, active: null, gatewayPort: 8787 });
});

test("resolveProfile returns the profile or throws with known names", () => {
  const cfg = { profiles: { deepseek: { label: "DeepSeek" }, kimi: { label: "Kimi / Moonshot" } } };
  assert.equal(resolveProfile(cfg, "deepseek"), cfg.profiles.deepseek);
  assert.throws(
    () => resolveProfile(cfg, "nope"),
    (err) => err.message === 'unknown profile "nope" — known: deepseek, kimi. Run "overrail init" first.'
  );
  assert.throws(
    () => resolveProfile({ profiles: {} }, "nope"),
    (err) => err.message === 'unknown profile "nope" — known: none. Run "overrail init" first.'
  );
});

test("resolveEnv resolves env: refs and reports missing vars", () => {
  process.env.OVERRAIL_TEST_PRESENT = "sk-test";
  try {
    const { env, missing } = resolveEnv({
      DEEPSEEK_API_KEY: "env:OVERRAIL_TEST_PRESENT",
      MOONSHOT_API_KEY: "env:OVERRAIL_TEST_MISSING_XYZ",
      OPENAI_API_KEY: "ollama",
    });
    assert.equal(env.DEEPSEEK_API_KEY, "sk-test");
    assert.equal(env.MOONSHOT_API_KEY, "");
    assert.equal(env.OPENAI_API_KEY, "ollama");
    assert.deepEqual(missing, ["OVERRAIL_TEST_MISSING_XYZ"]);
  } finally {
    delete process.env.OVERRAIL_TEST_PRESENT;
  }
});
