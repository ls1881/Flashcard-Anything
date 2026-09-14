import { completeJson, type JsonSchema, type LlmConfig, type Part } from "./llm";
import { definitionTokens, sameMeaning } from "./dedupe";
import { isGrounded } from "./pipelines";
import { sourceWindow } from "./source";
import type { Card } from "./duplex";

/**
 * Rewriting one card, rather than rerunning the whole document.
 *
 * When 18 of 20 cards are right, the old recourse was generating everything
 * again — minutes of model time to fix two cards. This is one call against the
 * slice of the source the card came from.
 */

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
- Never restate what one of the other cards already covers.

THE REWRITE RULE:
The reader has already read the rejected definition below and asked for something else, so returning the same content in different words is a failed answer. Change what the card actually says, using material from the source the rejected version left out:
- Say how or why, not just what — the mechanism, the conditions, the sequence.
- Include the specifics the source gives: figures, names, stages, inputs and outputs.
- If the rejected definition merely echoes the term, define it instead.
- If the rejected definition was wrong, correct it and say what the source actually claims.
Do not begin by restating the term.`;

export type Regenerated =
  | { ok: true; card: Card }
  | { ok: false; reason: string };

/**
 * Card writing runs at temperature 0, because the same document should give the
 * same deck. A rewrite is the opposite case: asking the same model the same
 * question about the same passage at temperature 0 returns the answer the reader
 * has just rejected. So this path samples, and samples harder on a second try.
 */
const TEMPERATURES = [0.8, 1.0];

/**
 * One model call for one card — two if the first comes back saying what the old
 * card already said.
 *
 * The result is held to the bar the deck was built with (the quote must appear
 * in the source, and it must not restate another card) plus one this path needs
 * of its own: it must not restate the definition it is replacing. Without that,
 * a "rewrite" that reshuffles the same words looks like a button that does
 * nothing.
 */
export async function regenerateCard(input: {
  cfg: LlmConfig;
  card: Card;
  sourceText: string;
  /** Definitions of the deck's other cards, so the rewrite doesn't duplicate one. */
  otherCards: Card[];
  /** Swapped out by the tests; production always uses the real model. */
  complete?: (cfg: LlmConfig, system: string, parts: Part[]) => Promise<unknown>;
}): Promise<Regenerated> {
  const complete =
    input.complete ??
    ((cfg, system, parts) => completeJson(cfg, system, parts, SCHEMA, "emit_definition"));
  const window = sourceWindow(input.sourceText, input.card.evidence ?? "");
  if (!window.trim()) {
    return { ok: false, reason: "This deck has no source text saved, so there's nothing to read." };
  }

  const others = input.otherCards
    .slice(0, 40)
    .map((c) => `- ${c.term}: ${c.definition}`)
    .join("\n");
  const previous = definitionTokens(input.card.definition);

  /** Attempts that came back too close to the old card, to show the model. */
  const tooSimilar: string[] = [];
  let lastReason = `"${input.cfg.model}" didn't return a definition.`;

  for (const temperature of TEMPERATURES) {
    const parts: Part[] = [
      { type: "text", text: `SOURCE TEXT:\n${window}` },
      {
        type: "text",
        text:
          `TERM: ${input.card.term}\n` +
          `REJECTED DEFINITION (the reader has read this and asked for something else):\n` +
          input.card.definition,
      },
      ...(others
        ? [{ type: "text" as const, text: `OTHER CARDS IN THIS DECK — do not restate these:\n${others}` }]
        : []),
      ...(tooSimilar.length
        ? [{
            type: "text" as const,
            text:
              `YOUR PREVIOUS ATTEMPT WAS REJECTED for saying the same thing as the ` +
              `rejected definition:\n${tooSimilar.join("\n")}\n` +
              `Write something that makes a different point from the source.`,
          }]
        : []),
      {
        type: "text",
        text: `Write a new definition of "${input.card.term}" from the source text above.`,
      },
    ];

    const raw = (await complete({ ...input.cfg, temperature }, SYSTEM, parts)) as
      | { definition?: unknown; evidence?: unknown }
      | null;

    const definition = String(raw?.definition ?? "").replace(/\s+/g, " ").trim();
    const evidence = String(raw?.evidence ?? "").replace(/\s+/g, " ").trim();

    if (!definition) continue;

    if (!isGrounded(evidence, window)) {
      lastReason =
        `"${input.cfg.model}" couldn't quote the source for a new definition, so nothing was changed.`;
      continue;
    }

    const meaning = definitionTokens(definition);

    // The point of the button: a rewrite that says what the card already said
    // is not a rewrite. Try again rather than pretending something happened.
    if (sameMeaning(meaning, previous)) {
      tooSimilar.push(definition);
      lastReason =
        `"${input.cfg.model}" kept producing the same definition. The source may not support ` +
        `a different one — edit the card by hand if you want it worded differently.`;
      continue;
    }

    // A rewrite that restates another card would quietly reintroduce the
    // duplicate the deduper removed.
    if (input.otherCards.some((c) => sameMeaning(meaning, definitionTokens(c.definition)))) {
      lastReason =
        "The rewrite said the same thing as another card in the deck, so nothing was changed.";
      continue;
    }

    return { ok: true, card: { term: input.card.term, definition, evidence } };
  }

  return { ok: false, reason: lastReason };
}
