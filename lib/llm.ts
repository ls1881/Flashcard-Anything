import { PROVIDERS, type ProviderId } from "./providers";

export type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type LlmConfig = {
  provider: ProviderId;
  model: string;
  apiKey?: string;
};

export type JsonSchema = Record<string, unknown>;

/** Ollama defaults to 4096, which truncates a chunk plus its context block. */
export const OLLAMA_CONTEXT = Number(process.env.OLLAMA_NUM_CTX ?? 8192);

/** A small model can loop forever on maths; cap generation so it fails fast. */
export const MAX_OUTPUT_TOKENS = 4096;

export const CARD_SCHEMA = {
  type: "object" as const,
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string", description: "1-5 words. The concept only, never a sentence." },
          definition: {
            type: "string",
            description: "1-3 sentences, under 45 words, built only from the source text.",
          },
          evidence: {
            type: "string",
            description:
              "A short span copied word-for-word from the source that states this. Must appear verbatim in the text.",
          },
        },
        required: ["term", "definition", "evidence"],
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

/**
 * Maths and code carry backslashes, and a model writing "\frac" into a JSON string emits
 * an escape JSON doesn't define, which makes the whole response unparseable. Double any
 * backslash that isn't starting a legal escape.
 */
function repairEscapes(text: string): string {
  return (
    text
      // Stray control characters are invalid inside a JSON string and carry no meaning.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, "\\\\")
  );
}

export function stripFences(raw: string): string {
  return stripReasoning(raw).replace(/^```(?:json)?/gim, "").replace(/```$/gm, "").trim();
}

/** Models wrap JSON in prose or fences often enough that we slice it out ourselves. */
export function parseJsonObject(raw: string): unknown {
  const text = stripFences(raw);

  const candidates = [text];
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    for (const attempt of [candidate, repairEscapes(candidate)]) {
      try {
        return JSON.parse(attempt);
      } catch {
        // Try the next shape or the repaired version.
      }
    }
  }
  // A response cut off by the output cap is valid up to the truncation point, so keep the
  // objects that did come through rather than losing the whole batch.
  const salvaged = salvageObjects(text);
  if (salvaged.length) {
    console.warn(`[flashcards] recovered ${salvaged.length} items from a truncated response`);
    return { cards: salvaged };
  }

  console.warn(
    `[flashcards] unparseable model output (${text.length} chars):`,
    text.slice(0, 300),
    text.length > 300 ? `… …${text.slice(-120)}` : ""
  );
  throw new Error("The model didn't return usable JSON. Try a different model.");
}

/**
 * Find the end of the object starting at `from`, or -1 if it never closes. Quotes are
 * tracked so braces inside strings don't count.
 */
function objectEnd(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Recover the cards from a response cut off by the output cap. The outer object never
 * closes when a response is truncated, so scan for the individual card objects nested
 * inside it rather than looking for balanced objects at the top level.
 */
function salvageObjects(text: string): unknown[] {
  const out: unknown[] = [];

  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    // Cheap filter: only bother with objects that look like a card.
    if (!/^\{\s*"(term|definition|evidence)"/.test(text.slice(i, i + 20))) continue;

    const end = objectEnd(text, i);
    if (end === -1) break; // truncated mid-object; nothing usable past here

    const slice = text.slice(i, end + 1);
    for (const attempt of [slice, repairEscapes(slice)]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === "object" && "term" in parsed) out.push(parsed);
        break;
      } catch {
        // Not a usable object; move on.
      }
    }
    i = end;
  }
  return out;
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
async function openAiCompatible(
  cfg: LlmConfig,
  system: string,
  parts: Part[],
  schema: JsonSchema,
  schemaName: string
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === "openrouter") {
    headers["HTTP-Referer"] = "http://localhost:3000";
    headers["X-Title"] = "Flashcard Anything";
  }

  const base = {
    model: cfg.model,
    temperature: 0,
    max_tokens: 8000,
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
        json_schema: { name: schemaName, strict: true, schema },
      },
    },
    { ...base, response_format: { type: "json_object" } },
    base,
  ];

  let last = { status: 0, body: "" };
  for (const body of attempts) {
    let res: Response;
    try {
      res = await fetch(`${baseUrlFor(cfg.provider)}/chat/completions`, {
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

/**
 * Ollama's own API rather than its OpenAI-compatible shim, which pins context at 4096
 * tokens (silently truncating a chunk plus its context block) and gives no way to turn
 * off qwen3's hidden reasoning. Here we set the window, disable thinking, and hand the
 * schema straight to the sampler.
 */
async function ollamaNative(
  cfg: LlmConfig,
  system: string,
  parts: Part[],
  schema: JsonSchema
): Promise<unknown> {
  const text = parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const images = parts
    .filter((p): p is { type: "image_url"; image_url: { url: string } } => p.type === "image_url")
    .map((p) => p.image_url.url.replace(/^data:[^;]+;base64,/, ""));

  const root = baseUrlFor("ollama").replace(/\/v1$/, "");
  let res: Response;
  try {
    res = await fetch(`${root}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        think: false,
        format: schema,
        options: { temperature: 0, num_ctx: OLLAMA_CONTEXT, num_predict: MAX_OUTPUT_TOKENS },
        messages: [
          { role: "system", content: system },
          { role: "user", content: text, ...(images.length ? { images } : {}) },
        ],
      }),
    });
  } catch (err) {
    throw connectionError(cfg, err);
  }

  if (!res.ok) throw describeFailure(cfg, res.status, await res.text());
  const data = await res.json();
  const content = data?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Ollama returned an empty response.");
  }
  return parseJsonObject(content);
}

function anthropicContent(parts: Part[]) {
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
    if (!match) throw new Error("Couldn't read that image.");
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  });
}

/** Plain-text completion from Claude, no tool call. */
async function anthropicRaw(cfg: LlmConfig, system: string, parts: Part[]): Promise<string> {
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
        temperature: 0,
        system,
        messages: [{ role: "user", content: anthropicContent(parts) }],
      }),
    });
  } catch (err) {
    throw connectionError(cfg, err);
  }
  if (!res.ok) throw describeFailure(cfg, res.status, await res.text());
  const data = await res.json();
  return String(data?.content?.find((b: { type?: string }) => b?.type === "text")?.text ?? "");
}

/** Anthropic's Messages API, using a tool call so the JSON comes back well-formed. */
async function anthropic(
  cfg: LlmConfig,
  system: string,
  parts: Part[],
  schema: JsonSchema,
  schemaName: string
): Promise<unknown> {
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
        temperature: 0,
        system,
        messages: [{ role: "user", content }],
        tools: [
          {
            name: schemaName,
            description: "Return the result.",
            input_schema: schema,
          },
        ],
        tool_choice: { type: "tool", name: schemaName },
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

/** Server-side only: lets Ollama live on another host or port. */
export function baseUrlFor(provider: ProviderId): string {
  if (provider === "ollama" && process.env.OLLAMA_URL) {
    return process.env.OLLAMA_URL.replace(/\/+$/, "");
  }
  return PROVIDERS[provider].baseUrl;
}

export function resolveKey(provider: ProviderId, fromClient?: string): string | undefined {
  const trimmed = fromClient?.trim();
  if (trimmed) return trimmed;
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY;
  return undefined;
}

/**
 * Free-form text rather than JSON. Transcribing a page is naturally plain text, and
 * forcing it through a JSON string only creates escaping problems with maths and code.
 */
export async function completeText(cfg: LlmConfig, system: string, parts: Part[]): Promise<string> {
  if (PROVIDERS[cfg.provider].needsKey && !cfg.apiKey) {
    throw new Error(`Add your ${PROVIDERS[cfg.provider].label} API key in Settings first.`);
  }

  if (cfg.provider === "ollama") {
    const text = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    const images = parts
      .filter((p): p is { type: "image_url"; image_url: { url: string } } => p.type === "image_url")
      .map((p) => p.image_url.url.replace(/^data:[^;]+;base64,/, ""));

    const root = baseUrlFor("ollama").replace(/\/v1$/, "");
    let res: Response;
    try {
      res = await fetch(`${root}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: cfg.model,
          stream: false,
          think: false,
          options: { temperature: 0, num_ctx: OLLAMA_CONTEXT, num_predict: MAX_OUTPUT_TOKENS },
          messages: [
            { role: "system", content: system },
            { role: "user", content: text, ...(images.length ? { images } : {}) },
          ],
        }),
      });
    } catch (err) {
      throw connectionError(cfg, err);
    }
    if (!res.ok) throw describeFailure(cfg, res.status, await res.text());
    const data = await res.json();
    return stripFences(String(data?.message?.content ?? ""));
  }

  if (cfg.provider === "anthropic") {
    const raw = await anthropicRaw(cfg, system, parts);
    return stripFences(raw);
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  let res: Response;
  try {
    res = await fetch(`${baseUrlFor(cfg.provider)}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: parts },
        ],
      }),
    });
  } catch (err) {
    throw connectionError(cfg, err);
  }
  if (!res.ok) throw describeFailure(cfg, res.status, await res.text());
  const data = await res.json();
  return stripFences(String(data?.choices?.[0]?.message?.content ?? ""));
}

export async function completeJson(
  cfg: LlmConfig,
  system: string,
  parts: Part[],
  schema: JsonSchema = CARD_SCHEMA,
  schemaName = "emit_flashcards"
): Promise<unknown> {
  if (PROVIDERS[cfg.provider].needsKey && !cfg.apiKey) {
    throw new Error(`Add your ${PROVIDERS[cfg.provider].label} API key in Settings first.`);
  }
  if (cfg.provider === "anthropic") return anthropic(cfg, system, parts, schema, schemaName);
  if (cfg.provider === "ollama") return ollamaNative(cfg, system, parts, schema);
  return openAiCompatible(cfg, system, parts, schema, schemaName);
}
