import { PROVIDERS, type ProviderId } from "./providers";

export type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type LlmConfig = {
  provider: ProviderId;
  model: string;
  apiKey?: string;
};

const CARD_SCHEMA = {
  type: "object" as const,
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string", description: "1-5 words. The concept only, never a sentence." },
          definition: { type: "string", description: "1-3 sentences, under 45 words." },
        },
        required: ["term", "definition"],
      },
    },
  },
  required: ["cards"],
};

/** Reasoning models (qwen3 and friends) prefix their answer with a think block. */
function stripReasoning(text: string): string {
  const closed = text.lastIndexOf("</think>");
  const body = closed === -1 ? text : text.slice(closed + "</think>".length);
  return body.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Models wrap JSON in prose or fences often enough that we slice it out ourselves. */
export function parseJsonObject(raw: string): unknown {
  const text = stripReasoning(raw).replace(/^```(?:json)?/gim, "").replace(/```$/gm, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to slicing out the widest {...} or [...] span.
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Try the other bracket shape.
      }
    }
  }
  throw new Error("The model didn't return usable JSON. Try a different model.");
}

function describeFailure(cfg: LlmConfig, status: number, body: string): Error {
  const p = PROVIDERS[cfg.provider];
  if (status === 401 || status === 403) {
    return new Error(
      p.needsKey
        ? `${p.label} rejected the API key. Check it in Settings.`
        : `${p.label} refused the request.`
    );
  }
  if (status === 402) return new Error(`${p.label} says this account is out of credit.`);
  if (status === 429) return new Error(`${p.label} is rate limiting. Wait a moment and retry.`);
  if (/not found|no such model|does not exist|unknown model/i.test(body)) {
    return new Error(
      cfg.provider === "ollama"
        ? `Model "${cfg.model}" isn't pulled yet. Run \`ollama pull ${cfg.model}\`.`
        : `${p.label} doesn't have a model called "${cfg.model}".`
    );
  }
  return new Error(`${p.label} request failed (${status}): ${body.slice(0, 300)}`);
}

function connectionError(cfg: LlmConfig, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ECONNREFUSED|other side closed|network/i.test(msg)) {
    return cfg.provider === "ollama"
      ? new Error("Can't reach Ollama on this machine. Start it with `ollama serve`.")
      : new Error(`Can't reach ${PROVIDERS[cfg.provider].label}. Check your connection.`);
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Ollama, OpenRouter, and anything else speaking /chat/completions. */
async function openAiCompatible(cfg: LlmConfig, system: string, parts: Part[]): Promise<unknown> {
  const p = PROVIDERS[cfg.provider];
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === "openrouter") {
    headers["HTTP-Referer"] = "http://localhost:3000";
    headers["X-Title"] = "Flashcard Anything";
  }

  const base = {
    model: cfg.model,
    temperature: 0.2,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: parts },
    ],
  };

  // Structured-output support varies, so ask strictly first and loosen on rejection.
  const attempts: Record<string, unknown>[] = [
    {
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: { name: "flashcards", strict: true, schema: CARD_SCHEMA },
      },
    },
    { ...base, response_format: { type: "json_object" } },
    base,
  ];

  let last = { status: 0, body: "" };
  for (const body of attempts) {
    let res: Response;
    try {
      res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw connectionError(cfg, err);
    }

    if (res.ok) {
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) return parseJsonObject(content);
      last = { status: 200, body: "empty response" };
      continue;
    }

    last = { status: res.status, body: await res.text() };
    // 400 usually means this server rejected response_format; the next attempt drops it.
    if (res.status !== 400) break;
  }
  throw describeFailure(cfg, last.status, last.body);
}

/** Anthropic's Messages API, using a tool call so the JSON comes back well-formed. */
async function anthropic(cfg: LlmConfig, system: string, parts: Part[]): Promise<unknown> {
  const content = parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
    if (!match) throw new Error("Couldn't read that image.");
    return {
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] },
    };
  });

  let res: Response;
  try {
    res = await fetch(`${PROVIDERS.anthropic.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 8000,
        system,
        messages: [{ role: "user", content }],
        tools: [
          {
            name: "emit_flashcards",
            description: "Return the finished set of flashcards.",
            input_schema: CARD_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: "emit_flashcards" },
      }),
    });
  } catch (err) {
    throw connectionError(cfg, err);
  }

  if (!res.ok) throw describeFailure(cfg, res.status, await res.text());

  const data = await res.json();
  const toolUse = data?.content?.find((b: { type?: string }) => b?.type === "tool_use");
  if (toolUse?.input) return toolUse.input;

  const text = data?.content?.find((b: { type?: string }) => b?.type === "text")?.text;
  if (typeof text === "string") return parseJsonObject(text);
  throw new Error("Claude returned nothing usable.");
}

export function resolveKey(provider: ProviderId, fromClient?: string): string | undefined {
  const trimmed = fromClient?.trim();
  if (trimmed) return trimmed;
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY;
  return undefined;
}

export async function completeJson(cfg: LlmConfig, system: string, parts: Part[]): Promise<unknown> {
  if (PROVIDERS[cfg.provider].needsKey && !cfg.apiKey) {
    throw new Error(`Add your ${PROVIDERS[cfg.provider].label} API key in Settings first.`);
  }
  return cfg.provider === "anthropic"
    ? anthropic(cfg, system, parts)
    : openAiCompatible(cfg, system, parts);
}
