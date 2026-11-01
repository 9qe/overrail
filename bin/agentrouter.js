#!/usr/bin/env node
// agentrouter CLI — CommonJS, zero dependencies, Node >= 18, Windows-first.
// Usage: agentrouter <command> [args] [-- command...]
"use strict";

const { spawn } = require("child_process");
const path = require("path");

const providers = require("../lib/providers");
const config = require("../lib/config");
const { createGateway } = require("../lib/gateway");
const usage = require("../lib/usage");
const { buildDefaultConfig } = require("../lib/config-defaults");

// Derived injection table for known profiles so Claude Code and other
// OpenAI/Anthropic-native CLIs work without their own env plumbing.
const DEFAULT_MODELS = {
  deepseek: { model: "deepseek-chat", key: "DEEPSEEK_API_KEY", anthropicBaseUrl: "https://api.deepseek.com/anthropic" },
  kimi: { model: "kimi-k2", key: "MOONSHOT_API_KEY", anthropicBaseUrl: "https://api.moonshot.ai/anthropic" },
  openrouter: { model: "anthropic/claude-sonnet-4.5", key: "OPENROUTER_API_KEY" },
  ollama: { model: "qwen3:8b", key: null },
};

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function print(line) {
  process.stdout.write(line + "\n");
}

function loadOrDie() {
  try {
    return config.loadConfig();
  } catch (err) {
    fail("Failed to load config: " + err.message + " (run: agentrouter init)");
  }
}

function envLines(profile, kind) {
  const { env, missing } = config.resolveEnv(profile.env || {});
  const keys = Object.keys(env).sort();
  const lines = keys.map((k) => {
    const v = env[k] === "" ? "" : env[k];
    return kind === "powershell" ? `$env:${k}="${v}"` : `set ${k}=${v}`;
  });
  return { lines, missing };
}

function printShellBlocks(profile) {
  const ps = envLines(profile, "powershell");
  const cmd = envLines(profile, "cmd");

  if (ps.missing.length > 0) {
    print("WARNING: missing values for: " + ps.missing.join(", "));
  }

  print("PowerShell:");
  for (const line of ps.lines) print("  " + line);
  print("");
  print("cmd.exe:");
  for (const line of cmd.lines) print("  " + line);
  print("");
  print(`Or run directly: agentrouter run ${profile.__name} -- <your-cli>`);
}

function cmdInit() {
  const cfg = loadOrDie();
  cfg.profiles = cfg.profiles || {};
  const presets = providers.PRESETS || {};
  const added = [];

  for (const [name, preset] of Object.entries(presets)) {
    if (!cfg.profiles[name]) {
      cfg.profiles[name] = {
        label: preset.label,
        baseUrl: preset.baseUrl,
        apiKeyEnv: preset.apiKeyEnv,
        env: { ...(preset.env || {}) },
        note: preset.note,
        headers: preset.headers,
      };
      added.push(name);
    }
  }

  cfg.chains = cfg.chains || {};
  if (!Array.isArray(cfg.chains.default) || cfg.chains.default.length === 0) {
    cfg.chains.default = Object.keys(cfg.profiles);
  }
  if (!Array.isArray(cfg.chains.local)) {
    cfg.chains.local = cfg.profiles.ollama ? ["ollama"] : [];
  }
  if (cfg.gatewayPort === undefined || cfg.gatewayPort === null) {
    cfg.gatewayPort = 8787;
  }
  if (!cfg.active) {
    cfg.active = "deepseek";
  }

  config.saveConfig(cfg);

  for (const name of added) print("Added profile: " + name);
  print("Active: " + cfg.active);
}

function cmdList() {
  const cfg = loadOrDie();
  const names = Object.keys(cfg.profiles || {});
  if (names.length === 0) {
    print("No profiles. Run: agentrouter init");
    return;
  }
  for (const name of names) {
    const p = cfg.profiles[name];
    const star = name === cfg.active ? "*" : " ";
    print(`${star}${name.padEnd(12)}${String(p.label || "").padEnd(32)}${p.note || ""}`);
  }
}

function cmdUse(name) {
  if (!name) fail("Usage: agentrouter use <profile>");
  const cfg = loadOrDie();
  try {
    config.resolveProfile(cfg, name);
  } catch (err) {
    fail(err.message);
  }
  cfg.active = name;
  config.saveConfig(cfg);
  print("Active profile: " + name);

  const profile = config.resolveProfile(cfg, name);
  profile.__name = name;
  printShellBlocks(profile);
}

function maskValue(v) {
  if (v === undefined || v === null || v === "") return "<missing>";
  if (v.length > 10) return v.slice(0, 6) + "...";
  return "<set>";
}

function cmdCurrent() {
  const cfg = loadOrDie();
  if (!cfg.active) fail("No active profile. Run: agentrouter use <profile>");
  const profile = config.resolveProfile(cfg, cfg.active);
  print("Active profile: " + cfg.active);
  const env = profile.env || {};
  for (const k of Object.keys(env).sort()) {
    print(`  ${k}=${maskValue(env[k])}`);
  }
}

function cmdEnv(name) {
  if (!name) fail("Usage: agentrouter env <profile>");
  const cfg = loadOrDie();
  let profile;
  try {
    profile = config.resolveProfile(cfg, name);
  } catch (err) {
    fail(err.message);
  }
  profile.__name = name;
  printShellBlocks(profile);
}

function derivedEnv(name, profile) {
  const known = DEFAULT_MODELS[name];
  if (!known) return {};
  const derived = {};
  if (known.anthropicBaseUrl) {
    derived.ANTHROPIC_BASE_URL = known.anthropicBaseUrl;
    derived.ANTHROPIC_AUTH_TOKEN = (profile.env && profile.env[known.key]) || "";
    derived.ANTHROPIC_MODEL = known.model;
  } else {
    derived.OPENAI_BASE_URL = profile.baseUrl || "";
    derived.OPENAI_API_KEY = known.key ? (profile.env && profile.env[known.key]) || "" : "";
    derived.OPENAI_MODEL = known.model;
  }
  return derived;
}

function cmdRun(args) {
  const cfg = loadOrDie();
  let name = null;
  let command = [];

  const dd = args.indexOf("--");
  if (dd !== -1) {
    command = args.slice(dd + 1);
    if (dd > 0) name = args[0];
  } else {
    // No "--": first arg is the profile, rest is the command.
    name = args[0] || null;
    command = args.slice(1);
  }

  if (!name) name = cfg.active;
  if (!name) fail("No profile given and no active profile. Run: agentrouter use <profile> or agentrouter run <profile> -- <command>");

  let profile;
  try {
    profile = config.resolveProfile(cfg, name);
  } catch (err) {
    fail(err.message);
  }

  if (command.length === 0) fail("Usage: agentrouter run [profile] -- <command...>");

  const { env: resolved, missing } = config.resolveEnv(profile.env || {});
  if (missing.length > 0) {
    fail(`Missing environment variable(s): ${missing.join(", ")} — set them first (see: agentrouter env ${name})`);
  }

  const childEnv = { ...process.env, ...resolved, ...derivedEnv(name, profile) };
  const parts = command.slice();

  let child;
  if (process.platform === "win32") {
    // shell:true resolves .cmd shims like claude.cmd, which spawn() cannot exec directly on Windows.
    child = spawn(parts.join(" "), { shell: true, stdio: "inherit", env: childEnv });
  } else {
    child = spawn(parts[0], parts.slice(1), { stdio: "inherit", env: childEnv });
  }

  child.on("error", (err) => fail("Failed to spawn: " + err.message));
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code === null || code === undefined ? 0 : code);
  });
}

function cmdServe(args) {
  const cfg = loadOrDie();
  let port = cfg.gatewayPort || 8787;

  const pi = args.indexOf("--port");
  if (pi !== -1 && args[pi + 1]) {
    const n = parseInt(args[pi + 1], 10);
    if (Number.isFinite(n) && n > 0) port = n;
  }

  const server = createGateway({ config: cfg, port });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      fail("port in use, try: agentrouter serve --port " + (port + 1));
    }
    fail("Gateway error: " + (err && err.message ? err.message : String(err)));
  });

  server.listen(port, "127.0.0.1", () => {
    // Bound to loopback only — keep the gateway off the network.
    print(`agentrouter gateway listening on http://127.0.0.1:${port}`);
    print("Point any OpenAI-compatible client at it. Model field: '<profile>' or '<profile>/<model>'.");
    print("Failover chain (default): " + (cfg.chains && cfg.chains.default ? cfg.chains.default.join(" -> ") : "(none)"));
  });

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
    // Windows close() can hang with open keep-alives; force exit shortly after.
    setTimeout(() => process.exit(0), 500).unref();
  });
}

function cmdUsage(args) {
  const li = args.indexOf("--limit");
  const limit = li !== -1 && args[li + 1] ? parseInt(args[li + 1], 10) : undefined;
  const rows = (limit !== undefined ? usage.readUsage(limit) : usage.summarize()) || [];

  if (!Array.isArray(rows) || rows.length === 0) {
    print("No usage recorded yet.");
    return;
  }

  print(
    "provider".padEnd(14) +
      "requests".padStart(10) +
      "prompt".padStart(10) +
      "completion".padStart(12)
  );

  let totReq = 0, totPrompt = 0, totCompletion = 0;
  for (const r of rows) {
    const req = r.requests || 0;
    const p = r.promptTokens !== undefined ? r.promptTokens : (r.prompt || 0);
    const c = r.completionTokens !== undefined ? r.completionTokens : (r.completion || 0);
    totReq += req; totPrompt += p; totCompletion += c;
    print(
      String(r.provider || "").padEnd(14) +
        String(req).padStart(10) +
        String(p).padStart(10) +
        String(c).padStart(12)
    );
  }
  print(
    "TOTAL".padEnd(14) +
      String(totReq).padStart(10) +
      String(totPrompt).padStart(10) +
      String(totCompletion).padStart(12)
  );
}

function cmdChains() {
  const cfg = loadOrDie();
  const chains = cfg.chains || {};
  print("default: " + (Array.isArray(chains.default) && chains.default.length ? chains.default.join(" -> ") : "(empty)"));
  print("local:   " + (Array.isArray(chains.local) && chains.local.length ? chains.local.join(" -> ") : "(empty)"));
}

function usageText() {
  return [
    "agentrouter — swap model providers under AI agent CLIs",
    "",
    "  agentrouter init                create config, merge provider presets",
    "  agentrouter list                show profiles (* = active)",
    "  agentrouter use <profile>       set active profile, print shell env",
    "  agentrouter current             show active profile with masked env",
    "  agentrouter env <profile>       print PowerShell / cmd.exe env blocks",
    "  agentrouter run [profile] -- <cmd>  run a CLI with the profile's env injected",
    "  agentrouter serve [--port N]    start the local gateway (127.0.0.1)",
    "  agentrouter usage [--limit N]   show token/request usage summary",
    "  agentrouter chains              show failover chains",
    "  agentrouter help                this help",
    "",
    "Config: " + config.CONFIG_PATH,
  ].join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case "init": return cmdInit();
    case "list": return cmdList();
    case "use": return cmdUse(rest[0]);
    case "current": return cmdCurrent();
    case "env": return cmdEnv(rest[0]);
    case "run": return cmdRun(rest);
    case "serve": return cmdServe(rest);
    case "usage": return cmdUsage(rest);
    case "chains": return cmdChains();
    case "help":
    case "--help":
    case "-h":
      print(usageText());
      process.exit(0);
      return;
    case undefined:
      print(usageText());
      process.exit(0);
      return;
    default:
      process.stderr.write("Unknown command: " + cmd + "\n\n" + usageText() + "\n");
      process.exit(1);
  }
}

main();
