#!/usr/bin/env node --experimental-strip-types
// Run: npm test
import { termKey, definitionTokens, sameMeaning, newDeck, addCards }
  from "../lib/dedupe.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${got}, want ${want})`}`);
};

console.log("term keys collapse surface variation:");
check('"intravaginal ring (IVR)" == "intravaginal ring"',
  termKey("intravaginal ring (IVR)") === termKey("intravaginal ring"), true);
check('"Krebs Cycle" == "the krebs cycle"',
  termKey("Krebs Cycle") === termKey("the krebs cycle"), true);
check('"morphemes" == "morpheme"',
  termKey("morphemes") === termKey("morpheme"), true);
check('"Free morphemes" == "free morpheme"',
  termKey("Free morphemes") === termKey("free morpheme"), true);

console.log("\nterm keys keep genuinely different concepts apart:");
check('"morpheme" != "free morpheme"',
  termKey("morpheme") !== termKey("free morpheme"), true);
check('"bank" != "banks of cells"',
  termKey("bank") !== termKey("banks of cells"), true);
check('"bias" survives (not stripped to "bia")',
  termKey("bias") === "bias", true);
check('"status" survives',
  termKey("status") === "status", true);
check('"analysis" survives',
  termKey("analysis") === "analysis", true);

console.log("\nsame-meaning detection:");
const a = definitionTokens("A flexible ring inserted vaginally that releases hormones over three weeks.");
const b = definitionTokens("A flexible ring inserted vaginally which releases hormones across three weeks.");
check("paraphrase of the same definition", sameMeaning(a, b), true);
const c = definitionTokens("Glycolysis takes place in the cytoplasm and splits glucose into pyruvate.");
const d = definitionTokens("The Krebs cycle runs in the mitochondrial matrix and releases carbon dioxide.");
check("unrelated definitions stay apart", sameMeaning(c, d), false);
const short = definitionTokens("Releases hormones.");
const long = definitionTokens(
  "A flexible ring inserted vaginally that releases hormones over three weeks, then removed for one."
);
check("a terse line does not swallow a detailed one", sameMeaning(short, long), false);

console.log("\nthe reported bug, end to end:");
const deck = newDeck();
const dropped = addCards(deck, [
  { term: "intravaginal ring", definition: "A flexible ring that releases hormones over three weeks." },
  { term: "intravaginal ring (IVR)", definition: "A flexible ring that releases hormones over three weeks." },
  { term: "IVR", definition: "A flexible ring which releases hormones across three weeks." },
  { term: "transdermal patch", definition: "An adhesive patch applied to the skin that delivers hormones weekly." },
], 60);
check("4 cards in -> 2 distinct kept", deck.cards.length, 2);
check("2 reported as duplicates", dropped, 2);
check("kept the first term", deck.cards[0].term, "intravaginal ring");
check("kept the unrelated card", deck.cards[1].term, "transdermal patch");

console.log("\nnumbers are meaningful, not noise:");
check("same wording, different figures stays apart",
  sameMeaning(
    definitionTokens("Throttling engages when the die temperature exceeds 85 degrees."),
    definitionTokens("Throttling engages when the die temperature exceeds 40 degrees.")
  ), false);

console.log("\nacronym folds into its expansion via the document glossary:");
const withGlossary = newDeck(["IVR = intravaginal ring"]);
const gDropped = addCards(withGlossary, [
  { term: "intravaginal ring", definition: "A flexible ring that releases hormones over three weeks." },
  { term: "IVR", definition: "Something else entirely about scheduling and reminders for patients." },
], 60);
check("acronym and expansion collapse to one", withGlossary.cards.length, 1);
check("counted as a duplicate", gDropped, 1);

console.log("\nmaxCards still respected:");
const distinct = [
  ["osmosis", "Water moves across a semipermeable membrane toward higher solute concentration."],
  ["mitosis", "A nucleus divides to produce two genetically identical daughter cells."],
  ["translation", "Ribosomes read messenger RNA codons and assemble a polypeptide chain."],
  ["excretion", "Metabolic waste is removed from the body, largely through the kidneys."],
  ["digestion", "Large food molecules are broken into absorbable units by enzymes in the gut."],
];
const capped = newDeck();
addCards(capped, distinct.map(([term, definition]) => ({ term, definition })), 4);
check("stops at the cap", capped.cards.length, 4);

console.log(failures === 0 ? "\nPASS" : `\nFAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
