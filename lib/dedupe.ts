import type { Card } from "./duplex";

/**
 * A deck should never teach the same thing twice. Matching lowercased terms is not enough:
 * a document that writes "intravaginal ring (IVR)" in one section and "intravaginal ring"
 * in another yields two cards with identical backs, and an acronym card can restate its own
 * expansion under a different front.
 *
 * So a card is a duplicate if either its term normalizes to one already kept, or its
 * definition says substantially the same thing as one already kept.
 */

const ARTICLES = /^(?:the|a|an)\s+/;

/**
 * Fold the surface variations that mean the same concept: case, a trailing parenthetical
 * gloss, punctuation, a leading article, and a simple plural.
 */
export function termKey(term: string, aliases?: Map<string, string>): string {
  let key = term
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // "ring (IVR)" -> "ring"
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(ARTICLES, "");

  // Singularize only the safe cases: "morphemes" -> "morpheme", never "bias" or "status".
  if (key.length > 4 && key.endsWith("s") && !/(?:ss|us|is|as)$/.test(key)) {
    key = key.replace(/ies$/, "y").replace(/s$/, "");
  }

  // "IVR" and "intravaginal ring" are the same card when the document says so.
  return aliases?.get(key) ?? key;
}

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "and", "or", "is", "are", "was", "were", "be", "that",
  "this", "it", "its", "for", "on", "at", "by", "with", "as", "from", "which", "when",
  "where", "can", "may", "will", "would", "has", "have", "had", "not", "but", "than",
  "each", "any", "all", "one", "two", "into", "used", "use", "using", "also",
]);

/**
 * The content words of a definition, for comparing what two cards actually say. Numbers
 * are kept whatever their length: "85 degrees" and "40 degrees" are different facts, and
 * dropping short tokens would make them look identical.
 */
export function definitionTokens(definition: string): Set<string> {
  return new Set(
    definition
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => (/\d/.test(w) || w.length > 2) && !STOP.has(w))
  );
}

/**
 * Do two definitions say the same thing? Containment rather than symmetric overlap, so a
 * short restatement of a longer definition still counts, but only when the two are of
 * comparable substance — otherwise a one-line card would swallow an unrelated detailed one.
 */
export function sameMeaning(a: Set<string>, b: Set<string>, threshold = 0.85): boolean {
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  if (smaller.size < 3) return false;
  if (smaller.size / larger.size < 0.5) return false;

  // Figures are facts, not phrasing. Two cards quoting different numbers are making
  // different claims however similar the surrounding words are.
  const numbersOf = (set: Set<string>) =>
    [...set].filter((w) => /\d/.test(w)).sort().join(",");
  const na = numbersOf(a);
  const nb = numbersOf(b);
  if (na !== nb) return false;

  let shared = 0;
  for (const word of smaller) if (larger.has(word)) shared++;
  return shared / smaller.size >= threshold;
}

export type Deck = {
  cards: Card[];
  /** Term keys already used. */
  terms: Set<string>;
  /** Token sets of definitions already used, parallel to `cards`. */
  meanings: Set<string>[];
  /** Acronym -> expansion, as the document defines them. */
  aliases: Map<string, string>;
};

/**
 * `aliases` comes from the document's own "Expansion (ACR)" pairs, so an acronym card and
 * its expansion collapse to one entry instead of two cards with the same back.
 */
export function newDeck(glossary: string[] = []): Deck {
  const aliases = new Map<string, string>();
  for (const entry of glossary) {
    const [acronym, expansion] = entry.split(" = ");
    if (!acronym || !expansion) continue;
    aliases.set(termKey(acronym), termKey(expansion));
  }
  return { cards: [], terms: new Set(), meanings: [], aliases };
}

/**
 * Add cards, skipping any that repeat a term or restate a definition already in the deck.
 * Returns how many were dropped as duplicates.
 */
export function addCards(deck: Deck, cards: Card[], maxCards: number): number {
  let duplicates = 0;

  for (const card of cards) {
    if (deck.cards.length >= maxCards) break;

    const key = termKey(card.term, deck.aliases);
    if (!key || deck.terms.has(key)) {
      duplicates++;
      continue;
    }

    const meaning = definitionTokens(card.definition);
    if (deck.meanings.some((existing) => sameMeaning(meaning, existing))) {
      duplicates++;
      continue;
    }

    deck.terms.add(key);
    deck.meanings.push(meaning);
    deck.cards.push(card);
  }
  return duplicates;
}
