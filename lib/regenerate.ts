import { completeJson, type JsonSchema, type LlmConfig, type Part } from "./llm";
import { definitionTokens, sameMeaning } from "./dedupe";
import { isGrounded } from "./pipelines";
import type { Card } from "./duplex";

/**
 * Rewriting one card, rather than rerunning the whole document.
 *
 * When 18 of 20 cards are right, the old recourse was generating everything
 * again — minutes of model time to fix two cards. This is one call against the
 * slice of the source the card came from.
 */

const RADIUS = 1500;

/**
 * Lowercase, with every run of non-alphanumerics collapsed to one space, plus a
 * map back to offsets in the original. Matching has to be done on the
 * normalized form — a model's quote differs from the source in whitespace and
 * punctuation far more often than in words — but the window has to be cut from
 * the original text, so the mapping is what makes both possible.
 */
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i].toLowerCase();
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      if (pendingSpace && norm.length > 0) {
        norm += " ";
        map.push(i);
        pendingSpace = false;
      }
      norm += ch;
      map.push(i);
    } else {
      pendingSpace = true;
    }
  }
  return { norm, map };
}

/**
 * The slice of the source a card came from: a window around its quoted
 * evidence. Sending the whole document back for one card would be slower, and
 * on a long document would push the real passage out of a small context window
 * entirely.
 *
 * Falls back to the opening of the document when the evidence can't be located
 * — a card with no usable quote still deserves an attempt, and the caller
 * checks the result against the source either way.
 */
export function sourceWindow(text: string, evidence: string, radius = RADIUS): string {
  if (!text) return "";
  if (text.length <= radius * 2) return text;

  const needle = normalizeWithMap(evidence).norm;
  if (needle.length >= 12) {
    const hay = normalizeWithMap(text);
    const at = hay.norm.indexOf(needle);
    if (at !== -1) {
      const start = hay.map[at];
      const end = hay.map[Math.min(at + needle.length - 1, hay.map.length - 1)];
      return text.slice(Math.max(0, start - radius), Math.min(text.length, end + radius));
    }
  }
  return text.slice(0, radius * 2);
}

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    definition: {
      type: "string",
      description: "1-3 sentences, under 45 words, built only from the source text.",
    },
    evidence: {
      type: "string",
      description:
        "A short span copied word-for-word from the source that states this definition.",
    },
  },
  required: ["definition", "evidence"],
};

const SYSTEM = `You rewrite a single study flashcard's definition using only the source text you are given. You reply with JSON only — no commentary, no markdown fences.

Reply with exactly this shape:
{"definition":"...","evidence":"..."}

THE GROUNDING RULE, which overrides everything else:
The definition must come from the SOURCE TEXT and nothing else. You are not being asked what the term means in general — you are being asked what it means in this text.
- Never expand an acronym unless the expansion appears in the source.
- Never use outside knowledge, even when you are confident.
- "evidence" must be a span copied word-for-word from the source that states what you wrote. If you cannot copy such a span, you cannot write the definition.

Rules for the definition:
- 1 to 3 sentences, under 45 words.
- Understandable without seeing the term.
- It must be a genuinely different attempt from the rejected one below — not a reworded copy of it. If the rejected definition was wrong, correct it; if it was vague, be specific; if it missed the point the source makes, make that point.
- Never restate what one of the other cards already covers.`;

export type Regenerated =
  | { ok: true; card: Card }
  | { ok: false; reason: string };

/**
 * One model call for one card. The result is held to the same bar the deck was
 * built with: the quote has to appear in the source, and the definition must not
 * restate a card already in the deck.
 */
export async function regenerateCard(input: {
  cfg: LlmConfig;
  card: Card;
  sourceText: string;
  /** Definitions of the deck's other cards, so the rewrite doesn't duplicate one. */
  otherCards: Card[];
}): Promise<Regenerated> {
  const window = sourceWindow(input.sourceText, input.card.evidence ?? "");
  if (!window.trim()) {
    return { ok: false, reason: "This deck has no source text saved, so there's nothing to read." };
  }

  const others = input.otherCards
    .slice(0, 40)
    .map((c) => `- ${c.term}: ${c.definition}`)
    .join("\n");

  const parts: Part[] = [
    { type: "text", text: `SOURCE TEXT:\n${window}` },
    {
      type: "text",
      text:
        `TERM: ${input.card.term}\n` +
        `REJECTED DEFINITION (the reader asked for a different one):\n${input.card.definition}`,
    },
    ...(others
      ? [{ type: "text" as const, text: `OTHER CARDS IN THIS DECK — do not restate these:\n${others}` }]
      : []),
    {
      type: "text",
      text: `Write a new definition of "${input.card.term}" from the source text above.`,
    },
  ];

  const raw = (await completeJson(input.cfg, SYSTEM, parts, SCHEMA, "emit_definition")) as
    | { definition?: unknown; evidence?: unknown }
    | null;

  const definition = String(raw?.definition ?? "").replace(/\s+/g, " ").trim();
  const evidence = String(raw?.evidence ?? "").replace(/\s+/g, " ").trim();

  if (!definition) {
    return { ok: false, reason: `"${input.cfg.model}" didn't return a definition.` };
  }
  if (!isGrounded(evidence, window)) {
    return {
      ok: false,
      reason: `"${input.cfg.model}" couldn't quote the source for a new definition, so nothing was changed.`,
    };
  }

  // The same bar the deck was built with: a rewrite that restates another card
  // would quietly reintroduce the duplicate the deduper removed.
  const meaning = definitionTokens(definition);
  if (input.otherCards.some((c) => sameMeaning(meaning, definitionTokens(c.definition)))) {
    return {
      ok: false,
      reason: "The rewrite said the same thing as another card in the deck, so nothing was changed.",
    };
  }

  return { ok: true, card: { term: input.card.term, definition, evidence } };
}
