# Roadmap

What's planned and why. For what already exists and the decisions behind it, see
[PLAN.md](PLAN.md); for the pipeline measurements, [bench/README.md](bench/README.md).

Nothing here is scheduled. Items are ordered by value, and the reasoning is written down so
a later reader can disagree with it.

## The gap worth naming

The app was strongest at *generation* and weakest at *everything after generation*. That gap
is closed: decks survive a reload, arrive while the run is still going, can be corrected a
card at a time, and leave as an Anki package that imports into the app people actually study
in. The breadth that was listed under it — scans, recordings, links, several files at once,
cloze and question cards, caching — is built too.

What is left is not a hole so much as a list of things nobody has asked for yet. The one
thing genuinely missing is sync, and that needs auth, which needs a reason.

## Next

Everything originally listed here is built. What follows is what has been thought of since.

### More paper and card sizes

The mechanism is now general — a paper is a width and a height, a card size is a width and a
height, and everything else is computed — so A5, Legal, A6 index cards and the EU 85 × 55mm
business card are entries in a table rather than new code. Left until someone wants one.

### Sync a deck to another device

The one thing actually missing. A deck lives in the browser that made it, so a deck made on
a laptop is not on a phone. It needs a server-side database, which needs auth, which needs a
reason — see "Not planned" below, where auth is still recorded as not worth it. This is the
entry that would reopen that question.

## Built

Kept with their original reasoning so a later reader can see what was predicted and what
actually happened.

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

### ~~5. A4 and card-size options~~ — built

~~The print layout is hardcoded to US Letter at six cards per sheet, which makes the feature
unusable outside North America.~~ Paper (**US Letter** or **A4**) and card size (**6 per
sheet**, **index card 5 × 3in**, **business card 3.5 × 2in**) are now separate choices, and
the grid is whatever falls out of fitting one into the other — 4 index cards or 10 business
cards to a sheet on either paper. Both are remembered, since which paper you own doesn't
change between decks.

It was not the one-constant change this predicted: the duplex arithmetic had the 2 × 3 grid
baked into it, so `backSheetOrder` now takes the grid, and the sheet box moved out of the
stylesheet into the layout. Verified by printing the page to PDF in a real browser and
measuring the result — A4 pages come out 8.26 × 11.69in, and an index card is cut at exactly
3 × 5in.

### ~~Input coverage~~ — built

| Item | What happened |
| --- | --- |
| ~~OCR for scanned PDFs~~ | A PDF with no text layer is rasterised (`unpdf` + `@napi-rs/canvas`) and read by the vision model the app already supports, rather than adding a second OCR engine. Verified on a PDF with a zero-length text layer. |
| ~~YouTube transcripts~~ | A YouTube link fetches the video's captions instead of the page. English is requested explicitly — left to itself the library returns whichever track is listed first, which on a popular talk is often a translation. |
| ~~Multiple files into one deck~~ | Several files are extracted, headed with their filenames and merged before chunking. Images and scans still go one at a time, since each needs its own vision pass. |
| ~~URL input~~ | A pasted link is fetched and stripped to text. Only public http(s): a server that fetches any address its client names is a way into whatever else that server can reach. |
| ~~Audio to transcript~~ | `whisper-cli` locally, with `ffmpeg` to normalise the audio first. Both are looked up rather than bundled, and their absence is reported as instructions. |

### ~~Card quality~~ — built

- ~~**Cloze deletion**~~ — a **Fill in the blank** style. Cloze decks export to Anki's own
  cloze note type (`{{c1::…}}`, model `type: 1`), not a two-sided note dressed up as one.
- ~~**Question-style cards**~~ — a **Questions** style, held to actually being a question.
- ~~**Difficulty setting**~~ — **Introductory** against **Exam level**, as a prompt section.
- ~~**Jump to source**~~ — **Source** on any card opens the passage it came from, with its
  quoted evidence highlighted. A local lookup against the deck's stored text, no round trip.

The pipeline, the evidence check and the deduper are untouched by any of it: a cloze deck is
verified against its source exactly as a definition deck is.

### ~~Performance~~ — built

- ~~**Cache by content hash**~~ — keyed on the source text plus every setting that changes
  the output, so a hit cannot be wrong. Measured at 16s → 0s on a repeat run.
- ~~**Parallel chunks on cloud providers**~~ — four sections in flight for hosted providers,
  one for Ollama, which serializes per model anyway. Sections merge in section order however
  they finish, or the same document would give different decks on different days.
- ~~**Resume an interrupted generation**~~ — sections are cached individually, so a run that
  died on section nine only pays for section nine. No "where was I" bookkeeping: the key is
  the section's own text, so an edited document reruns only what changed.

## Not planned

Recorded so the question doesn't get reopened without new information.

- **A full spaced-repetition system.** Anki has years of scheduling research behind it and
  apps on every platform. Exporting to it is better for the user than reimplementing it.
- **Auth and multi-user.** Drags in a database, sessions, and hosting for no demand yet.
- **A whole-deck curator pass.** Considered during the pipeline benchmark and skipped:
  deterministic dedupe plus section-by-section writing already cover most of what it would
  do, and every extra pass is real wall-clock time on a local model.
