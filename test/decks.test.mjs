#!/usr/bin/env node --experimental-strip-types
// Run: npm test
// fake-indexeddb installs the globals lib/decks.ts reaches for; it must be
// imported before the module under test.
import "fake-indexeddb/auto";
import {
  deckName, formatWhen, normalizeDeck, summarize, sortDecks, newDeck, exportFileName,
  available, listDecks, getDeck, putDeck, renameDeck, deleteDeck, closeDb,
} from "../lib/decks.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const card = (t) => ({ term: t, definition: `def:${t}`, evidence: `src:${t}` });
const deckOf = (...terms) =>
  newDeck({ cards: terms.map(card), source: "notes.pdf", scope: null, model: null });

// A fresh database per run, so yesterday's rows can't prop up today's pass.
async function wipe() {
  closeDb();
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase("flashcard-anything");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

console.log("the store is reachable:");
check("available() sees IndexedDB", available(), true);

console.log("\ndeck names are recognizable a week later:");
check("a file loses its extension",
  deckName("Biology Chapter 3.pdf", null), "Biology Chapter 3");
check("a scope narrows the file",
  deckName("textbook.pdf", "chapter 3, section 2"), "textbook — chapter 3, section 2");
check("scope alone stands in", deckName(null, "chapter 3"), "chapter 3");
check("pasted text falls back to the day",
  deckName("pasted text", null, new Date(2026, 8, 9)), "Pasted text — Sep 9");
check("nothing at all still yields a name",
  deckName(null, null, new Date(2026, 0, 1)), "Pasted text — Jan 1");
check("blank scope is not treated as a scope",
  deckName("notes.pdf", "   "), "notes");
check("a dotted filename keeps all but the last segment",
  deckName("bio.chapter.3.pdf", null), "bio.chapter.3");

console.log("\nexport filenames survive whatever the deck is called:");
check("spaces become hyphens",
  exportFileName("Biology Chapter 3"), "Biology-Chapter-3.flashcards.json");
check("accents and quotes are stripped",
  exportFileName("Biología — «Capítulo 3»"), "Biologia-Capitulo-3.flashcards.json");
check("an emoji-only name still yields a file",
  exportFileName("🧬🧪"), "flashcards.flashcards.json");
check("a blank name still yields a file", exportFileName("   "), "flashcards.flashcards.json");
check("slashes cannot escape into a path",
  exportFileName("bio/chem: notes"), "biochem-notes.flashcards.json");
check("leading and trailing dots are trimmed",
  exportFileName("...notes..."), "notes.flashcards.json");
check("a very long name is truncated",
  exportFileName("x".repeat(200)).length, 80 + ".flashcards.json".length);

console.log("\ntimestamps read the way a person would say them:");
const t0 = Date.parse("2026-09-09T12:00:00Z");
const ago = (ms) => formatWhen(t0 - ms, t0);
check("seconds", ago(5_000), "just now");
check("a minute", ago(60_000), "1 minute ago");
check("minutes", ago(45 * 60_000), "45 minutes ago");
check("59 minutes does not round up to an hour", ago(59 * 60_000 + 59_000), "59 minutes ago");
check("an hour", ago(60 * 60_000), "1 hour ago");
check("hours", ago(5 * 60 * 60_000), "5 hours ago");
check("23 hours does not round up to a day", ago(23.9 * 60 * 60_000), "23 hours ago");
check("yesterday", ago(25 * 60 * 60_000), "yesterday");
check("days", ago(6 * 24 * 60 * 60_000), "6 days ago");
check("a month falls back to a date", ago(60 * 24 * 60 * 60_000), "Jul 11");
check("a clock skewed into the future says just now", formatWhen(t0 + 10_000, t0), "just now");

console.log("\nrows read back from disk are not trusted:");
check("a row with no id is dropped", normalizeDeck({ name: "x" }), null);
check("a non-object is dropped", normalizeDeck("nope"), null);
check("null is dropped", normalizeDeck(null), null);
check("a deck with no cards array survives with none",
  normalizeDeck({ id: "a" }).cards.length, 0);
check("a nameless deck gets a name", normalizeDeck({ id: "a" }).name, "Untitled deck");
check("a blank name gets a name", normalizeDeck({ id: "a", name: "  " }).name, "Untitled deck");
check("malformed cards are filtered out",
  normalizeDeck({ id: "a", cards: [card("A"), { term: "B" }, null, "C"] }).cards.length, 1);
check("a stale count is recomputed from the cards",
  normalizeDeck({ id: "a", cards: [card("A"), card("B")], count: 99 }).count, 2);
check("a malformed model becomes null",
  normalizeDeck({ id: "a", model: { provider: "ollama" } }).model, null);
check("a good model is kept",
  normalizeDeck({ id: "a", model: { provider: "ollama", name: "llama3" } }).model.name, "llama3");
check("a missing updatedAt falls back to createdAt",
  normalizeDeck({ id: "a", createdAt: 7 }).updatedAt, 7);

console.log("\nsummaries and ordering:");
check("a summary carries no cards", "cards" in summarize(deckOf("A", "B")), false);
check("a summary keeps the count", summarize(deckOf("A", "B")).count, 2);
const ordered = sortDecks([
  { id: "b", updatedAt: 100 }, { id: "c", updatedAt: 300 }, { id: "a", updatedAt: 200 },
]);
check("newest first", ordered.map((d) => d.id).join(""), "cab");
check("ties break by id, so the list never flickers",
  sortDecks([{ id: "z", updatedAt: 1 }, { id: "a", updatedAt: 1 }]).map((d) => d.id).join(""), "az");
check("the input array is not mutated",
  (() => { const input = [{ id: "b", updatedAt: 1 }, { id: "a", updatedAt: 2 }];
           sortDecks(input); return input[0].id; })(), "b");

console.log("\na deck survives a reload:");
await wipe();
const saved = await putDeck(deckOf("mitosis", "meiosis", "prophase"));
// Drop the connection the way closing the tab does, then come back cold.
closeDb();
const reloaded = await getDeck(saved.id);
check("it is still there after the connection is dropped", reloaded !== null, true);
check("every card came back", reloaded.cards.length, 3);
check("terms are intact", reloaded.cards.map((c) => c.term).join(","), "mitosis,meiosis,prophase");
check("definitions are intact", reloaded.cards[0].definition, "def:mitosis");
check("evidence is intact", reloaded.cards[0].evidence, "src:mitosis");
check("the name came back", reloaded.name, "notes");

console.log("\nthe deck list:");
await wipe();
const first = await putDeck(newDeck({
  cards: [card("A")], source: "old.pdf", scope: null, model: null, now: 1_000 }));
const second = await putDeck(newDeck({
  cards: [card("B"), card("C")], source: "new.pdf", scope: null, model: null, now: 2_000 }));
const list = await listDecks();
check("both decks are listed", list.length, 2);
check("newest first", list[0].id === second.id, true);
check("the list carries counts", list[0].count, 2);
check("the list does not carry cards", "cards" in list[0], false);
check("names are listed", list.map((d) => d.name).sort().join(","), "new,old");

console.log("\nrename:");
const renamed = await renameDeck(first.id, "  Cell Division  ", 9_000);
check("the name is trimmed", renamed.name, "Cell Division");
check("updatedAt moves", renamed.updatedAt, 9_000);
closeDb();
check("the new name survives a reload", (await getDeck(first.id)).name, "Cell Division");
check("renaming moves it to the top of the list", (await listDecks())[0].id === first.id, true);
check("cards are untouched by a rename", (await getDeck(first.id)).cards.length, 1);
check("a blank name is refused", (await renameDeck(first.id, "   ")).name, "Cell Division");
check("a whitespace-only rename does not bump updatedAt",
  (await getDeck(first.id)).updatedAt, 9_000);
check("renaming an unknown deck returns null", await renameDeck("nope", "x"), null);

console.log("\ndelete:");
await deleteDeck(first.id);
check("it is gone", await getDeck(first.id), null);
check("the list shrinks", (await listDecks()).length, 1);
check("the other deck is untouched", (await getDeck(second.id)).cards.length, 2);
check("deleting again is not an error",
  await deleteDeck(first.id).then(() => "ok", (e) => String(e)), "ok");

console.log("\na deck past the localStorage budget round-trips:");
await wipe();
const big = newDeck({
  cards: Array.from({ length: 6000 }, (_, i) => ({
    term: `term ${i}`,
    definition: `A definition long enough to be realistic prose. `.repeat(12) + i,
    evidence: `Verbatim evidence from the source document. `.repeat(8) + i,
  })),
  source: "textbook.pdf", scope: "chapter 3", model: { provider: "ollama", name: "llama3" },
});
const bytes = JSON.stringify(big).length;
await putDeck(big);
closeDb();
const backAgain = await getDeck(big.id);
check(`${Math.round(bytes / 1024 / 1024)}MB deck came back whole`, backAgain.cards.length, 6000);
check("it is past the ~5MB localStorage would have refused", bytes > 5_000_000, true);
check("the last card is intact", backAgain.cards[5999].term, "term 5999");
check("the model came back", backAgain.model.name, "llama3");
check("the scope came back", backAgain.scope, "chapter 3");

console.log("\nnames with punctuation and non-Latin text survive:");
const odd = await putDeck({ ...deckOf("A"), name: "Biología — «Capítulo 3» 🧬 / 日本語" });
closeDb();
check("stored verbatim", (await getDeck(odd.id)).name, "Biología — «Capítulo 3» 🧬 / 日本語");

console.log("\na corrupt row does not take the list down with it:");
await wipe();
const good = await putDeck(deckOf("A"));
await new Promise((resolve, reject) => {
  const req = indexedDB.open("flashcard-anything");
  req.onsuccess = () => {
    const d = req.result;
    const tx = d.transaction("decks", "readwrite");
    // A row that predates a field, and one that is barely a deck at all.
    tx.objectStore("decks").put({ id: "legacy", cards: [card("Z")] });
    tx.objectStore("decks").put({ id: "junk", cards: "not an array" });
    tx.oncomplete = () => { d.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
});
closeDb();
const mixed = await listDecks();
check("the good deck is still listed", mixed.some((d) => d.id === good.id), true);
check("the legacy row is repaired, not dropped", mixed.some((d) => d.id === "legacy"), true);
check("the legacy row keeps its card", mixed.find((d) => d.id === "legacy").count, 1);
check("the junk row is listed with no cards rather than crashing",
  mixed.find((d) => d.id === "junk").count, 0);
check("every listed deck has a usable name",
  mixed.every((d) => typeof d.name === "string" && d.name.length > 0), true);

console.log("\nputting the same deck twice updates rather than duplicates:");
await wipe();
const once = await putDeck(deckOf("A"));
await putDeck({ ...once, cards: [card("A"), card("B")] });
const after = await listDecks();
check("still one deck", after.length, 1);
check("the count follows the cards", after[0].count, 2);

console.log(failures === 0 ? "\nall deck checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
