import type { Card } from "./duplex";

/**
 * What shape of card to write, how hard, and how many.
 *
 * All three are prompt-level choices — the pipeline, the evidence check and the
 * deduper are unchanged by any of them, so a question deck is verified against
 * its source exactly like a definition deck. Kept in their own module because
 * the page and the deck store need them, and `lib/pipelines.ts` reaches for the
 * model, which must not reach a client bundle.
 */
export type CardStyle = "definition" | "question";
export type Difficulty = "intro" | "exam";

/**
 * How much of the material to turn into cards.
 *
 * Selectiveness, not a cap. A cap alone would cut the deck off partway through
 * the document — the sections are written in order, so stopping at twenty cards
 * means twenty cards about chapter one and nothing about chapter four. The
 * choice has to reach the writer, so that each section contributes its share.
 */
export type Density = "key" | "normal" | "max";

export const CARD_STYLES: { id: CardStyle; label: string; hint: string }[] = [
  { id: "definition", label: "Definitions", hint: "A term on the front, what it means on the back." },
  { id: "question", label: "Questions", hint: "A question the source answers, and its answer." },
];

export const DIFFICULTIES: { id: Difficulty; label: string; hint: string }[] = [
  { id: "intro", label: "Introductory", hint: "Core vocabulary and the central ideas." },
  { id: "exam", label: "Exam level", hint: "Mechanisms, conditions, distinctions and figures." },
];

export const DENSITIES: { id: Density; label: string; hint: string }[] = [
  { id: "key", label: "Fewest", hint: "Only what you couldn't skip — a short deck of the central ideas." },
  { id: "normal", label: "Normal", hint: "One card per idea worth memorizing." },
  { id: "max", label: "Most", hint: "Everything the material supports, with repeats still removed." },
];

export function isDensity(v: string): v is Density {
  return v === "key" || v === "normal" || v === "max";
}

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
