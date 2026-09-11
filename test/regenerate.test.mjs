#!/usr/bin/env node --experimental-strip-types
// Run: npm test
import { sourceWindow } from "../lib/regenerate.ts";
import { replaceCard, newDeck, normalizeDeck, summarize } from "../lib/decks.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const card = (t, d = `Definition of ${t}.`, e = `evidence for ${t}`) =>
  ({ term: t, definition: d, evidence: e });

console.log("a short source is sent whole — there is nothing to window:");
const short = "Mitosis divides one nucleus into two identical nuclei.";
check("returned unchanged", sourceWindow(short, "divides one nucleus"), short);
check("empty source gives empty window", sourceWindow("", "anything"), "");

// A long document with a distinctive passage buried in the middle.
const filler = "Cells carry out many processes that are not relevant here. ".repeat(120);
const passage = "The Calvin cycle fixes carbon dioxide into three-carbon sugars using rubisco.";
const long = `${filler}\n\n${passage}\n\n${filler}`;

console.log("\na long source is cut down to the passage the card came from:");
const win = sourceWindow(long, passage);
check("the window is smaller than the document", win.length < long.length, true);
check("the passage is in the window", win.includes(passage), true);
check("the window is bounded", win.length <= 1500 * 2 + passage.length + 4, true);

console.log("\nthe quote is matched the way the evidence check matches it:");
check("punctuation and case differences still locate the passage",
  sourceWindow(long, "the calvin CYCLE fixes carbon dioxide, into three-carbon sugars")
    .includes(passage), true);
check("collapsed whitespace still locates the passage",
  sourceWindow(long, "The   Calvin\n\ncycle   fixes carbon dioxide").includes(passage), true);
check("a window is cut from the original, not the normalized text",
  sourceWindow(long, passage).includes("three-carbon"), true);

console.log("\nevidence that cannot be found falls back to the opening:");
const missing = sourceWindow(long, "quantum chromodynamics of the strong nuclear force");
check("something is still returned", missing.length > 0, true);
check("it is the head of the document", long.startsWith(missing), true);
check("an empty quote falls back too", sourceWindow(long, "").length > 0, true);
check("a too-short quote falls back rather than matching noise",
  long.startsWith(sourceWindow(long, "the")), true);

console.log("\nthe window reaches both edges of the document safely:");
const atStart = sourceWindow(`${passage}\n\n${filler}`, passage);
check("a passage at the very start is included", atStart.includes(passage), true);
const atEnd = sourceWindow(`${filler}\n\n${passage}`, passage);
check("a passage at the very end is included", atEnd.includes(passage), true);

console.log("\nreplacing one card leaves the rest of the deck alone:");
const deck = newDeck({
  cards: [card("A"), card("B"), card("C")],
  source: "notes.pdf", scope: null, model: null, sourceText: "some source", now: 1000,
});
const edited = replaceCard(deck, 1, { term: "Beta", definition: "A better definition." }, 2000);
check("the card changed", edited.cards[1].term, "Beta");
check("its definition changed", edited.cards[1].definition, "A better definition.");
check("its neighbours did not", edited.cards.map((c) => c.term).join(","), "A,Beta,C");
check("updatedAt moves", edited.updatedAt, 2000);
check("createdAt does not", edited.createdAt, 1000);
check("the source text is kept", edited.sourceText, "some source");
check("the original deck is not mutated", deck.cards[1].term, "B");

console.log("\nediting keeps the evidence unless a new one is supplied:");
check("evidence survives a definition-only edit", edited.cards[1].evidence, "evidence for B");
const rewritten = replaceCard(deck, 1, card("B", "Rewritten.", "a fresh quote"));
check("a supplied evidence replaces it", rewritten.cards[1].evidence, "a fresh quote");

console.log("\nan edit that would empty a card is refused:");
check("blank term returns the same deck",
  replaceCard(deck, 1, { term: "  ", definition: "x" }) === deck, true);
check("blank definition returns the same deck",
  replaceCard(deck, 1, { term: "x", definition: "   " }) === deck, true);
check("whitespace is trimmed rather than stored",
  replaceCard(deck, 0, { term: "  Spaced  ", definition: "  A  definition.  " }).cards[0],
  { term: "Spaced", definition: "A definition.", evidence: "evidence for A" });

console.log("\na stale index is ignored rather than growing the deck:");
check("past the end", replaceCard(deck, 9, card("Z")) === deck, true);
check("negative", replaceCard(deck, -1, card("Z")) === deck, true);
check("not an integer", replaceCard(deck, 1.5, card("Z")) === deck, true);
check("the deck is still three cards", deck.cards.length, 3);

console.log("\nsource text is stored, restored, and kept out of the deck list:");
check("newDeck keeps it", deck.sourceText, "some source");
check("a deck without one is null",
  newDeck({ cards: [card("A")], source: null, scope: null, model: null }).sourceText, null);
check("it survives normalizeDeck",
  normalizeDeck({ id: "a", sourceText: "hello" }).sourceText, "hello");
check("a legacy deck without one reads as null",
  normalizeDeck({ id: "a" }).sourceText, null);
check("a non-string is rejected",
  normalizeDeck({ id: "a", sourceText: 42 }).sourceText, null);
check("an empty string reads as null, so rewrite reports it honestly",
  normalizeDeck({ id: "a", sourceText: "" }).sourceText, null);
check("the deck list does not carry it", "sourceText" in summarize(deck), false);

console.log(failures === 0 ? "\nall rewrite checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
