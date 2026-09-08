import { NextResponse } from "next/server";
import { chunkText, fileToSource, MAX_BYTES, type Source } from "@/lib/extract";
import { completeJson, resolveKey, type LlmConfig, type Part } from "@/lib/llm";
import { PROVIDERS, isProviderId } from "@/lib/providers";
import type { Card } from "@/lib/duplex";

export const runtime = "nodejs";
export const maxDuration = 800;

const MAX_CARDS = 60;

const SYSTEM = `You write study flashcards. You reply with JSON only — no commentary, no markdown fences.

Reply with exactly this shape:
{"cards":[{"term":"...","definition":"..."}]}

Rules for every card, without exception:
- "term" is only the thing being learned: a term, name, concept, formula name, date, or event. 1 to 5 words. Never a sentence, never a question, no trailing punctuation, and never any part of the definition.
- "definition" carries all the substance: 1 to 3 sentences, under 45 words, and understandable without seeing the term.
- One card per distinct idea worth memorizing. Skip title slides, agendas, page numbers, and citations.
- Use the source's own wording and never invent facts.
- No duplicate terms.`;

const userPrompt = (part: number, total: number) =>
  total > 1
    ? `Make flashcards from section ${part} of ${total} of the material above. Cover only what this section contains.`
    : `Make flashcards from the material above.`;

/** Merge in new cards, dropping repeats of terms already collected. */
function absorb(into: Card[], seen: Set<string>, raw: unknown): void {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { cards?: unknown })?.cards)
      ? (raw as { cards: unknown[] }).cards
      : [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const term = String((item as Card).term ?? "").replace(/\s+/g, " ").trim();
    const definition = String((item as Card).definition ?? "").replace(/\s+/g, " ").trim();
    if (!term || !definition) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    into.push({ term, definition });
    if (into.length >= MAX_CARDS) return;
  }
}

function buildParts(source: Source, chunk: string | null, part: number, total: number): Part[] {
  if (source.kind === "image") {
    return [
      { type: "image_url", image_url: { url: source.dataUrl } },
      { type: "text", text: `Read this image and make flashcards from what it teaches.` },
    ];
  }
  return [
    { type: "text", text: chunk ?? "" },
    { type: "text", text: userPrompt(part, total) },
  ];
}

export async function POST(req: Request) {
  let source: Source;
  let cfg: LlmConfig;

  try {
    const form = await req.formData();
    const file = form.get("file");
    const text = String(form.get("text") ?? "").trim();

    const provider = String(form.get("provider") ?? "ollama");
    if (!isProviderId(provider)) {
      return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
    }
    cfg = {
      provider,
      model: String(form.get("model") ?? "").trim() || PROVIDERS[provider].defaultModel,
      apiKey: resolveKey(provider, String(form.get("apiKey") ?? "")),
    };

    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_BYTES) {
        return NextResponse.json(
          { error: `"${file.name}" is over the ${MAX_BYTES / 1024 / 1024}MB limit.` },
          { status: 413 }
        );
      }
      source = await fileToSource(file);
    } else if (text) {
      source = { kind: "text", text };
    } else {
      return NextResponse.json({ error: "Add a file or some text first." }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Couldn't read that file.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const chunks =
    source.kind === "image"
      ? [null]
      : chunkText(source.text, PROVIDERS[cfg.provider].chunkChars);
  const encoder = new TextEncoder();

  // Streamed as NDJSON so the page can show progress; local runs take real time.
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      const cards: Card[] = [];
      const seen = new Set<string>();

      try {
        for (let i = 0; i < chunks.length; i++) {
          send({ type: "progress", done: i, total: chunks.length, cards: cards.length });
          const parts = buildParts(source, chunks[i], i + 1, chunks.length);
          absorb(cards, seen, await completeJson(cfg, SYSTEM, parts));
          if (cards.length >= MAX_CARDS) break;
        }

        if (!cards.length) {
          send({
            type: "error",
            error:
              source.kind === "image"
                ? `No cards came back. "${cfg.model}" may not read images — try a vision model.`
                : "Couldn't find anything to make flashcards from in that.",
          });
        } else {
          send({ type: "result", cards });
        }
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Something went wrong." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
