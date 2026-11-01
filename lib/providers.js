const PRESETS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    env: { DEEPSEEK_API_KEY: "env:DEEPSEEK_API_KEY" },
    note: "Get a key at platform.deepseek.com",
    headers: {},
  },
  kimi: {
    label: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    env: { MOONSHOT_API_KEY: "env:MOONSHOT_API_KEY" },
    note: "Get a key at platform.moonshot.ai",
    headers: {},
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    env: { OPENROUTER_API_KEY: "env:OPENROUTER_API_KEY" },
    note: "Hundreds of models behind one key",
    headers: {
      "HTTP-Referer": "https://github.com/9qe/overrail",
      "X-Title": "overrail",
    },
  },
  ollama: {
    label: "Ollama (local, no key)",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: null,
    env: { OPENAI_API_KEY: "ollama" },
    note: "Fully local. Pull models with: ollama pull qwen3:8b",
    headers: {},
  },
};

module.exports = { PRESETS };
