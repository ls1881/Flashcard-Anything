import type { Card } from "./duplex";

/**
 * What shape of card to write, and how hard.
 *
 * Both are prompt-level choices — the pipeline, the evidence check and the
 * deduper are unchanged by either, so a question deck is verified against its
 * source exactly like a definition deck. Kept in their own module because the
 * page and the deck store need them, and `lib/pipelines.ts` reaches for the
 * model, which must not reach a client bundle.
 */
export type CardStyle = "definition" | "question";
export type Difficulty = "intro" | "exam";

export const CARD_STYLES: { id: CardStyle; label: string; hint: string }[] = [
  { id: "definition", label: "Definitions", hint: "A term on the front, what it means on the back." },
  { id: "question", label: "Questions", hint: "A question the source answers, and its answer." },
];

export const DIFFICULTIES: { id: Difficulty; label: string; hint: string }[] = [
  { id: "intro", label: "Introductory", hint: "Core vocabulary and the central ideas." },
  { id: "exam", label: "Exam level", hint: "Mechanisms, conditions, distinctions and figures." },
];

export function isCardStyle(v: string): v is CardStyle {
  return v === "definition" || v === "question";
}

export function isDifficulty(v: string): v is Difficulty {
  return v === "intro" || v === "exam";
}

/**
 * Hold a card to the shape its style promises, or discard it.
 *
 * A model asked for one shape will occasionally produce another, and a question
 * card that isn't a question is useless to study from. Only punctuation is
 * repaired: anything that needs the card's meaning changed to fit the shape
 * would be making the card up.
 */
export function shapeCard(card: Card, style: CardStyle): Card | null {
  if (style === "question") {
    const term = card.term.replace(/[.!]+$/, "").trim();
    if (!term) return null;
    return { ...card, term: term.endsWith("?") ? term : `${term}?` };
  }

  return card;
}
