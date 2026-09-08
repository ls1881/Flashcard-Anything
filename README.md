# Flashcard-Anything

Convert slideshows, PDFs, textbook chapters, etc. into flashcards.

Drop in a file of any supported format, get the same output every time: a deck you can
flip through on screen, and a double-sided print layout where every definition lands
exactly behind its own term.

Works with a **local model** (free, private, no key) or a **cloud API** if you want better
cards. Pick in the app under **Change** — no config files required.

| Provider | Key needed | Notes |
| --- | --- | --- |
| **Ollama** (default) | No | Runs on your machine. Free and private. |
| **OpenRouter** | Yes | One key, hundreds of models. |
| **Anthropic** | Yes | Claude direct. Best card quality. |

## Setup

```bash
brew install ollama          # or download from ollama.com
ollama serve                 # leave running
ollama pull qwen3:8b         # ~5GB, one time

npm install
npm run dev                  # http://localhost:3000
```

That's the whole setup for local use. For OpenRouter or Anthropic, click **Change** in the
app and paste a key — it's stored in your browser only and never written to the repo. If
you'd rather keep keys out of the browser, put `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`
in `.env.local` and leave the field blank.

## Using it

1. Drop in a **PDF, .pptx, .docx, .txt/.md/.csv, or an image** — or paste text.
2. Hit **Make flashcards**. Every card comes out the same shape: a short term on the
   front (1–5 words), the full definition on the back.
3. Click any card to flip it, or hit **Print** for the paper deck.

## Printing double-sided

The print layout is 6 cards per sheet (2 × 3 on US Letter), and each page prints as a
front sheet followed by its matching back sheet.

1. Hit **Print**, then turn on two-sided / duplex printing.
2. Match the **Flip on** dropdown in the app to your printer's setting — **long edge**
   (the common default) or **short edge**.
3. Print, then cut along the dashed lines.

The back sheet is reordered to compensate for the flip, so backs line up with fronts
instead of ending up on the wrong card. Long edge mirrors each row left-to-right; short
edge reverses the row order. Both sides use an identical fixed grid, so the cut lines
match on each side of the paper.

## How it works

| Input | Handling |
| --- | --- |
| PDF | Text extracted locally with `unpdf` |
| .pptx | Slide text + speaker notes unpacked from the OOXML |
| .docx | Document text unpacked from the OOXML |
| Text formats | Read directly |
| Images | Sent to the model as an image — **needs a vision model** (`ollama pull qwen2.5vl:7b`) |

Everything normalizes to the same `{ term, definition }` list, which drives both the
on-screen deck and the print sheets.

## Staying grounded in your source

Models like to answer from prior knowledge — asked about "URTC" in a conference paper, one
will happily invent "Unified Regional Transportation Corridor." Cards go through two model
passes and two mechanical checks before you see them.

**Pass 1 — write.** Each section is turned into cards. Every card must also return an
`evidence` span quoted from the text.

**Check — is the quote real?** The server verifies that span actually appears in what the
model was shown (normalized substring, falling back to 85% word overlap). Invented content
shares almost no vocabulary with the source, so it fails here and is dropped.

**Pass 2 — review.** A quote being real doesn't mean the definition says what the quote
says. A second call re-reads the section and judges each card: `ok`, `fix` (with a
corrected definition drawn only from the source), or `drop`. Cards get repaired, not just
discarded — a definition claiming a controller "drops elements from the array" when the
paper says it does the opposite comes back corrected. If the reviewer errors out, the
first-pass cards are kept rather than losing the deck.

**Context, so chunks don't invite invention.** Acronym expansions (`URTC = Undergraduate
Research and Technology Conference`) are harvested from the whole document before splitting
and attached to every request, so a term defined on page 1 is still understood on page 9.
Chunks overlap ~320 characters. Temperature is 0.

The results bar reports what the review changed — "3 corrected, 1 unsupported removed".
Review runs on text sources; image sources skip it, since there's no extracted text to
check against.

Local models have small context windows, so long material is split on paragraph boundaries
and turned into cards a section at a time, with progress streamed back to the page and
duplicate terms merged out. Cloud providers get much larger chunks, so they usually finish
in one pass.

**Limits:** scanned/image-only PDFs have no extractable text — screenshot the pages and
upload them as images with a vision model instead. Card quality tracks the model you run;
with Ollama, a bigger model (`ollama pull qwen3:14b`) gives noticeably better definitions.

- [`lib/providers.ts`](lib/providers.ts) — the three providers and their defaults
- [`lib/llm.ts`](lib/llm.ts) — provider clients, JSON coaxing, error messages
- [`lib/extract.ts`](lib/extract.ts) — turns any upload into text, and chunks it
- [`app/api/generate/route.ts`](app/api/generate/route.ts) — card rules and streamed generation
- [`lib/duplex.ts`](lib/duplex.ts) — the front/back mirroring math
- [`app/globals.css`](app/globals.css) — screen styles and the `@page` print layout

See [PLAN.md](PLAN.md) for the roadmap.
