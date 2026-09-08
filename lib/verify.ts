import { completeJson, type JsonSchema, type LlmConfig } from "./llm";
import type { Card } from "./duplex";

/**
 * A second pass over the cards one chunk produced. Matching a quote proves the quote is
 * real; it doesn't prove the definition says what the quote says. This checks that step,
 * and repairs cards rather than only discarding them.
 */

const REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "The card number being judged." },
          verdict: {
            type: "string",
            enum: ["ok", "fix", "drop"],
            description: "ok = accurate; fix = repairable; drop = unsupported by the source.",
          },
          term: { type: "string", description: "Only for fix: corrected front, 1-5 words." },
          definition: {
            type: "string",
            description: "Only for fix: corrected back, drawn strictly from the source text.",
          },
        },
        required: ["index", "verdict"],
      },
    },
  },
  required: ["reviews"],
};

const SYSTEM = `You are fact-checking flashcards that someone wrote from a source document. You reply with JSON only.

For each numbered card, compare it against the SOURCE TEXT and return one verdict:
- "ok" — the definition is accurate and fully supported by the source.
- "fix" — the card is about something real in the source, but the definition is inaccurate, overreaches, omits the point, or uses outside knowledge. Supply a corrected "definition" written only from the source.
- "drop" — the source does not actually support or explain this, or the card isn't worth memorizing.

Judge strictly:
- An acronym expanded differently than the source expands it is wrong. Answer "fix" with the source's expansion, or "drop" if the source never expands it.
- A definition that states anything the source doesn't say is wrong, even if it's true in general.
- A definition that describes the term's usual meaning in another field, rather than its meaning here, is wrong.
- A front longer than 5 words, or one that gives away the answer, should be fixed with a shorter term.

Return a review for every card, using the card's own number as "index".`;

function cardList(cards: Card[]): string {
  return cards
    .map((c, i) => `[${i}] TERM: ${c.term}\n    DEFINITION: ${c.definition}`)
    .join("\n\n");
}

export type ReviewOutcome = {
  cards: Card[];
  dropped: number;
  fixed: number;
};

export async function reviewCards(
  cfg: LlmConfig,
  sourceText: string,
  cards: Card[]
): Promise<ReviewOutcome> {
  if (!cards.length) return { cards, dropped: 0, fixed: 0 };

  const parts = [
    { type: "text" as const, text: `SOURCE TEXT:\n${sourceText}` },
    { type: "text" as const, text: `CARDS TO CHECK:\n${cardList(cards)}` },
  ];

  let raw: unknown;
  try {
    raw = await completeJson(cfg, SYSTEM, parts, REVIEW_SCHEMA, "emit_reviews");
  } catch {
    // A flaky checker shouldn't cost the user their whole deck.
    return { cards, dropped: 0, fixed: 0 };
  }

  const reviews = (raw as { reviews?: unknown })?.reviews;
  if (!Array.isArray(reviews) || !reviews.length) return { cards, dropped: 0, fixed: 0 };

  const byIndex = new Map<number, { verdict: string; term?: string; definition?: string }>();
  for (const r of reviews) {
    if (!r || typeof r !== "object") continue;
    const index = Number((r as { index?: unknown }).index);
    const verdict = String((r as { verdict?: unknown }).verdict ?? "").toLowerCase();
    if (!Number.isInteger(index)) continue;
    byIndex.set(index, {
      verdict,
      term: (r as { term?: string }).term,
      definition: (r as { definition?: string }).definition,
    });
  }

  const kept: Card[] = [];
  let dropped = 0;
  let fixed = 0;

  cards.forEach((card, i) => {
    const review = byIndex.get(i);
    // No verdict came back for this card: keep it rather than silently losing it.
    if (!review) {
      kept.push(card);
      return;
    }
    if (review.verdict === "drop") {
      dropped++;
      return;
    }
    if (review.verdict === "fix") {
      const definition = review.definition?.replace(/\s+/g, " ").trim();
      const term = review.term?.replace(/\s+/g, " ").trim();
      // A "fix" with nothing to apply is just an "ok".
      if (definition || term) fixed++;
      kept.push({
        term: term || card.term,
        definition: definition || card.definition,
        evidence: card.evidence,
      });
      return;
    }
    kept.push(card);
  });

  return { cards: kept, dropped, fixed };
}
