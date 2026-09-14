import type { Card } from "./duplex";

/**
 * What shape of card to write, and how hard.
 *
 * Both are prompt-level choices — the pipeline, the evidence check and the
 * deduper are unchanged by either, so a cloze deck is verified against its
 * source exactly like a definition deck. Kept in their own module because the
 * page and the deck store need them, and `lib/pipelines.ts` reaches for the
 * model, which must not reach a client bundle.
 */
export type CardStyle = "definition" | "question" | "cloze";
export type Difficulty = "intro" | "exam";

export const CARD_STYLES: { id: CardStyle; label: string; hint: string }[] = [
  { id: "definition", label: "Definitions", hint: "A term on the front, what it means on the back." },
  { id: "question", label: "Questions", hint: "A question the source answers, and its answer." },
  { id: "cloze", label: "Fill in the blank", hint: "A sentence with the key part removed." },
];

export const DIFFICULTIES: { id: Difficulty; label: string; hint: string }[] = [
  { id: "intro", label: "Introductory", hint: "Core vocabulary and the central ideas." },
  { id: "exam", label: "Exam level", hint: "Mechanisms, conditions, distinctions and figures." },
];

export function isCardStyle(v: string): v is CardStyle {
  return v === "definition" || v === "question" || v === "cloze";
}

export function isDifficulty(v: string): v is Difficulty {
  return v === "intro" || v === "exam";
}

/** A cloze blank, however many underscores the model felt like typing. */
export const CLOZE_BLANK = "_____";
const BLANK_RUN = /_{2,}/g;

/**
 * Hold a card to the shape its style promises, or discard it.
 *
 * A question card that isn't a question and a cloze card with no blank are both
 * useless to study from, and a model asked for one shape will occasionally
 * produce another. Punctuation is repaired; a missing blank is not, because
 * inventing where the gap goes would be making the card up.
 */
export function shapeCard(card: Card, style: CardStyle): Card | null {
  if (style === "question") {
    const term = card.term.replace(/[.!]+$/, "").trim();
    if (!term) return null;
    return { ...card, term: term.endsWith("?") ? term : `${term}?` };
  }

  if (style === "cloze") {
    const runs = card.term.match(BLANK_RUN);
    // No gap, or several, and it is not a cloze card at all.
    if (!runs || runs.length !== 1) return null;
    const term = card.term.replace(BLANK_RUN, CLOZE_BLANK).trim();
    const answer = card.definition.trim();
    if (!answer) return null;
    // The answer sitting in the sentence gives the game away.
    const rest = term.replace(CLOZE_BLANK, " ");
    if (answer.length > 2 && rest.toLowerCase().includes(answer.toLowerCase())) return null;
    return { ...card, term, definition: answer };
  }

  return card;
}

/**
 * The cloze sentence with the blank filled back in, marked up the way Anki
 * wants it: `{{c1::answer}}`. Anki's cloze note type reads that directly.
 */
export function toAnkiCloze(card: Card): string {
  if (!card.term.includes(CLOZE_BLANK)) return card.term;
  return card.term.replace(CLOZE_BLANK, `{{c1::${card.definition}}}`);
}
