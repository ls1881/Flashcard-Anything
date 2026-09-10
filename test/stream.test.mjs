#!/usr/bin/env node --experimental-strip-types
// Run: npm test
// overChunks is driven with a canned handler, so this checks the streaming
// contract itself without going near a model.
import { overChunks } from "../lib/pipelines.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

// Definitions have to be genuinely distinct: the deduper collapses cards that
// merely restate each other, and near-identical filler text would trip it.
const card = (t) => ({
  term: t,
  definition: `${t}phase ${t}genesis ${t}some ${t}kinesis marks a distinct stage.`,
  evidence: `evidence for ${t}`,
});

/** Run overChunks over canned per-section output, capturing what was streamed. */
async function run(sections, { maxCards = 60 } = {}) {
  const batches = [];
  const progress = [];
  const result = await overChunks(
    {
      cfg: {},
      chunks: sections.map((_, i) => `chunk ${i}`),
      context: "context",
      glossary: [],
      maxCards,
      onProgress: (p) => progress.push(p),
      onCards: (cards) => batches.push(cards.map((c) => c.term)),
    },
    async (_chunk, _shown, i) => ({ cards: sections[i], dropped: 0, fixed: 0 })
  );
  return { batches, progress, result, terms: result.cards.map((c) => c.term) };
}

console.log("cards are handed over section by section:");
const three = await run([
  [card("Mitosis"), card("Meiosis")],
  [card("Prophase")],
  [card("Anaphase"), card("Telophase")],
]);
check("one batch per section", three.batches.length, 3);
check("first section's cards arrive first", three.batches[0], ["Mitosis", "Meiosis"]);
check("second section follows", three.batches[1], ["Prophase"]);
check("third section follows", three.batches[2], ["Anaphase", "Telophase"]);

console.log("\nthe batches are the deck — a page that appends them ends up correct:");
check("concatenated batches equal the final deck",
  three.batches.flat(), three.terms);
check("nothing is streamed twice",
  new Set(three.batches.flat()).size, three.batches.flat().length);
check("the deck is what the caller returns", three.terms,
  ["Mitosis", "Meiosis", "Prophase", "Anaphase", "Telophase"]);

console.log("\nonly cards that survived dedupe are streamed:");
const dupes = await run([
  [card("Mitosis"), card("Meiosis")],
  // A repeat of a term already kept, and a fresh one.
  [card("mitosis"), card("Prophase")],
]);
check("the duplicate never reaches the page", dupes.batches[1], ["Prophase"]);
check("it is counted as a duplicate", dupes.result.duplicates, 1);
check("the deck has no repeat", dupes.terms, ["Mitosis", "Meiosis", "Prophase"]);
check("batches still equal the deck", dupes.batches.flat(), dupes.terms);

console.log("\na section that yields nothing sends nothing:");
const empty = await run([
  [card("Mitosis")],
  [],
  [card("Prophase")],
]);
check("no empty batch is emitted", empty.batches.length, 2);
check("no batch is ever empty", empty.batches.every((b) => b.length > 0), true);
check("the surviving sections still stream", empty.batches.flat(), ["Mitosis", "Prophase"]);

console.log("\na section whose cards are all duplicates sends nothing:");
const allDupes = await run([
  [card("Mitosis")],
  [card("Mitosis")],
  [card("Prophase")],
]);
check("only two batches", allDupes.batches.length, 2);
check("batches equal the deck", allDupes.batches.flat(), allDupes.terms);

console.log("\nthe card cap stops the stream as well as the deck:");
const capped = await run(
  [
    [card("A"), card("B"), card("C")],
    [card("D"), card("E"), card("F")],
    [card("G")],
  ],
  { maxCards: 4 }
);
check("the deck stops at the cap", capped.terms.length, 4);
check("nothing past the cap is streamed", capped.batches.flat().length, 4);
check("batches equal the deck", capped.batches.flat(), capped.terms);
check("the run stops early rather than reading on", capped.batches.length, 2);
check("the partial section streams only what fit", capped.batches[1], ["D"]);

console.log("\nstreaming is optional — the pipelines still run without a listener:");
const noListener = await overChunks(
  {
    cfg: {}, chunks: ["a", "b"], context: "", glossary: [], maxCards: 60,
    onProgress: () => {},
  },
  async (_chunk, _shown, i) => ({ cards: [card(`T${i}`)], dropped: 0, fixed: 0 })
);
check("the deck is unaffected", noListener.cards.map((c) => c.term), ["T0", "T1"]);

console.log("\ncounts still add up while streaming:");
const counted = await overChunks(
  {
    cfg: {}, chunks: ["a", "b"], context: "", glossary: [], maxCards: 60,
    onProgress: () => {}, onCards: () => {},
  },
  async (_chunk, _shown, i) =>
    ({ cards: [card(`T${i}`)], dropped: i + 1, fixed: i * 2 })
);
check("dropped is summed across sections", counted.dropped, 3);
check("fixed is summed across sections", counted.fixed, 2);

console.log("\nthe glossary still folds acronyms while streaming:");
const aliased = [];
const glossed = await overChunks(
  {
    cfg: {}, chunks: ["a", "b"], context: "", glossary: ["IVR = intravaginal ring"],
    maxCards: 60, onProgress: () => {}, onCards: (c) => aliased.push(c.map((x) => x.term)),
  },
  async (_chunk, _shown, i) =>
    ({ cards: [i === 0 ? card("intravaginal ring") : card("IVR")], dropped: 0, fixed: 0 })
);
check("the acronym card is not streamed as a second card", aliased.flat(), ["intravaginal ring"]);
check("and it is not in the deck twice", glossed.cards.length, 1);

console.log(failures === 0 ? "\nall streaming checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
