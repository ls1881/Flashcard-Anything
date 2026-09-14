#!/usr/bin/env node --experimental-strip-types
// Run: npm test
import { regenerateCard } from "../lib/regenerate.ts";
import { sourceWindow } from "../lib/source.ts";
import { definitionTokens, sameMeaning } from "../lib/dedupe.ts";
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

// A long enough source that a quote can be found in it and there is room to say
// something different the second time.
const SOURCE =
  "Stomata are pores on the leaf surface that allow gas exchange. Each pore is " +
  "flanked by two guard cells, which swell to open it and slacken to close it. " +
  "Opening admits the carbon dioxide photosynthesis needs, at the cost of losing " +
  "water vapour, so most plants close their stomata during drought.";

const OLD = { term: "Stomata", definition: "Pores on the leaf surface that allow gas exchange.",
  evidence: "Stomata are pores on the leaf surface that allow gas exchange" };

/** Drive regenerateCard with canned model replies instead of a model. */
async function rewriteWith(replies, { card = OLD, otherCards = [] } = {}) {
  const calls = [];
  const result = await regenerateCard({
    cfg: { provider: "ollama", model: "test-model" },
    card, sourceText: SOURCE, otherCards,
    complete: async (cfg, _system, parts) => {
      calls.push({ temperature: cfg.temperature, prompt: parts.map((p) => p.text).join("\n") });
      return replies[Math.min(calls.length - 1, replies.length - 1)];
    },
  });
  return { result, calls };
}

const reply = (definition, evidence = "Stomata are pores on the leaf surface that allow gas exchange") =>
  ({ definition, evidence });

console.log("\nthe bug: a rewrite that restates the card is not a rewrite:");
check("the pair that slipped through before is recognised as the same meaning",
  sameMeaning(
    definitionTokens("Pores on the leaf surface that allow gas exchange."),
    definitionTokens("Stomata are pores on the leaf surface that allow the gas exchange photosynthesis requires.")
  ), true);

const echoed = await rewriteWith([
  reply("Stomata are pores on the leaf surface that allow the gas exchange photosynthesis requires."),
]);
check("a reworded copy is refused rather than saved", echoed.result.ok, false);
check("and it says the model kept repeating itself",
  echoed.result.reason.includes("kept producing the same definition"), true);
check("and it points at editing by hand", echoed.result.reason.includes("by hand"), true);
check("it tried twice before giving up", echoed.calls.length, 2);

console.log("\nasking again means asking differently, or the answer cannot change:");
check("the first attempt samples rather than running at temperature 0",
  echoed.calls[0].temperature > 0, true);
check("the second attempt samples harder still",
  echoed.calls[1].temperature > echoed.calls[0].temperature, true);
check("the retry is told what was too similar",
  echoed.calls[1].prompt.includes("YOUR PREVIOUS ATTEMPT WAS REJECTED"), true);
check("and is shown the attempt itself",
  echoed.calls[1].prompt.includes("photosynthesis requires"), true);
check("the first attempt carries no such note",
  echoed.calls[0].prompt.includes("YOUR PREVIOUS ATTEMPT"), false);

console.log("\na genuinely different definition is accepted:");
const better = await rewriteWith([
  reply("Guard cells flank each pore, swelling to open it and slackening to close it, which trades water vapour for carbon dioxide.")
]);
check("accepted", better.result.ok, true);
check("only one call was needed", better.calls.length, 1);
check("the new definition is stored", better.result.card.definition.startsWith("Guard cells flank"), true);
check("the term is left alone", better.result.card.term, "Stomata");
check("the new evidence is stored", better.result.card.evidence.length > 0, true);

console.log("\na second attempt can rescue a first one that echoed:");
const rescued = await rewriteWith([
  reply("Stomata are pores on the leaf surface that allow the gas exchange photosynthesis requires."),
  reply("Guard cells flank each pore, swelling to open it and slackening to close it, which trades water vapour for carbon dioxide."),
]);
check("accepted on the retry", rescued.result.ok, true);
check("it took both attempts", rescued.calls.length, 2);
check("the second answer is the one kept",
  rescued.result.card.definition.startsWith("Guard cells flank"), true);

console.log("\nthe old bars still apply:");
const ungrounded = await rewriteWith([
  { definition: "Something the source never says about quantum chromodynamics.",
    evidence: "quantum chromodynamics of the strong nuclear force" },
]);
check("an unquotable definition is refused", ungrounded.result.ok, false);
check("and says the quote failed", ungrounded.result.reason.includes("couldn't quote the source"), true);

const duplicate = await rewriteWith(
  [reply("Guard cells flank each pore, swelling to open it and slackening to close it, which trades water vapour for carbon dioxide.")],
  { otherCards: [{ term: "Guard cells",
      definition: "Guard cells flank each pore, swelling to open it and slackening to close it, trading water vapour for carbon dioxide.",
      evidence: "e" }] }
);
check("a rewrite that restates another card is refused", duplicate.result.ok, false);
check("and says so", duplicate.result.reason.includes("same thing as another card"), true);

const empty = await rewriteWith([{ definition: "   ", evidence: "x" }]);
check("an empty definition is refused", empty.result.ok, false);

const noSource = await regenerateCard({
  cfg: { provider: "ollama", model: "m" }, card: OLD, sourceText: "", otherCards: [],
  complete: async () => { throw new Error("the model should never be called"); },
});
check("a deck with no source text never reaches the model", noSource.ok, false);
check("and explains why", noSource.reason.includes("no source text"), true);

console.log(failures === 0 ? "\nall rewrite checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
