export type ProviderId = "ollama" | "openrouter" | "anthropic";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  blurb: string;
  needsKey: boolean;
  baseUrl: string;
  defaultModel: string;
  keyUrl?: string;
  keyPrefix?: string;
  /** Cloud models take the whole document at once; local ones need small pieces. */
  chunkChars: number;
};

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  ollama: {
    id: "ollama",
    label: "Ollama",
    blurb: "Runs on this machine. Free and private, no key needed.",
    needsKey: false,
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3:8b",
    chunkChars: 3500,
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key, hundreds of models.",
    needsKey: true,
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-5",
    keyUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-",
    chunkChars: 40000,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    blurb: "Claude direct. Best card quality.",
    needsKey: true,
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
    chunkChars: 40000,
  },
};

export const PROVIDER_LIST = Object.values(PROVIDERS);

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && v in PROVIDERS;
}

export type Settings = {
  provider: ProviderId;
  model: string;
  /** Kept per provider so switching back and forth doesn't wipe a key. */
  keys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
};

export const DEFAULT_SETTINGS: Settings = {
  provider: "ollama",
  model: PROVIDERS.ollama.defaultModel,
  keys: {},
  models: {},
};
