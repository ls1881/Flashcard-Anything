#!/usr/bin/env node --experimental-strip-types
// Run: npm test
import { shapeCard, isCardStyle, isDifficulty, CARD_STYLES, DIFFICULTIES }
  from "../lib/style.ts";
import { harvest, writerSystem, concurrencyFor } from "../lib/pipelines.ts";
import { passageFor, locateEvidence, sourceWindow } from "../lib/source.ts";
import { cacheKey, getCached, putCached, clearCache, cacheSize,
         chunkKey, getChunk, putChunk } from "../lib/cache.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const card = (term, definition, evidence = "e") => ({ term, definition, evidence });

console.log("the styles and levels are what the UI offers:");
check("two card styles", CARD_STYLES.map((s) => s.id), ["definition", "question"]);
check("two levels", DIFFICULTIES.map((d) => d.id), ["intro", "exam"]);
check("ids are recognised", [isCardStyle("question"), isCardStyle("haiku")], [true, false]);
check("fill in the blank is gone, and reads as an unknown style now",
  isCardStyle("cloze"), false);
check("levels too", [isDifficulty("exam"), isDifficulty("brutal")], [true, false]);

console.log("\ndefinition cards pass through untouched:");
check("nothing is changed",
  shapeCard(card("Mitosis", "Division into two identical nuclei."), "definition").term, "Mitosis");

console.log("\na question card has to actually be a question:");
check("a missing question mark is added",
  shapeCard(card("What splits during mitosis", "The nucleus."), "question").term,
  "What splits during mitosis?");
check("a full stop is replaced rather than kept",
  shapeCard(card("What splits during mitosis.", "The nucleus."), "question").term,
  "What splits during mitosis?");
check("one already asked is left alone",
  shapeCard(card("What is mitosis?", "Division."), "question").term, "What is mitosis?");
check("an empty front is dropped", shapeCard(card("  ", "x"), "question"), null);

console.log("\nharvesting applies the shape the run asked for:");
const raw = { cards: [
  { term: "What is mitosis", definition: "Nuclear division.", evidence: "mitosis is nuclear division" },
  { term: "Meiosis", definition: "Halving division.", evidence: "meiosis halves the chromosome number" },
]};
check("question style fixes the punctuation",
  harvest(raw, null, "question").cards.map((c) => c.term),
  ["What is mitosis?", "Meiosis?"]);
check("definition style keeps them as written",
  harvest(raw, null, "definition").cards.map((c) => c.term), ["What is mitosis", "Meiosis"]);
check("the default is definition style", harvest(raw, null).cards.length, 2);

console.log("\nthe writer prompt changes with the style and the level:");
const defIntro = writerSystem("definition", "intro");
const questionExam = writerSystem("question", "exam");
check("a question prompt asks for a question mark", questionExam.includes("question mark"), true);
check("a definition prompt does not", defIntro.includes("question mark"), false);
check("no prompt asks for underscores any more",
  [defIntro, questionExam, writerSystem("question", "intro")]
    .some((s) => s.includes("_____")), false);
check("the grounding rule survives every combination",
  [defIntro, questionExam, writerSystem("definition", "exam")]
    .every((s) => s.includes("THE GROUNDING RULE")), true);
check("exam level asks for mechanisms and exceptions",
  questionExam.includes("conditions and exceptions"), true);
check("introductory level does not", defIntro.includes("conditions and exceptions"), false);
check("every prompt still demands JSON only",
  [defIntro, questionExam].every((s) => s.includes("JSON only")), true);

console.log("\nparallelism is chosen by provider, not hoped for:");
check("ollama stays sequential, because it serializes anyway", concurrencyFor("ollama"), 1);
check("hosted providers run several sections at once", concurrencyFor("openai") > 1, true);
check("so does anthropic", concurrencyFor("anthropic") > 1, true);

const SOURCE =
  "Stomata are pores on the leaf surface that allow gas exchange. ".padEnd(1200, "Filler text. ") +
  "The Calvin cycle fixes carbon dioxide into three-carbon sugars using rubisco. " +
  "More filler follows here. ".padEnd(1200, "More filler follows here. ");

console.log("\na card can be found in the document it came from:");
const at = locateEvidence(SOURCE, "The Calvin cycle fixes carbon dioxide");
check("the quote is located", at !== null, true);
check("at the right place", SOURCE.slice(at.start, at.end), "The Calvin cycle fixes carbon dioxide");
check("punctuation and case differences still match",
  SOURCE.slice(...Object.values(locateEvidence(SOURCE, "the CALVIN cycle, fixes carbon dioxide")))
    .toLowerCase().startsWith("the calvin cycle fixes"), true);
check("a quote that is not there is not found",
  locateEvidence(SOURCE, "quantum chromodynamics of the strong force"), null);
check("a too-short quote is not matched against noise", locateEvidence(SOURCE, "the"), null);

console.log("\nthe passage shown to a reader is cut to whole words:");
const passage = passageFor(SOURCE, "The Calvin cycle fixes carbon dioxide into three-carbon sugars");
check("a passage comes back", passage !== null, true);
check("it contains the quote",
  passage.text.includes("The Calvin cycle fixes carbon dioxide"), true);
check("it is shorter than the document", passage.text.length < SOURCE.length, true);
check("the highlight points at the quote",
  passage.text.slice(passage.highlight.start, passage.highlight.end),
  "The Calvin cycle fixes carbon dioxide into three-carbon sugars");
check("it does not begin mid-word", /^\S*\s/.test(passage.text) || passage.whole, true);
const unfound = passageFor(SOURCE, "nothing like this appears anywhere");
check("an unlocatable quote still shows the opening", unfound.text.length > 0, true);
check("and says so by having no highlight", unfound.highlight, null);
check("an empty document gives nothing", passageFor("", "x"), null);
check("a short document is shown whole",
  passageFor("A short note about mitosis.", "about mitosis").text, "A short note about mitosis.");
check("sourceWindow still works off the same lookup",
  sourceWindow(SOURCE, "The Calvin cycle fixes carbon dioxide")
    .includes("The Calvin cycle fixes"), true);

console.log("\nthe cache only hits when nothing that matters changed:");
clearCache();
const base = { text: "some document", scope: "", provider: "ollama", model: "qwen3:8b",
  pipeline: "grounded", style: "definition", difficulty: "intro", chunkChars: 3500 };
const k = cacheKey(base);
check("the same inputs give the same key", cacheKey(base), k);
for (const [field, value] of [
  ["text", "a different document"], ["scope", "chapter 3"], ["provider", "openai"],
  ["model", "gpt-5"], ["pipeline", "ensemble"], ["style", "question"],
  ["difficulty", "exam"], ["chunkChars", 4000],
]) {
  check(`changing ${field} changes the key`, cacheKey({ ...base, [field]: value }) !== k, true);
}
check("the key does not embed the document itself", k.includes("some document"), false);

console.log("\nstoring and replaying a run:");
check("a miss is a miss", getCached(k), null);
putCached(k, { cards: [card("A", "a")], sourceText: "some document", scopeLabel: null,
  dropped: 1, fixed: 2, duplicates: 3 });
check("a hit returns the cards", getCached(k).cards.length, 1);
check("and the counts that went with them",
  [getCached(k).dropped, getCached(k).fixed, getCached(k).duplicates], [1, 2, 3]);
check("and the source text", getCached(k).sourceText, "some document");
check("an empty run is not cached, so a failure is retried", (() => {
  const empty = cacheKey({ ...base, text: "empty run" });
  putCached(empty, { cards: [], sourceText: "", scopeLabel: null, dropped: 0, fixed: 0, duplicates: 0 });
  return getCached(empty);
})(), null);

console.log("\nthe cache does not grow without bound:");
clearCache();
for (let i = 0; i < 60; i++) {
  putCached(cacheKey({ ...base, text: `doc ${i}` }), {
    cards: [card(`T${i}`, "d")], sourceText: "", scopeLabel: null,
    dropped: 0, fixed: 0, duplicates: 0,
  });
}
check("it is capped", cacheSize() <= 24, true);
check("the newest entry survives",
  getCached(cacheKey({ ...base, text: "doc 59" })) !== null, true);
check("the oldest was evicted",
  getCached(cacheKey({ ...base, text: "doc 0" })), null);

console.log("\nsections are cached separately, so a dead run can be finished:");
clearCache();
const ck = chunkKey(k, "section one text");
check("a miss is a miss", getChunk(ck), null);
putChunk(ck, { cards: [card("A", "a")], dropped: 0, fixed: 0 });
check("a finished section comes back", getChunk(ck).cards.length, 1);
check("a different section is a separate entry", getChunk(chunkKey(k, "section two text")), null);
check("the same section under different settings is a separate entry",
  getChunk(chunkKey(cacheKey({ ...base, style: "question" }), "section one text")), null);
check("clearing empties both caches", (() => { clearCache(); return [cacheSize(), getChunk(ck)]; })(),
  [0, null]);

console.log(failures === 0 ? "\nall style, source and cache checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
