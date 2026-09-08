# Flashcard Anything — Project Plan

Convert slideshows, PDFs, textbook chapters, notes, and images into flashcards, automatically, using an LLM.

## Stack

- **Frontend/Backend:** Next.js (App Router, TypeScript) — one codebase, API routes double as the backend, deploys straight to Vercel.
- **Generation:** the user picks a provider in the app — **Ollama** (default; local, free, no key), **Anthropic**, **OpenAI**, **OpenRouter**, **Google**, **Groq**, **DeepSeek**, **Mistral**, **Together**, or a **Custom** OpenAI-compatible URL. Providers declare an `ApiStyle`, and only three exist: `openai` (nearly everything), `anthropic` (Messages API with a tool call), and `ollama` (its native API). Adding a provider is a preset, not new client code. Structured output is requested as a JSON schema, falling back to `json_object` and then to tolerant parsing, since servers vary in what they support. Cloud keys live in browser storage or `.env.local` — never in the repo.
- **Theme:** light or dark, chosen explicitly — there is no "follow the system" option, so `data-theme` is always present and the palette never depends on an OS setting. Tokens are defined for light on `:root` and overridden under `[data-theme="dark"]`. Dark is a dimmed charcoal rather than black, which reads better over long sessions; every pairing clears WCAG AA (body text at 13.7:1). A pre-paint script in the layout applies the stored choice so there's no flash. Print always renders on white.
- **Export:** a versioned JSON document (`version`, `generatedAt`, `source`, `scope`, `model`, `cards`), so other tools get a stable contract. The API returns the same card shape.
- **Text extraction:** done locally, because a local text model can't read binaries — `unpdf` for PDFs, OOXML unpacking for `.pptx` (slides + speaker notes) and `.docx`, plus EPUB, RTF and HTML. Format is detected from the bytes, not the extension. Images are transcribed by a vision model first, then run through the same grounded pipeline as any document.
- **Chunking:** required here in a way it wasn't with a hosted frontier model — local context windows are small, so material is split on paragraph boundaries, generated section by section, and merged with duplicate terms dropped.
- **Database:** SQLite via Prisma for local dev/MVP; swappable to Postgres (Neon/Supabase) for production — same schema, just change the datasource.
- **File storage:** local disk for MVP; S3/Cloudflare R2 later if hosting uploads long-term.
- **Auth:** skip for v1 (single local user); add NextAuth.js when multi-device/sharing is needed.
- **Styling:** hand-written CSS with custom properties. The print layout needs exact `@page` control and inch-based grids, which is easier to get right without a utility framework.

## Not built yet

There is no database and no persistence: a deck lives in the page until it is printed or
exported. Cards cannot be edited or regenerated individually. There is no study scheduler,
and one is not planned — see [ROADMAP.md](ROADMAP.md), which argues for exporting to Anki
instead of reimplementing spaced repetition here.

## Core flow

1. User uploads a file (PDF, pptx, docx, epub, rtf, html, text, or an image) or pastes text,
   optionally naming the part they want.
2. Backend normalizes the input to text, strips page furniture, and resolves any requested
   chapter/section/page range.
3. The chosen model turns each chunk into `{term, definition, evidence}` cards as structured
   JSON. The quoted evidence is verified in code, and duplicates are merged out.
4. Cards are returned as a flip deck on screen, a double-sided print layout, and a JSON
   export.

The in-memory shape is `Card { term, definition, evidence? }` — deliberately small, because
nothing is stored. A persisted schema is a question for whenever persistence lands.

## Roadmap

Moved to [ROADMAP.md](ROADMAP.md), so planned work lives in one place. This file records
what exists and the reasoning behind it.

## Print layout (built)

6 cards per US Letter sheet (2 cols × 3 rows, 3.75in × 3.333in each, 0.5in margins), each
page emitted as a front sheet followed by its back sheet. The back sheet is reordered so
every definition lands behind its own term once the paper flips:

- **Long edge** (rotates about the vertical axis) → mirror each row's columns.
- **Short edge** (rotates about the horizontal axis) → reverse the row order.

Both sides render into an identical fixed grid, so cut lines register on each side. Logic
lives in `lib/duplex.ts`; the flip edge is the app's one print setting.

## Grounding (built)

Cards must describe what the *source* says, not what the model already believes. Two model
roles, with mechanical checks between them:

1. **Writer** — turns a section into cards, each carrying an `evidence` span quoted from
   the text.
2. **Evidence check** (code, not a model) — verifies the span appears in what the writer
   was shown: normalized substring, falling back to 85% word overlap. Catches invention,
   which shares almost no vocabulary with the source. Cheap, so it runs first and keeps
   junk out of the reviewer's context.
3. **Reviewer** — re-reads the section and judges each surviving card `ok` / `fix` / `drop`,
   returning corrected text for fixes. Catches the case the evidence check cannot: a real
   quote paired with a definition that misstates it. Best-effort — if it fails, the
   writer's cards are kept.

Roles are batched per chunk, not per card: one call per section, plus one more when the
reviewer runs.

**The default is writer + evidence check, chosen by measurement.** Six arrangements were
benchmarked (`bench/`). The reviewer pass tripled runtime while returning identical
per-case scores, so it is no longer on by default. The evidence check stays because it is
nearly free and is the only mechanical guard against an unsupported definition.

A two-writer ensemble did score highest — 96% concept coverage against 90% — but costs 18x
the runtime, so it is selectable rather than standard. Benchmarking it also exposed a real
bug: its writers ran under `Promise.all`, which on a server that handles one request per
model at a time bought no parallelism and made them contend (1081s per case, against 439s
once sequential).

The benchmark cannot see the reviewer's value on messy material, which is a limitation of
the fixtures rather than proof the reviewer is useless.

Chunking is what invites invention, so each request also carries a context block: the
document's opening plus an acronym glossary harvested from the full text before splitting.
Chunks overlap by ~320 characters. Temperature is 0.

## Deduplication (built)

`lib/dedupe.ts` is the single funnel every pipeline merges through. Three signals, because
term equality alone let "intravaginal ring" and "intravaginal ring (IVR)" both through with
identical backs:

1. **Normalized term** — case, parenthetical glosses, punctuation, leading articles, and
   simple plurals folded away. Singularization skips `-ss/-us/-is/-as` so "bias" and
   "analysis" survive intact.
2. **Document glossary** — an acronym whose expansion the document states maps onto that
   expansion, so `IVR` and `intravaginal ring` are one card rather than two.
3. **Definition similarity** — containment over content words at 0.85, which catches a
   restatement in different words. Numbers are compared exactly first: two cards quoting
   different figures are making different claims however similar the wording, so
   "40 units" and "85 units" never merge.

Covered by `npm test`, including the cases that must *not* collapse — "morpheme" vs "free
morpheme", and a terse card that must not swallow a detailed one.

## Navigation (built)

A whole textbook can be uploaded with a request like "flashcards for chapter 3, section 2".
Resolution is deterministic and happens before any model call — headings are detected by
pattern (`Chapter 7`, `3.2 Title`, `Section 4.1`), each carrying a character offset and a
page number, and the winning heading's extent runs to the next heading of the same or
higher level. Page/slide ranges work too, since PDFs and .pptx files are extracted per page
rather than merged.

No retrieval model and no embeddings: a table of contents is cheap to parse, exact, and
explainable, and the chosen range is reported back so a wrong guess is visible. The
fallback for unnumbered documents is word overlap against heading titles.

Oversized documents without a scope are now rejected with the detected chapter list rather
than silently truncated at `chunkChars × MAX_CHUNKS`, which is what used to happen.

## Ollama uses the native API, not the OpenAI shim

Ollama's `/v1/chat/completions` pins the context window at 4096 tokens and offers no way to
turn off qwen3's hidden reasoning. A 3500-character chunk plus its context block and system
prompt exceeds that, so material was being silently truncated. Switching the Ollama path to
`/api/chat` — with `options.num_ctx` (8192, override via `OLLAMA_NUM_CTX`), `think: false`,
and the JSON schema passed as `format` — made a 38-slide deck go from 642s to 106s while
producing more cards. OpenRouter still uses the OpenAI-compatible path; Anthropic uses its
Messages API.

## What testing on real coursework changed

Running the real files surfaced things synthetic fixtures never would:

- **Acronyms swallowed titles.** Skipping filler words to match initials let `(CSP)` bind to
  eight words of a paper title. Now the shortest trailing phrase starting on the acronym's
  first letter wins.
- **Running headers broke navigation.** A textbook prints "1.2 Section Title" on every page,
  so the first match's extent ran only to the next repeat — 54 characters. Repeats of a
  number are now treated as one section, keeping the occurrence that spans the most text.
- **Chapters aren't headings.** "Chapter 3" also appears in cross-references inside body
  text, so a chapter is derived from its own sections (`3.1` to `4.1`) when they exist.
- **Contents listings need frequency, not length.** The real section title is the one that
  recurs as a running header; the longest match is often a mid-sentence fragment.
- **Images had no grounding at all.** A vision model returned the single word "system" for a
  page it couldn't decode, and the writer dutifully defined "system". Images are now
  transcribed first, and the transcript runs through the same evidence check and review as
  any document, so an unreadable image fails visibly instead of inventing a card.
- **Maths breaks JSON.** `\frac` is not a legal JSON escape, so a single formula could make a
  whole response unparseable. Invalid escapes are repaired before parsing, transcription
  asks for plain notation rather than LaTeX, and transcription returns plain text instead of
  being forced through a JSON string.
- **Small models loop.** One produced 19k characters of repeated `\begin{array}` over four
  minutes. Generation is capped (`num_predict`), so a loop now fails in seconds.
- **Page furniture became flashcards.** Running headers are extracted as body text, so a
  card came back as `term: "T ( 2.3 Matrix Products 75"`. Document-wide line frequency was
  the wrong detector — a section header appears on ~15 of 527 pages, and "Solution" appears
  constantly without being furniture. Furniture is positional, so only the first and last
  lines of each page are considered. Headings are located before this runs, since the
  repetition is what makes a running header useful for navigation.
- **Control characters voided whole batches.** PDFs carry C0 bytes where they use custom
  glyphs; a model echoes one into a JSON string, and a raw control character there is
  invalid. Stripped at extraction, with repair as a backup.
- **Truncated responses lost everything.** The output cap cuts a response mid-array, and the
  outer `{"cards":[` never closes — so a salvage pass that looked for balanced objects at
  depth 0 found none. It now scans for the nested card objects, which recovered 58 and 79
  cards in a single textbook run.

## Open questions

- Richer traceability (page or slide numbers, not just the quoted span).
- Whether a whole-deck curator pass earns its latency on cloud providers, where it's cheap.
- Whether the reviewer should run twice on low-confidence cards rather than once on all.
