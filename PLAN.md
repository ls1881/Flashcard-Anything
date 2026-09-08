# Flashcard Anything — Project Plan

Convert slideshows, PDFs, textbook chapters, notes, and images into flashcards, automatically, using an LLM.

## Stack

- **Frontend/Backend:** Next.js (App Router, TypeScript) — one codebase, API routes double as the backend, deploys straight to Vercel.
- **Generation:** the user picks a provider in the app — **Ollama** (default; local, free, no key), **OpenRouter**, or **Anthropic**. Ollama and OpenRouter share one OpenAI-compatible `/chat/completions` path; Anthropic uses its Messages API with a tool call, which returns cleaner JSON. Structured output is requested as a JSON schema, falling back to `json_object` and then to tolerant parsing, since local servers vary in what they support. Cloud keys live in browser storage or `.env.local` — never in the repo.
- **Text extraction:** done locally, because a local text model can't read binaries — `unpdf` for PDFs, OOXML unpacking for `.pptx` (slides + speaker notes) and `.docx`. Images go to the model as images and need a vision model.
- **Chunking:** required here in a way it wasn't with a hosted frontier model — local context windows are small, so material is split on paragraph boundaries, generated section by section, and merged with duplicate terms dropped.
- **Database:** SQLite via Prisma for local dev/MVP; swappable to Postgres (Neon/Supabase) for production — same schema, just change the datasource.
- **File storage:** local disk for MVP; S3/Cloudflare R2 later if hosting uploads long-term.
- **Auth:** skip for v1 (single local user); add NextAuth.js when multi-device/sharing is needed.
- **Styling:** Tailwind CSS.

## Data model (v1)

```
Deck
  id, title, createdAt, sourceType (pdf | pptx | image | text | url)

Card
  id, deckId, front, back, sourceExcerpt (optional, for traceability),
  easeFactor, interval, dueDate   -- SM-2 spaced-repetition fields
```

## Core flow

1. User uploads a file (PDF, image, pptx) or pastes text/a URL.
2. Backend normalizes input → text + images (extract pptx text, or pass PDF/image straight through).
3. Call Claude with the content, asking for an array of `{front, back}` flashcards as structured JSON (tool-use schema), chunking long documents so each call stays in context and covers one section.
4. Show generated cards in an editable review screen — user can edit, delete, merge, or regenerate individual cards before saving.
5. Save the deck; cards enter a spaced-repetition queue (SM-2: correct → interval grows, wrong → resets).
6. Study mode: pull due cards, show front, reveal back, user grades recall (again/hard/good/easy), reschedule.

## Roadmap

1. **MVP** — ✅ done. Upload PDF / pptx / docx / text / image or paste text → Claude generates
   `{term, definition}` cards → on-screen flip deck + double-sided print layout with
   automatic front/back alignment. No persistence yet.
2. **Persistence** — Prisma + SQLite; save/list/delete decks; edit or regenerate individual
   cards before saving.
3. **Study mode** — SM-2 scheduler, due-card queue, review UI with grading.
4. **Polish** — deck export (CSV / Anki `.apkg`), URL input (scrape → text), A4 page size
   alongside Letter, deploy to Vercel.
5. **Multi-user (optional)** — NextAuth, per-user decks, Postgres migration.

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

Roles are batched per chunk, not per card: two calls per section regardless of card count.
A third pass was considered (a whole-deck curator for coverage and near-duplicates) and
skipped — on a local model each pass is real wall-clock time, and deterministic dedupe plus
the writer's own section-by-section coverage already handle most of it.

Chunking is what invites invention, so each request also carries a context block: the
document's opening plus an acronym glossary harvested from the full text before splitting.
Chunks overlap by ~320 characters. Temperature is 0.

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

## Open questions

- Richer traceability (page or slide numbers, not just the quoted span).
- Whether a whole-deck curator pass earns its latency on cloud providers, where it's cheap.
- Whether the reviewer should run twice on low-confidence cards rather than once on all.
