#!/usr/bin/env node --experimental-strip-types
/**
 * Proves the .apkg really imports, using Anki itself as the oracle.
 *
 * The unit tests in anki.test.mjs check the file against Anki's documented
 * invariants, which is not the same as Anki accepting it. This builds two
 * versions of a deck and drives a real Anki collection through importing both.
 *
 * Needs the Anki Python library, which is far too heavy to make a dependency of
 * this repo:
 *
 *     python3 -m venv /tmp/ankienv && /tmp/ankienv/bin/pip install anki
 *     ANKI_PYTHON=/tmp/ankienv/bin/python npm run test:anki
 *
 * Skips (exit 0) when no such interpreter is available, so it can sit in CI
 * without turning red on machines that don't have it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApkg } from "../lib/anki.ts";

const python = process.env.ANKI_PYTHON ?? "python3";
const probe = spawnSync(
  python,
  ["-c", "import anki.buildinfo, anki.collection; print(anki.buildinfo.version)"],
  { encoding: "utf8" }
);
if (probe.status !== 0) {
  console.log(`SKIP: no Anki library at "${python}". See the comment at the top of this file.`);
  process.exit(0);
}
console.log(`checking against real Anki ${probe.stdout.trim()}\n`);

const card = (term, definition) => ({ term, definition, evidence: `evidence for ${term}` });
const V1 = [
  card("Calvin cycle", "Fixes carbon dioxide into three-carbon sugars in the stroma."),
  card("Stomata", "Pores on the leaf surface that allow gas exchange."),
  card("Rubisco & <friends>", "An enzyme.\nA second line with <b>markup</b>."),
  card("Fotosíntesis — 光合成", "Non-Latin text survives."),
];
// The same deck after a card was rewritten and another added.
const V2 = [
  card("Calvin cycle", "REWRITTEN: uses ATP and NADPH to fix carbon dioxide."),
  ...V1.slice(1),
  card("Thylakoid", "Membrane where the light-dependent reactions happen."),
];

const dir = mkdtempSync(join(tmpdir(), "anki-check-"));
const v1 = join(dir, "v1.apkg");
const v2 = join(dir, "v2.apkg");
const opts = { name: "Biology — Chapter 3", deckKey: "deck-1", source: "bio textbook.pdf" };
writeFileSync(v1, await buildApkg({ ...opts, cards: V1, now: 1757000000000 }));
writeFileSync(v2, await buildApkg({ ...opts, cards: V2, now: 1757000500000 }));

const SCRIPT = `
import sys, tempfile, shutil, os, json
from anki.collection import Collection
from anki.import_export_pb2 import ImportAnkiPackageRequest

v1, v2 = sys.argv[1], sys.argv[2]
work = tempfile.mkdtemp()
col = Collection(os.path.join(work, "collection.anki2"))
out = {}
try:
    col.import_anki_package(ImportAnkiPackageRequest(package_path=v1))
    out["notes_after_v1"] = len(col.find_notes(""))
    out["cards_after_v1"] = len(col.find_cards(""))
    out["deck_names"] = sorted(d.name for d in col.decks.all_names_and_ids())

    nid = col.find_notes('"Calvin cycle"')[0]
    note = col.get_note(nid)
    out["fields"] = note.fields
    out["tags"] = sorted(note.tags)

    cid = col.find_cards('"Calvin cycle"')[0]
    c = col.get_card(cid)
    out["is_new_card"] = (c.type == 0 and c.queue == 0)
    out["question_has_term"] = "Calvin cycle" in c.question()
    out["answer_has_definition"] = "three-carbon sugars" in c.answer()
    out["answer_has_source"] = "bio textbook.pdf" in c.answer()

    esc = col.get_note(col.find_notes("Rubisco")[0])
    # Rendered HTML must carry the entities, not a live tag: that is what makes
    # "<b>markup</b>" show up as text on the card instead of turning it bold.
    rendered = col.get_card(col.find_cards("Rubisco")[0]).answer()
    out["markup_is_escaped_in_render"] = "&lt;b&gt;markup&lt;/b&gt;" in rendered
    out["markup_is_not_live_html"] = "<b>markup</b>" not in rendered
    out["newline_renders_as_break"] = "<br>" in esc.fields[1]
    out["unicode_intact"] = len(col.find_notes("光合成")) == 1

    # Study the card, then re-import: history must survive and nothing duplicate.
    c.type, c.queue, c.ivl, c.factor, c.reps = 2, 2, 21, 2500, 4
    col.update_card(c)

    col.import_anki_package(ImportAnkiPackageRequest(package_path=v1))
    out["notes_after_reimport"] = len(col.find_notes(""))

    col.import_anki_package(ImportAnkiPackageRequest(package_path=v2))
    out["notes_after_v2"] = len(col.find_notes(""))
    out["rewritten"] = col.get_note(col.find_notes('"Calvin cycle"')[0]).fields[1]
    out["new_card_added"] = len(col.find_notes("Thylakoid")) == 1
    kept = col.get_card(col.find_cards('"Calvin cycle"')[0])
    out["study_history"] = {"ivl": kept.ivl, "reps": kept.reps, "type": kept.type}
    out["problems"] = col.fix_integrity()[0].count("\\n") if hasattr(col, "fix_integrity") else 0
finally:
    col.close(); shutil.rmtree(work, ignore_errors=True)
print(json.dumps(out))
`;
const scriptPath = join(dir, "check.py");
writeFileSync(scriptPath, SCRIPT);

const run = spawnSync(python, [scriptPath, v1, v2], { encoding: "utf8" });
rmSync(dir, { recursive: true, force: true });
if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  console.log("\nFAILED: Anki could not process the package.");
  process.exit(1);
}

const r = JSON.parse(run.stdout.trim().split("\n").pop());
let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

console.log("Anki imports the package:");
check("four notes", r.notes_after_v1, 4);
check("four cards", r.cards_after_v1, 4);
check("the deck arrives under its own name",
  r.deck_names.includes("Biology — Chapter 3"), true);
check("the default deck is untouched", r.deck_names.includes("Default"), true);

console.log("\nthe note is what we wrote:");
check("three fields", r.fields.length, 3);
check("term", r.fields[0], "Calvin cycle");
check("definition", r.fields[1], "Fixes carbon dioxide into three-carbon sugars in the stroma.");
check("source", r.fields[2], "bio textbook.pdf");
check("tagged for searching", r.tags, ["bio-textbookpdf", "flashcard-anything"]);

console.log("\nAnki renders the card correctly:");
check("the front asks the term", r.question_has_term, true);
check("the back gives the definition", r.answer_has_definition, true);
check("the back cites the source", r.answer_has_source, true);
check("it arrives as an unstudied card", r.is_new_card, true);
check("markup in a definition renders as visible text", r.markup_is_escaped_in_render, true);
check("and is never live HTML on the card", r.markup_is_not_live_html, true);
check("a newline renders as a line break", r.newline_renders_as_break, true);
check("non-Latin text survived the round trip", r.unicode_intact, true);

console.log("\nre-importing updates rather than duplicating:");
check("importing the same file twice adds nothing", r.notes_after_reimport, 4);
check("an edited export adds only the new card", r.notes_after_v2, 5);
check("the rewritten definition replaced the old one",
  r.rewritten, "REWRITTEN: uses ATP and NADPH to fix carbon dioxide.");
check("the added card is there", r.new_card_added, true);
check("study history is preserved across the update",
  r.study_history, { ivl: 21, reps: 4, type: 2 });

console.log("\nthe collection is left healthy:");
check("Anki's integrity check finds nothing to repair", r.problems, 0);

console.log(failures === 0 ? "\nreal Anki accepted the package" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
