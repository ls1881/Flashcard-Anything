/** How a provider's HTTP API is shaped. Almost everything speaks OpenAI's dialect. */
export type ApiStyle = "openai" | "anthropic" | "ollama";

export type ProviderId =
  | "ollama"
  | "anthropic"
  | "openai"
  | "openrouter"
  | "google"
  | "groq"
  | "deepseek"
  | "mistral"
  | "together"
  | "custom";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  blurb: string;
  style: ApiStyle;
  needsKey: boolean;
  baseUrl: string;
  /** Blank where guessing a model id would be worse than asking. */
  defaultModel: string;
  keyUrl?: string;
  keyPrefix?: string;
  /** The user supplies the endpoint themselves. */
  editableBaseUrl?: boolean;
  /** Cloud models take the whole document at once; local ones need small pieces. */
  chunkChars: number;
};

const CLOUD_CHUNK = 40000;

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    blurb: "Runs on this machine. Free and private, no key needed.",
    style: "ollama",
    needsKey: false,
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3:8b",
    chunkChars: 3500,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    blurb: "Claude direct.",
    style: "anthropic",
    needsKey: true,
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
    chunkChars: CLOUD_CHUNK,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT models.",
    style: "openai",
    needsKey: true,
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
    chunkChars: CLOUD_CHUNK,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key, hundreds of models.",
    style: "openai",
    needsKey: true,
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-5",
    keyUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-",
    chunkChars: CLOUD_CHUNK,
  },
  google: {
    id: "google",
    label: "Google",
    blurb: "Gemini, through its OpenAI-compatible endpoint.",
    style: "openai",
    needsKey: true,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "",
    keyUrl: "https://aistudio.google.com/apikey",
    chunkChars: CLOUD_CHUNK,
  },
  groq: {
    id: "groq",
    label: "Groq",
    blurb: "Open models, very fast.",
    style: "openai",
    needsKey: true,
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "",
    keyUrl: "https://console.groq.com/keys",
    keyPrefix: "gsk_",
    chunkChars: CLOUD_CHUNK,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    blurb: "Inexpensive and strong at structured output.",
    style: "openai",
    needsKey: true,
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPrefix: "sk-",
    chunkChars: CLOUD_CHUNK,
  },
  mistral: {
    id: "mistral",
    label: "Mistral",
    blurb: "Mistral's hosted models.",
    style: "openai",
    needsKey: true,
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "",
    keyUrl: "https://console.mistral.ai/api-keys",
    chunkChars: CLOUD_CHUNK,
  },
  together: {
    id: "together",
    label: "Together",
    blurb: "Hosted open models.",
    style: "openai",
    needsKey: true,
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "",
    keyUrl: "https://api.together.ai/settings/api-keys",
    chunkChars: CLOUD_CHUNK,
  },
  custom: {
    id: "custom",
    label: "Custom",
    blurb: "Any OpenAI-compatible endpoint — vLLM, LM Studio, llama.cpp, a gateway.",
    style: "openai",
    needsKey: false,
    baseUrl: "",
    defaultModel: "",
    editableBaseUrl: true,
    chunkChars: CLOUD_CHUNK,
  },
};

export const PROVIDER_LIST = Object.values(PROVIDERS);

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && v in PROVIDERS;
}

export type ThemeChoice = "system" | "light" | "dark";

export type Settings = {
  provider: ProviderId;
  theme: ThemeChoice;
  /** Kept per provider so switching back and forth doesn't wipe a key. */
  keys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
  baseUrls: Partial<Record<ProviderId, string>>;
};

export const DEFAULT_SETTINGS: Settings = {
  provider: "ollama",
  theme: "system",
  keys: {},
  models: {},
  baseUrls: {},
};
