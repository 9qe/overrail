const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_DIR = path.join(os.homedir(), ".overrail");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const USAGE_PATH = path.join(CONFIG_DIR, "usage.jsonl");

function fresh_config() {
  return { profiles: {}, chains: {}, active: null, gatewayPort: 8787 };
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fresh_config();
    return parsed;
  } catch {
    return fresh_config();
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function resolveProfile(config, name) {
  const profile = config && config.profiles ? config.profiles[name] : undefined;
  if (!profile) {
    const known = config && config.profiles ? Object.keys(config.profiles) : [];
    const names = known.length > 0 ? known.join(", ") : "none";
    throw new Error(`unknown profile "${name}" — known: ${names}. Run "overrail init" first.`);
  }
  return profile;
}

function resolveEnv(env_obj) {
  const env = {};
  const missing = [];
  for (const [key, value] of Object.entries(env_obj || {})) {
    if (typeof value === "string" && value.startsWith("env:")) {
      const var_name = value.slice(4);
      const resolved = process.env[var_name];
      if (resolved === undefined) {
        env[key] = "";
        missing.push(var_name);
      } else {
        env[key] = resolved;
      }
    } else {
      env[key] = value;
    }
  }
  return { env, missing };
}

module.exports = { CONFIG_DIR, CONFIG_PATH, USAGE_PATH, loadConfig, saveConfig, resolveProfile, resolveEnv };
