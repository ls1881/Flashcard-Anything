# Flashcard Anything — Project Plan

Convert slideshows, PDFs, textbook chapters, notes, and images into flashcards, automatically, using an LLM.

## Stack

- **Frontend/Backend:** Next.js (App Router, TypeScript) — one codebase, API routes double as the backend, deploys straight to Vercel.
- **AI generation:** Anthropic Claude API. Claude accepts PDFs and images as native input, so PDFs/scanned pages/photos of textbook pages don't need a separate OCR step — just send the file and ask for flashcards back as structured JSON (tool use / structured output).
- **Slideshows (.pptx):** not natively supported by the API — extract text (and speaker notes) with a library (e.g. `pptx-parser` or convert to PDF first via LibreOffice headless), then send that to Claude alongside any embedded images.
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

## Open questions to settle before/while building

- Chunking strategy for long PDFs/decks (how many cards per section, how to avoid duplicates across chunks).
- How much source traceability to keep (e.g., "this card came from slide 12") — useful for review but adds complexity.
- Whether pptx support ships in v1 or gets deferred behind PDF export as a workaround.
