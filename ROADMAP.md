# Roadmap

What's planned and why. For what already exists and the decisions behind it, see
[PLAN.md](PLAN.md); for the pipeline measurements, [bench/README.md](bench/README.md).

Nothing here is scheduled. Items are ordered by value, and the reasoning is written down so
a later reader can disagree with it.

## The gap worth naming

The app is strongest at *generation* and weakest at *everything after generation*. That gap
is now closed: decks survive a reload, arrive while the run is still going, can be corrected
a card at a time, and leave as an Anki package that imports into the app people actually
study in. What's left below is breadth — more input formats and better card shapes — rather
than the hole that was here.

## Next

Ordered. Each one is worth doing on its own.

### ~~1. Persistence — decks survive a reload~~ — built

~~Today a deck lives in React state. A refresh after a ten-minute textbook run loses
everything.~~ Decks are stored in IndexedDB: a finished run saves itself, a reload reopens
the deck you were on, and the landing page lists what you have with rename and delete. No
server and no setup, as argued. SQLite still doesn't earn its complexity until decks need
to sync across devices. See [PLAN.md](PLAN.md) for the shape on disk.

### ~~2. Stream cards as they're written~~ — built

~~Generation already produces cards chunk by chunk, but the page shows nothing until the
whole run finishes.~~ Each section's cards are now sent down the existing NDJSON stream as
they land and appear in the same grid the finished deck uses. Measured on a three-section
run against a local `qwen3:8b`: first cards on screen at 26s, run finished at 44s — 18
seconds of reading that used to be a blank spinner. The model was never touched.

A run that dies partway now keeps the sections that did finish, rather than discarding the
lot.

### ~~3. Edit a card, or regenerate one~~ — built

~~When 18 of 20 cards are right, the only recourse is rerunning everything.~~ Every card
now has **Edit** and **Rewrite**. Edit is inline — term and definition, saved to the deck.
Rewrite is one model call against the slice of the source that card came from: measured at
6.4s against a local `qwen3:8b`, where regenerating the deck was minutes.

Decks now keep the text they were written from, which is what makes a rewrite possible
after a reload — the upload itself is long gone. Decks made before that keep working and
say why they can't rewrite.

### ~~4. Anki export~~ — built

~~Anki already has the scheduler, the mobile apps, and sync.~~ **Export Anki** writes a real
`.apkg`: a SQLite collection in Anki's schema 11, zipped with its media manifest. Not a CSV
— the reader double-clicks the file and gets a named deck, a proper note type, and styled
cards, with no import mapping to do.

Note guids are derived from the deck and the term rather than randomly, which is what makes
it *re-*importable: fix a card here, export again, and Anki updates the note in place
**keeping your review history** instead of adding a duplicate.

Verified against the real Anki library rather than against the docs — `npm run test:anki`
drives an actual collection through importing the file twice. See "Not planned" below; this
is the export that makes not building a scheduler the right call.

### 5. A4 and card-size options

The print layout is hardcoded to US Letter at six cards per sheet, which makes the feature
unusable outside North America. A4 is close to a one-constant change; index-card and
business-card sizes are a small extension of the same grid.

## Input coverage

| Item | Why |
| --- | --- |
| OCR for scanned PDFs | Currently a hard refusal, and photocopied readers are exactly what students have. `tesseract.js` runs locally, which fits the no-cloud default. |
| YouTube transcripts | Recorded lectures are a major study input and transcripts are cheap to fetch. |
| Multiple files into one deck | "Everything for this exam" is the natural unit, not one file. |
| URL input | Paste a course page or article; scrape to text and reuse the existing path. |
| Audio to transcript | `whisper.cpp` locally, for lectures recorded on a phone. |

## Card quality

- **Cloze deletion** — "Glycolysis produces a net gain of ___ ATP" is often a better format
  than term/definition, particularly for numbers and process steps.
- **Question-style cards** where material isn't definitional.
- **Difficulty setting** — introductory recall against exam-level application.
- **Jump to source** — click a card and see the page or section it came from. Cards already
  carry an `evidence` span and the outline already carries page offsets, so this is mostly
  wiring.

## Performance

- **Cache by content hash** so regenerating an unchanged file is instant.
- **Parallel chunks on cloud providers.** Ollama serializes requests per model — measured
  while benchmarking the ensemble pipeline — but hosted providers do not, so a cloud run
  could be several times faster.
- **Resume an interrupted generation** rather than starting over.

## Not planned

Recorded so the question doesn't get reopened without new information.

- **A full spaced-repetition system.** Anki has years of scheduling research behind it and
  apps on every platform. Exporting to it is better for the user than reimplementing it.
- **Auth and multi-user.** Drags in a database, sessions, and hosting for no demand yet.
- **A whole-deck curator pass.** Considered during the pipeline benchmark and skipped:
  deterministic dedupe plus section-by-section writing already cover most of what it would
  do, and every extra pass is real wall-clock time on a local model.
