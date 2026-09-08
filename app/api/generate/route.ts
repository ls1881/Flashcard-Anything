import { NextResponse } from "next/server";
import { buildGlossary, chunkText, fileToSource, MAX_BYTES, type Source } from "@/lib/extract";
import { completeJson, resolveKey, type LlmConfig, type Part } from "@/lib/llm";
import { PROVIDERS, isProviderId } from "@/lib/providers";
import { reviewCards } from "@/lib/verify";
import type { Card } from "@/lib/duplex";

export const runtime = "nodejs";
export const maxDuration = 800;

const MAX_CARDS = 60;

const SYSTEM = `You write study flashcards from a source document. You reply with JSON only — no commentary, no markdown fences.

Reply with exactly this shape:
{"cards":[{"term":"...","definition":"...","evidence":"..."}]}

THE GROUNDING RULE, which overrides everything else:
Every definition must come from THIS document and nothing else. You are not being asked what a term means in general — you are being asked what it means in this text. The same acronym or phrase means different things in different fields, and your prior knowledge of it is almost certainly wrong here.
- Never expand an acronym unless the expansion appears in the document. If the text doesn't expand it, describe how the document uses it instead.
- Never define a term using outside knowledge, even when you are confident.
- If the document uses a term but never explains it, do not make a card for it.
- "evidence" must be a short span copied word-for-word from the text above that states what you wrote. If you cannot copy such a span, do not emit that card.

Rules for every card:
- "term" is only the thing being learned: a term, name, concept, formula name, date, or event. 1 to 5 words. Never a sentence, never a question, no trailing punctuation, and never any part of the definition.
- "definition" carries all the substance: 1 to 3 sentences, under 45 words, understandable without seeing the term, and faithful to how this document uses it.
- One card per distinct idea worth memorizing. Skip title slides, agendas, page numbers, and citations.
- No duplicate terms.`;

const userPrompt = (part: number, total: number) =>
  total > 1
    ? `Make flashcards from section ${part} of ${total} of the material above. Cover only what this section contains.`
    : `Make flashcards from the material above.`;

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Does the model's quoted evidence actually appear in what it was shown? Exact match
 * after normalization, with a word-overlap fallback for models that mangle quotes
 * slightly. Invented content — an acronym expanded from prior knowledge, say — shares
 * almost no vocabulary with the source and fails either way.
 */
function isGrounded(evidence: string, haystack: string): boolean {
  const needle = normalizeForMatch(evidence);
  if (needle.length < 12) return false;
  const hay = normalizeForMatch(haystack);
  if (hay.includes(needle)) return true;

  const words = needle.split(" ").filter((w) => w.length > 3);
  if (words.length < 3) return false;
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.85;
}

/**
 * Pull well-formed cards out of a model response, keeping only those whose quoted
 * evidence really appears in what the model was shown. `haystack` is null for images,
 * where there's no extracted text to check a quote against.
 */
function harvest(raw: unknown, haystack: string | null): { cards: Card[]; dropped: number } {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { cards?: unknown })?.cards)
      ? (raw as { cards: unknown[] }).cards
      : [];

  const cards: Card[] = [];
  let dropped = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const term = String((item as Card).term ?? "").replace(/\s+/g, " ").trim();
    const definition = String((item as Card).definition ?? "").replace(/\s+/g, " ").trim();
    const evidence = String((item as Card).evidence ?? "").replace(/\s+/g, " ").trim();
    if (!term || !definition) continue;

    if (haystack !== null && !isGrounded(evidence, haystack)) {
      dropped++;
      continue;
    }
    cards.push({ term, definition, evidence });
  }
  return { cards, dropped };
}

/** Add to the deck, skipping terms already covered by an earlier chunk. */
function mergeInto(deck: Card[], seen: Set<string>, cards: Card[]): void {
  for (const card of cards) {
    const key = card.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deck.push(card);
    if (deck.length >= MAX_CARDS) return;
  }
}

/**
 * Chunking hides the rest of the paper from each call, which is exactly when a model
 * starts inventing. Every chunk gets the document's opening and its acronym glossary so
 * terms are read in this document's context rather than the model's priors.
 */
function contextBlock(source: Source): string {
  if (source.kind === "image") return "";
  const glossary = buildGlossary(source.text);
  const opening = source.text.slice(0, 700).trim();
  const parts = [
    "DOCUMENT CONTEXT — use this to interpret terms correctly. Do not make cards from this block alone.",
    `Opening of the document:\n${opening}`,
  ];
  if (glossary.length) {
    parts.push(
      `Abbreviations as this document defines them — always use these, never your own expansion:\n${glossary
        .map((g) => `- ${g}`)
        .join("\n")}`
    );
  }
  return parts.join("\n\n");
}

function buildParts(
  source: Source,
  chunk: string | null,
  part: number,
  total: number,
  context: string
): Part[] {
  if (source.kind === "image") {
    return [
      { type: "image_url", image_url: { url: source.dataUrl } },
      {
        type: "text",
        text: "Read this image and make flashcards from what it teaches, using only what the image says.",
      },
    ];
  }
  return [
    ...(context ? [{ type: "text" as const, text: context }] : []),
    { type: "text", text: `SOURCE TEXT:\n${chunk ?? ""}` },
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
      const context = contextBlock(source);
      let dropped = 0;
      let fixed = 0;

      try {
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const shown = `${context}\n${chunk ?? ""}`;

          // Pass 1 — write cards from this section.
          send({ type: "progress", phase: "reading", done: i, total: chunks.length, cards: cards.length });
          const parts = buildParts(source, chunk, i + 1, chunks.length, context);
          const result = await completeJson(cfg, SYSTEM, parts);

          // Check each quote against exactly what this call was shown.
          const found = harvest(result, source.kind === "image" ? null : shown);
          dropped += found.dropped;

          // Pass 2 — a second look that judges each definition against the source.
          if (found.cards.length && source.kind !== "image") {
            send({
              type: "progress",
              phase: "checking",
              done: i,
              total: chunks.length,
              cards: cards.length,
            });
            const reviewed = await reviewCards(cfg, shown, found.cards);
            dropped += reviewed.dropped;
            fixed += reviewed.fixed;
            mergeInto(cards, seen, reviewed.cards);
          } else {
            mergeInto(cards, seen, found.cards);
          }

          if (cards.length >= MAX_CARDS) break;
        }

        if (!cards.length) {
          send({
            type: "error",
            error:
              source.kind === "image"
                ? `No cards came back. "${cfg.model}" may not read images — try a vision model.`
                : dropped > 0
                  ? `Every card "${cfg.model}" produced was making things up rather than reading the text, so all ${dropped} were dropped. Try a larger model.`
                  : "Couldn't find anything to make flashcards from in that.",
          });
        } else {
          send({ type: "result", cards, dropped, fixed });
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
