#!/usr/bin/env node --experimental-strip-types
// Run: npm test
// Opens the generated .apkg and checks it against Anki's own invariants.
// For proof it really imports, test/anki-import-check.py runs the real library.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { buildApkg, buildRows, guidFor, fieldChecksum, toAnkiHtml, toAnkiTag }
  from "../lib/anki.ts";
import { ankiFileName, deckSlug } from "../lib/decks.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const card = (term, definition) => ({ term, definition, evidence: `evidence for ${term}` });
const CARDS = [
  card("Calvin cycle", "Fixes carbon dioxide into three-carbon sugars in the stroma."),
  card("Stomata", "Pores on the leaf surface that allow gas exchange."),
  card("Rubisco & <friends>", "An enzyme.\nA second line with <b>markup</b>."),
  card("Fotosíntesis — 光合成", "Non-Latin text survives."),
];

/** Build a package and open its collection database. */
async function openApkg(input) {
  const bytes = await buildApkg({
    name: "Biology — Chapter 3", cards: CARDS, deckKey: "deck-1",
    source: "bio textbook.pdf", now: 1757000000000, ...input,
  });
  const zip = await JSZip.loadAsync(bytes);
  const dir = mkdtempSync(join(tmpdir(), "apkg-test-"));
  const path = join(dir, "collection.anki2");
  writeFileSync(path, await zip.file("collection.anki2").async("nodebuffer"));
  const db = new DatabaseSync(path, { readOnly: true });
  return { bytes, zip, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const FIELD_SEP = "\x1f";

console.log("the package is a zip holding a collection and a media manifest:");
const pkg = await openApkg();
check("collection.anki2 is present", pkg.zip.file("collection.anki2") !== null, true);
check("the media manifest is present", pkg.zip.file("media") !== null, true);
check("it is an empty manifest, since there is no media",
  await pkg.zip.file("media").async("string"), "{}");
check("nothing else is in the package",
  Object.keys(pkg.zip.files).sort(), ["collection.anki2", "media"]);
check("the collection is a real SQLite file", pkg.bytes.length > 0, true);

console.log("\nthe collection has the tables Anki expects:");
const tables = pkg.db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
check("col, notes, cards, revlog, graves",
  tables, ["cards", "col", "graves", "notes", "revlog"]);

console.log("\nthe col row declares the legacy schema every Anki still reads:");
const col = pkg.db.prepare("SELECT * FROM col").get();
check("one col row", pkg.db.prepare("SELECT count(*) n FROM col").get().n, 1);
check("schema version 11", col.ver, 11);
check("crt is in seconds, not milliseconds", col.crt, Math.floor(1757000000000 / 1000));
check("models is valid JSON", typeof JSON.parse(col.models), "object");
check("decks is valid JSON", typeof JSON.parse(col.decks), "object");
check("dconf is valid JSON", typeof JSON.parse(col.dconf), "object");
check("conf is valid JSON", typeof JSON.parse(col.conf), "object");
check("tags is valid JSON", JSON.parse(col.tags), {});

console.log("\nthe note type is well formed:");
const models = JSON.parse(col.models);
const model = Object.values(models)[0];
check("exactly one note type", Object.keys(models).length, 1);
check("keyed by its own id", Object.keys(models)[0], String(model.id));
check("a standard note type, not cloze", model.type, 0);
check("three fields", model.flds.map((f) => f.name), ["Term", "Definition", "Source"]);
check("fields are ordered 0,1,2", model.flds.map((f) => f.ord), [0, 1, 2]);
check("the sort field is the term", model.sortf, 0);
check("one card template", model.tmpls.length, 1);
check("the front asks the term", model.tmpls[0].qfmt.includes("{{Term}}"), true);
check("the back reveals the definition", model.tmpls[0].afmt.includes("{{Definition}}"), true);
check("the back includes the front", model.tmpls[0].afmt.includes("{{FrontSide}}"), true);
check("the source is conditional, so a blank one renders nothing",
  model.tmpls[0].afmt.includes("{{#Source}}"), true);
check("req is present, or Anki generates no cards", model.req, [[0, "any", [0]]]);
check("the template carries styling", model.css.includes(".card"), true);

console.log("\nthe deck is named and the default deck is left intact:");
const decks = JSON.parse(col.decks);
check("two decks: Default plus ours", Object.keys(decks).sort(), ["1", "1700000000001"]);
check("ours carries the deck name", decks["1700000000001"].name, "Biology — Chapter 3");
check("it is a normal deck, not filtered", decks["1700000000001"].dyn, 0);
check("the default deck survives", decks["1"].name, "Default");

console.log("\nevery card became a note:");
const notes = pkg.db.prepare("SELECT * FROM notes ORDER BY id").all();
check("one note per card", notes.length, CARDS.length);
check("fields are separated by the 0x1f control character",
  notes[0].flds.split(FIELD_SEP).length, 3);
check("the term is the first field", notes[0].flds.split(FIELD_SEP)[0], "Calvin cycle");
check("the definition is the second",
  notes[0].flds.split(FIELD_SEP)[1], "Fixes carbon dioxide into three-carbon sugars in the stroma.");
check("the source is the third", notes[0].flds.split(FIELD_SEP)[2], "bio textbook.pdf");
check("every note points at the note type",
  notes.every((n) => n.mid === model.id), true);
check("note ids are unique", new Set(notes.map((n) => n.id)).size, notes.length);
check("guids are unique", new Set(notes.map((n) => n.guid)).size, notes.length);
check("the sort field is the bare term, not HTML", notes[0].sfld, "Calvin cycle");
check("the checksum matches the sort field", notes[0].csum, fieldChecksum("Calvin cycle"));
check("notes are tagged so they can be found in Anki",
  notes[0].tags.includes("flashcard-anything"), true);
check("the source becomes a tag too", notes[0].tags.includes("bio-textbookpdf"), true);
check("tags are space-padded, the way Anki stores them",
  notes[0].tags.startsWith(" ") && notes[0].tags.endsWith(" "), true);

console.log("\nHTML in a card is escaped rather than rendered:");
const tricky = notes.find((n) => n.sfld.startsWith("Rubisco"));
check("ampersands and angle brackets are escaped in the term",
  tricky.flds.split(FIELD_SEP)[0], "Rubisco &amp; &lt;friends&gt;");
check("markup in a definition is escaped",
  tricky.flds.split(FIELD_SEP)[1].includes("&lt;b&gt;markup&lt;/b&gt;"), true);
check("a real newline becomes a line break",
  tricky.flds.split(FIELD_SEP)[1].includes("<br>"), true);
check("no raw < survives into a field", /<(?!br>)/.test(tricky.flds), false);
check("non-Latin text is untouched",
  notes.find((n) => n.sfld.includes("光合成")).flds.split(FIELD_SEP)[0], "Fotosíntesis — 光合成");

console.log("\nevery note has exactly one card, due as new:");
const cards = pkg.db.prepare("SELECT * FROM cards ORDER BY id").all();
check("one card per note", cards.length, notes.length);
check("each points at a real note",
  cards.every((c) => notes.some((n) => n.id === c.nid)), true);
check("all in our deck", new Set(cards.map((c) => c.did)), new Set([1700000000001]));
check("all use the single template", cards.every((c) => c.ord === 0), true);
check("all are new cards", cards.every((c) => c.type === 0 && c.queue === 0), true);
check("with no review history", cards.every((c) => c.reps === 0 && c.ivl === 0 && c.lapses === 0), true);
check("due positions are 1..n", cards.map((c) => c.due), [1, 2, 3, 4]);
check("card ids are unique", new Set(cards.map((c) => c.id)).size, cards.length);
check("card ids do not collide with note ids",
  cards.some((c) => notes.some((n) => n.id === c.id)), false);
pkg.cleanup();

console.log("\nguids are stable, so re-importing updates instead of duplicating:");
check("the same deck and term give the same guid",
  guidFor("deck-1", "Calvin cycle"), guidFor("deck-1", "Calvin cycle"));
check("a different term gives a different guid",
  guidFor("deck-1", "Calvin cycle") !== guidFor("deck-1", "Stomata"), true);
check("a different deck gives a different guid",
  guidFor("deck-1", "Calvin cycle") !== guidFor("deck-2", "Calvin cycle"), true);
check("a guid is non-empty text", typeof guidFor("d", "t") === "string" && guidFor("d", "t").length > 0, true);
check("guids avoid the quote and backslash that break Anki's search syntax",
  /["'\\\\]/.test(guidFor("deck-1", "Calvin cycle")), false);

const first = buildRows({ name: "D", cards: CARDS, deckKey: "k", now: 1 });
const later = buildRows({ name: "D", cards: CARDS, deckKey: "k", now: 999999 });
check("guids do not depend on when the export ran",
  first.notes.map((n) => n.guid), later.notes.map((n) => n.guid));
const edited = buildRows({
  name: "D", deckKey: "k", now: 1,
  cards: [card("Calvin cycle", "A completely rewritten definition."), ...CARDS.slice(1)],
});
check("editing a definition keeps the note's guid, so Anki updates it",
  edited.notes[0].guid, first.notes[0].guid);

console.log("\nescaping and tagging helpers:");
check("plain text is untouched", toAnkiHtml("Plain text."), "Plain text.");
check("ampersand first, so escapes are not double-escaped",
  toAnkiHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
check("CRLF becomes one break", toAnkiHtml("a\r\nb"), "a<br>b");
check("a tag is a single token", toAnkiTag("bio textbook.pdf"), "bio-textbookpdf");
check("accents are folded", toAnkiTag("Biología"), "Biologia");
check("a tag that reduces to nothing gets a fallback", toAnkiTag("—— 🧬"), "flashcard-anything");

console.log("\nfile naming:");
check("a deck name becomes an .apkg name",
  ankiFileName("Biology — Chapter 3"), "Biology-Chapter-3.apkg");
check("and the JSON export still shares the slug", deckSlug("Biology — Chapter 3"), "Biology-Chapter-3");
check("an unusable name still yields a file", ankiFileName("🧬"), "flashcards.apkg");

console.log("\nedge cases:");
const single = await openApkg({ cards: [card("Only", "One card.")], source: null });
check("a one-card deck builds", single.db.prepare("SELECT count(*) n FROM notes").get().n, 1);
check("no source means an empty third field",
  single.db.prepare("SELECT flds FROM notes").get().flds.split(FIELD_SEP)[2], "");
check("and only the tool tag",
  single.db.prepare("SELECT tags FROM notes").get().tags.trim(), "flashcard-anything");
single.cleanup();

const named = await openApkg({ name: "  " });
check("a blank deck name falls back rather than producing an unnamed deck",
  JSON.parse(named.db.prepare("SELECT decks FROM col").get().decks)["1700000000001"].name,
  "Flashcard Anything");
named.cleanup();

const nested = await openApkg({ name: `Bio\x1fSub` });
check("a field separator in the name cannot smuggle in a subdeck",
  JSON.parse(nested.db.prepare("SELECT decks FROM col").get().decks)["1700000000001"].name,
  "Bio Sub");
nested.cleanup();

let threw = null;
try { await buildApkg({ name: "Empty", cards: [], deckKey: "k" }); }
catch (e) { threw = e.message; }
check("an empty deck is refused rather than producing a broken file",
  threw, "There are no cards to export.");

console.log("\na large deck round-trips:");
const big = await openApkg({
  cards: Array.from({ length: 500 }, (_, i) => card(`Term ${i}`, `Definition number ${i}.`)),
});
check("500 notes", big.db.prepare("SELECT count(*) n FROM notes").get().n, 500);
check("500 cards", big.db.prepare("SELECT count(*) n FROM cards").get().n, 500);
check("ids stay unique at scale",
  big.db.prepare("SELECT count(DISTINCT id) d, count(*) n FROM notes").get(), { d: 500, n: 500 });
check("guids stay unique at scale",
  big.db.prepare("SELECT count(DISTINCT guid) d FROM notes").get().d, 500);
big.cleanup();

console.log(failures === 0 ? "\nall Anki checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
