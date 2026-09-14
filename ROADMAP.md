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
question cards, caching — is built too.

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
| ~~OCR for scanned PDFs~~ | A PDF with no usable text layer is rasterised (`unpdf` + `@napi-rs/canvas`) and read by tesseract, falling back to the vision model. See "OCR, reconsidered" below — the first version of this was wrong twice over. |
| ~~YouTube transcripts~~ | A YouTube link fetches the video's captions instead of the page. English is requested explicitly — left to itself the library returns whichever track is listed first, which on a popular talk is often a translation. |
| ~~Multiple files into one deck~~ | Several files are extracted, headed with their filenames and merged before chunking. Images and scans still go one at a time, since each needs its own vision pass. |
| ~~URL input~~ | A pasted link is fetched and stripped to text. Only public http(s): a server that fetches any address its client names is a way into whatever else that server can reach. |
| ~~Audio to transcript~~ | `whisper-cli` locally, with `ffmpeg` to normalise the audio first. Both are looked up rather than bundled, and their absence is reported as instructions. |

### ~~Card quality~~ — built

- ~~**Cloze deletion**~~ — **built, then removed.** It worked, down to exporting real Anki
  cloze notes, but the cards were harder to study from than the format promises: blanking one
  word in a sentence you are also being shown tests something narrower than recall. Kept in
  the history rather than the app.
- ~~**Question-style cards**~~ — a **Questions** style, held to actually being a question.
- ~~**Difficulty setting**~~ — **Introductory** against **Exam level**, as a prompt section.
- ~~**Jump to source**~~ — **Source** on any card opens the passage it came from, with its
  quoted evidence highlighted. A local lookup against the deck's stored text, no round trip.

The pipeline, the evidence check and the deduper are untouched by any of it: a question deck
is verified against its source exactly as a definition deck is.

### ~~Performance~~ — built

- ~~**Cache by content hash**~~ — keyed on the source text plus every setting that changes
  the output, so a hit cannot be wrong. Measured at 16s → 0s on a repeat run.
- ~~**Parallel chunks on cloud providers**~~ — four sections in flight for hosted providers,
  one for Ollama, which serializes per model anyway. Sections merge in section order however
  they finish, or the same document would give different decks on different days.
- ~~**Resume an interrupted generation**~~ — sections are cached individually, so a run that
  died on section nine only pays for section nine. No "where was I" bookkeeping: the key is
  the section's own text, so an edited document reruns only what changed.

### OCR, reconsidered — built

This was first built on the argument that a second OCR engine wasn't worth it: rasterise the
pages, hand them to the vision model the app already supports, done. That was wrong twice
over, and both halves showed up as the same report — "I uploaded a PDF and got *couldn't
read any text*".

The first half was the argument. It quietly assumed the configured model could see. The
default is `qwen3:8b`, a text-only model, so every page of every scan came back empty and the
app told the reader to go install a vision model — which is a strange thing to demand for a
photocopy, when tesseract reads a page of printed body text better and about a hundred times
faster than a small local vision model does. Tesseract is now tried first, on the same terms
whisper is: looked up on PATH, not bundled, absence reported as instructions. The vision model
stays as the fallback, because tesseract is poor at handwriting, whiteboards, and anything not
laid out like a page.

The second half was the detection. "Is this a scan?" was asked as "is the text layer empty?",
and a scan's text layer is usually not quite empty — a scanner stamps a page number, a library
stamps a copyright line, a cover page is often the one page that was ever digital. Those few
characters were enough to call the file a document, skip reading the pages, and then fail at
the far end with nothing left to show. It is now judged per page: a real page of prose runs to
hundreds of characters, so anything averaging less than a short line is furniture and the pages
get read. A thin layer is kept as a floor rather than thrown away, so a short real document is
never worse off than before.

A related case, fixed with it: a text layer of nothing but control bytes from a broken glyph
map. The bytes were stripped *after* the scan test rather than before it, so the file looked
like a document at the moment the decision was made and was empty two steps later.

`test/ocr.test.mjs` covers all of it against PDFs built the way a scanner builds one — a page
rendered to pixels and wrapped with no text layer behind it — so nothing there can pass by
accidentally reading text a real scan wouldn't have.

### How many cards — built

**Fewest / Normal / Most**, beside **Cards as** and **Level**. Not a cap: a cap can only
truncate, and sections are written in document order, so a deck cut off at twenty is twenty
cards about chapter one and silence about chapter four. It sets how selective the writer is,
per section, so **Fewest** still covers the whole document — just sparsely.

The instructive part was that adjectives did not work. "Be severe. Most candidate terms
should be rejected" got thirty cards out of `qwen3:8b` from a single page, and the global cap
did the truncating after all. The same prompt with the ceiling stated as a figure —
`Write at most 3 cards` — got three. It is enforced in `overChunks` as well, so a model that
ignores the number still can't spend the whole deck on section one, and the deck-wide cap is
now derived from it (sections × per-section ceiling) rather than the fixed 60 that used to cut
a long textbook off halfway.

**Most** needed its own rule against padding. Told to be exhaustive it produced "Mitochondrial
structure", "Mitochondrial function", "Mitochondrial role" and "Mitochondrial process" — four
cards the deduper passed, because the terms really are different, answered by one sentence.
The prompt now names that shape and says the number is a ceiling, not a target; it returns 17
of an allowed 20 on the same page.

Measured on one page of biology notes against a local `qwen3:8b`: 3 cards, 8 cards, 17 cards.

### Ollama's structured output is the real cost of "Most"

Found while measuring the above, and worth writing down because it is not what it looks like.
**Most** took ~17 minutes for a section where **Normal** took 20 seconds — far more than twice
the work for twice the cards. It is not the model and not the output-token ceiling. The same
material, the same model and the same 20-card instruction, sent straight to `/api/chat`:

| | Wall clock | Tokens | Rate |
| --- | --- | --- | --- |
| no `format` | 36s | 1600 | 44 tok/s |
| `format: <the card schema>` | 18m 19s | 2113 | 1.9 tok/s |

Both finished cleanly on `stop` — nothing was truncated, and the constrained run returned a
full 20 cards. Ollama's schema-constrained decoding is simply 23× slower per token here, and
since the penalty is per token it compounds with exactly the thing **Most** asks for.

That is pre-existing — every density pays it, and **Most** only makes it visible. Worth
investigating separately: Ollama already falls back through `format: "json"` and then to the
tolerant parser in `lib/llm.ts`, so preferring the looser mode for this provider would likely
recover most of the 23×. It trades a guarantee for speed, though, and the drop rate should be
measured before it is chosen rather than assumed small. Hosted providers are unaffected —
they do constrained decoding server-side without this penalty.

### The theme toggle moved — built

Light and dark lived in the panel behind **Change**, which is where you go to type an API key,
not where anyone looks to turn the lights off. It is now a sun/moon button in the top right,
fixed to the viewport so it is in the same corner on the upload screen and on a deck.

## Not planned

Recorded so the question doesn't get reopened without new information.

- **A full spaced-repetition system.** Anki has years of scheduling research behind it and
  apps on every platform. Exporting to it is better for the user than reimplementing it.
- **Auth and multi-user.** Drags in a database, sessions, and hosting for no demand yet.
- **A whole-deck curator pass.** Considered during the pipeline benchmark and skipped:
  deterministic dedupe plus section-by-section writing already cover most of what it would
  do, and every extra pass is real wall-clock time on a local model.
