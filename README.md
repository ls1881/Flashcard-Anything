# Flashcard-Anything

Convert slideshows, PDFs, textbook chapters, etc. into flashcards.

Drop in a file of any supported format, get the same output every time: a deck you can
flip through on screen, and a double-sided print layout where every definition lands
exactly behind its own term.

## Setup

```bash
npm install
cp .env.example .env.local   # then add your Anthropic API key
npm run dev                  # http://localhost:3000
```

Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).

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
| PDF, images | Passed to the model natively — no OCR step |
| .pptx | Slide text + speaker notes unpacked from the OOXML |
| .docx | Document text unpacked from the OOXML |
| Text formats | Read directly |

Everything normalizes to the same `{ term, definition }` list, which drives both the
on-screen deck and the print sheets.

- [`lib/extract.ts`](lib/extract.ts) — turns any upload into model input
- [`app/api/generate/route.ts`](app/api/generate/route.ts) — the generation call and card rules
- [`lib/duplex.ts`](lib/duplex.ts) — the front/back mirroring math
- [`app/globals.css`](app/globals.css) — screen styles and the `@page` print layout

See [PLAN.md](PLAN.md) for the roadmap.
