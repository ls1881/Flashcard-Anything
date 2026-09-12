import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import type { Card } from "./duplex";

/**
 * Anki `.apkg` export.
 *
 * An .apkg is a zip holding `collection.anki2` — a SQLite database in Anki's
 * own schema — plus a `media` manifest. A CSV would have been less work, but it
 * makes the reader do the import mapping by hand and carries no deck name, no
 * note type, and no card styling. This produces a file you double-click.
 *
 * Schema 11 (`col.ver = 11`) is deliberate: it is the legacy format every Anki
 * from 2.1 onward still reads, where the newer `.anki21b` variant is understood
 * only by recent versions. An export is for getting a deck *out*, so it should
 * open in whatever the reader happens to be running.
 */

/** Anki separates a note's fields with this control character. */
const FIELD_SEP = "\x1f";

/** Fixed ids: one note type and one deck per file, so collisions can't arise. */
const MODEL_ID = 1700000000000;
const DECK_ID = 1700000000001;

const CSS = `.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 20px;
  text-align: center;
  color: #16161a;
  background-color: #ffffff;
  padding: 20px;
}
.term { font-weight: 600; }
.definition { font-size: 18px; line-height: 1.5; }
.source { margin-top: 14px; font-size: 13px; color: #6b6b76; font-style: italic; }`;

const FRONT_TEMPLATE = `<div class="term">{{Term}}</div>`;
const BACK_TEMPLATE = `{{FrontSide}}

<hr id=answer>

<div class="definition">{{Definition}}</div>
{{#Source}}<div class="source">{{Source}}</div>{{/Source}}`;

/**
 * Anki's own guid alphabet. The value only has to be unique and stable; what
 * matters is that it *is* stable, because Anki matches notes by guid on import.
 * A deck re-exported after edits therefore updates the notes already in the
 * user's collection instead of adding a second copy of everything.
 */
const BASE91 = (
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" +
  "!#$%&()*+,-./:;<=>?@[]^_`{|}~"
).split("");

function base91(num: bigint): string {
  let n = num;
  let out = "";
  const base = BigInt(BASE91.length);
  while (n > 0n) {
    out = BASE91[Number(n % base)] + out;
    n /= base;
  }
  return out || BASE91[0];
}

/**
 * Stable per (deck, term): re-exporting an edited deck updates the note rather
 * than duplicating it. Anki's own guids are random, but random is exactly wrong
 * for a deck that gets regenerated and exported again.
 */
export function guidFor(deckKey: string, term: string): string {
  const digest = createHash("sha1").update(`${deckKey}\u0000${term}`).digest("hex");
  return base91(BigInt(`0x${digest.slice(0, 16)}`));
}

/**
 * Anki stores a checksum of the sort field to find duplicates quickly: the
 * first 8 hex digits of the SHA-1 of the stripped first field, as an integer.
 */
export function fieldChecksum(text: string): number {
  return parseInt(createHash("sha1").update(text).digest("hex").slice(0, 8), 16);
}

/**
 * Fields are HTML in Anki, so anything that looks like markup in a definition
 * would render as markup — or vanish. Escape it, and keep real line breaks by
 * turning them into <br>.
 */
export function toAnkiHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>");
}

/** Anki treats spaces as tag separators, so each tag has to be one token. */
export function toAnkiTag(text: string): string {
  const tag = text
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return tag || "flashcard-anything";
}

const SCHEMA = `
CREATE TABLE col (
  id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null,
  usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null
);
CREATE TABLE notes (
  id integer primary key, guid text not null, mid integer not null,
  mod integer not null, usn integer not null, tags text not null,
  flds text not null, sfld integer not null, csum integer not null,
  flags integer not null, data text not null
);
CREATE TABLE cards (
  id integer primary key, nid integer not null, did integer not null,
  ord integer not null, mod integer not null, usn integer not null,
  type integer not null, queue integer not null, due integer not null,
  ivl integer not null, factor integer not null, reps integer not null,
  lapses integer not null, left integer not null, odue integer not null,
  odid integer not null, flags integer not null, data text not null
);
CREATE TABLE revlog (
  id integer primary key, cid integer not null, usn integer not null,
  ease integer not null, ivl integer not null, lastIvl integer not null,
  factor integer not null, time integer not null, type integer not null
);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_notes_csum ON notes (csum);
`;

function modelsJson(name: string, mod: number): string {
  return JSON.stringify({
    [String(MODEL_ID)]: {
      id: MODEL_ID,
      name: `${name} — Flashcard Anything`,
      type: 0,
      mod,
      usn: -1,
      sortf: 0,
      did: DECK_ID,
      tmpls: [
        {
          name: "Card 1",
          ord: 0,
          qfmt: FRONT_TEMPLATE,
          afmt: BACK_TEMPLATE,
          bqfmt: "",
          bafmt: "",
          did: null,
          bfont: "",
          bsize: 0,
        },
      ],
      flds: [
        { name: "Term", ord: 0, sticky: false, rtl: false, font: "Arial", size: 20, media: [] },
        { name: "Definition", ord: 1, sticky: false, rtl: false, font: "Arial", size: 20, media: [] },
        { name: "Source", ord: 2, sticky: false, rtl: false, font: "Arial", size: 14, media: [] },
      ],
      css: CSS,
      latexPre:
        "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n" +
        "\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n" +
        "\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
      latexPost: "\\end{document}",
      latexsvg: false,
      // Which fields must be non-empty for the card to be generated. Anki
      // refuses to build cards for a note type without this.
      req: [[0, "any", [0]]],
      tags: [],
      vers: [],
    },
  });
}

function decksJson(name: string, mod: number): string {
  return JSON.stringify({
    "1": {
      id: 1, name: "Default", mod, usn: -1, lrnToday: [0, 0], revToday: [0, 0],
      newToday: [0, 0], timeToday: [0, 0], collapsed: true, browserCollapsed: true,
      desc: "", dyn: 0, conf: 1, extendNew: 0, extendRev: 0,
    },
    [String(DECK_ID)]: {
      id: DECK_ID, name, mod, usn: -1, lrnToday: [0, 0], revToday: [0, 0],
      newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: false,
      desc: "Made with Flashcard Anything.", dyn: 0, conf: 1, extendNew: 0, extendRev: 0,
    },
  });
}

const DCONF_JSON = JSON.stringify({
  "1": {
    id: 1, name: "Default", mod: 0, usn: 0, maxTaken: 60, autoplay: true,
    timer: 0, replayq: true, dyn: false,
    new: { bury: false, delays: [1.0, 10.0], initialFactor: 2500, ints: [1, 4, 0],
           order: 1, perDay: 20 },
    rev: { bury: false, ease4: 1.3, ivlFct: 1.0, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
    lapse: { delays: [10.0], leechAction: 1, leechFails: 8, minInt: 1, mult: 0.0 },
  },
});

const CONF_JSON = JSON.stringify({
  activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0,
  estTimes: true, dueCounts: true, curModel: String(MODEL_ID), nextPos: 1,
  sortType: "noteFld", sortBackwards: false, addToCur: true, dayLearnFirst: false,
  schedVer: 2,
});

export type AnkiDeckInput = {
  /** Becomes the deck name in Anki. */
  name: string;
  cards: Card[];
  /** Stable key so a re-export updates notes rather than duplicating them. */
  deckKey: string;
  /** Shown on the back of each card, and added as a tag. */
  source?: string | null;
  now?: number;
};

/** The rows an .apkg contains, built before anything touches SQLite. */
export function buildRows(input: AnkiDeckInput) {
  const now = input.now ?? Date.now();
  const seconds = Math.floor(now / 1000);
  const sourceText = (input.source ?? "").trim();
  const tags = ` flashcard-anything${sourceText ? ` ${toAnkiTag(sourceText)}` : ""} `;

  const notes = input.cards.map((card, i) => {
    const term = card.term.trim();
    const fields = [
      toAnkiHtml(term),
      toAnkiHtml(card.definition.trim()),
      sourceText ? toAnkiHtml(sourceText) : "",
    ];
    return {
      // Unique and stable within the file; Anki rewrites ids on import anyway.
      id: now + i,
      guid: guidFor(input.deckKey, term),
      mid: MODEL_ID,
      mod: seconds,
      usn: -1,
      tags,
      flds: fields.join(FIELD_SEP),
      // The sort field is stored unescaped and is what Anki shows in the browser.
      sfld: term,
      csum: fieldChecksum(term),
      flags: 0,
      data: "",
    };
  });

  const cards = notes.map((note, i) => ({
    id: now + 1_000_000 + i,
    nid: note.id,
    did: DECK_ID,
    ord: 0,
    mod: seconds,
    usn: -1,
    // A brand new card, never studied: the importer's scheduler takes it from here.
    type: 0,
    queue: 0,
    due: i + 1,
    ivl: 0,
    factor: 0,
    reps: 0,
    lapses: 0,
    left: 0,
    odue: 0,
    odid: 0,
    flags: 0,
    data: "",
  }));

  return { notes, cards, now, seconds };
}

/** Build the .apkg. Returns the zip bytes, ready to download. */
export async function buildApkg(input: AnkiDeckInput): Promise<Uint8Array> {
  if (!input.cards.length) throw new Error("There are no cards to export.");

  const { notes, cards, now, seconds } = buildRows(input);
  const dir = mkdtempSync(join(tmpdir(), "apkg-"));
  const dbPath = join(dir, "collection.anki2");

  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(SCHEMA);

      const deckName = input.name.trim() || "Flashcard Anything";
      db.prepare(
        `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
         VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)`
      ).run(
        seconds,
        now,
        now,
        CONF_JSON,
        modelsJson(deckName, seconds),
        // Anki's deck tree uses \x1f for nesting; a literal one in the name
        // would silently create a subdeck.
        decksJson(deckName.replace(/\x1f/g, " "), seconds),
        DCONF_JSON,
        JSON.stringify({})
      );

      const insertNote = db.prepare(
        `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const n of notes) {
        insertNote.run(n.id, n.guid, n.mid, n.mod, n.usn, n.tags, n.flds, n.sfld, n.csum, n.flags, n.data);
      }

      const insertCard = db.prepare(
        `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor,
                            reps, lapses, left, odue, odid, flags, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const c of cards) {
        insertCard.run(c.id, c.nid, c.did, c.ord, c.mod, c.usn, c.type, c.queue, c.due,
          c.ivl, c.factor, c.reps, c.lapses, c.left, c.odue, c.odid, c.flags, c.data);
      }
    } finally {
      db.close();
    }

    const zip = new JSZip();
    zip.file("collection.anki2", readFileSync(dbPath));
    // No media, but the manifest has to be there or the import is rejected.
    zip.file("media", "{}");
    return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
