const { PRESETS } = require("./providers");

function buildDefaultConfig() {
  const profiles = {};
  for (const [name, preset] of Object.entries(PRESETS)) {
    profiles[name] = {
      label: preset.label,
      baseUrl: preset.baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      env: { ...preset.env },
      note: preset.note,
      headers: { ...preset.headers },
    };
  }
  return {
    profiles,
    chains: {
      default: ["deepseek", "kimi", "openrouter"],
      local: ["ollama"],
    },
    active: "deepseek",
    gatewayPort: 8787,
  };
}

module.exports = { buildDefaultConfig };
