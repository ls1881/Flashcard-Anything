# Flashcard-Anything

Convert slideshows, PDFs, textbook chapters, etc. into flashcards.

Drop in a file of any supported format, get the same output every time: a deck you can
flip through on screen, and a double-sided print layout where every definition lands
exactly behind its own term.

Works with a **local model** (free, private, no key) or any **cloud provider**. Pick in the
app under **Change** — no config files required.

| Provider | Key | Notes |
| --- | --- | --- |
| **Ollama** (default) | No | Runs on your machine. Free and private. |
| **Anthropic** | Yes | Claude direct. |
| **OpenAI** | Yes | GPT models. |
| **OpenRouter** | Yes | One key, hundreds of models. |
| **Google** | Yes | Gemini, via its OpenAI-compatible endpoint. |
| **Groq** | Yes | Open models, very fast. |
| **DeepSeek**, **Mistral**, **Together** | Yes | Hosted models. |
| **Custom** | Optional | Any OpenAI-compatible URL — vLLM, LM Studio, llama.cpp, a gateway. |

Adding a provider is a preset in [`lib/providers.ts`](lib/providers.ts), not new client
code: everything except Anthropic and Ollama speaks OpenAI's dialect, and **Custom** covers
anything not listed. Keys can also come from the environment — `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`,
`DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `CUSTOM_LLM_API_KEY`.

**Appearance** (light or dark) is in the same panel.

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
2. Optionally say **which part** you want: `chapter 3, section 2`.
3. Hit **Make flashcards**. Every card comes out the same shape: a short term on the
   front (1–5 words), the full definition on the back.
4. Click any card to flip it, or hit **Print** for the paper deck.

## Pointing it at part of a book

Upload the whole textbook and name the part you want. The request is resolved against the
document's own structure before anything reaches a model, so only that slice is read:

| You type | What happens |
| --- | --- |
| `chapter 3, section 2` | Finds section 3.2, or the 2nd section inside chapter 3 |
| `chapter 4` | The whole chapter, up to the next chapter heading |
| `section 2.3` or just `2.3` | That numbered section |
| `Heat Engines` | Matches against heading titles |
| `pages 100-120`, `slides 4-9` | A page or slide range |

Headings are found by pattern (`Chapter 7`, `3.2 Reaction Kinetics`, `Section 4.1`), and
the result bar tells you what it actually used — `3.2 Entropy and the Second Law (pages
84–97)` — so a wrong guess is visible rather than silent. Ask for something that isn't
there and it says so, listing the chapters it did find. Page numbers are real for PDFs and
slides; plain text files count as a single page.

**Long documents now refuse rather than truncate.** A whole textbook with no part named
returns an error telling you to name one, instead of quietly making cards from page one.

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
| PDF | Text extracted locally with `unpdf`, one page at a time |
| .pptx | Slide text + speaker notes unpacked from the OOXML |
| .docx | Document text unpacked from the OOXML |
| .epub | Chapters read in spine order |
| .rtf, .html | Markup stripped |
| .txt/.md/.csv | Read directly |
| Images | Sent to the model as an image — **needs a vision model** (`ollama pull qwen2.5vl:7b`) |

Format is detected from the file's bytes rather than its extension, so a mislabelled or
extension-less file still works. Legacy `.doc`/`.ppt`, Pages/Keynote, and files that aren't
documents at all are refused with a message saying what to do instead, rather than being
fed to the model as garbage.

Everything normalizes to the same `{ term, definition }` list, which drives both the
on-screen deck and the print sheets.

## Exporting

**Export JSON** downloads the deck in a stable, documented shape, so other tools can read
it without scraping the page:

```json
{
  "version": 1,
  "generatedAt": "2026-09-08T14:03:11.000Z",
  "source": "lecture8.pdf",
  "scope": "3.2 Entropy and the Second Law (pages 84–97)",
  "model": { "provider": "ollama", "name": "qwen3:8b" },
  "count": 2,
  "cards": [
    {
      "term": "Chemiosmosis",
      "definition": "ATP synthase uses the proton gradient to phosphorylate ADP into ATP.",
      "evidence": "Chemiosmosis is the process by which ATP synthase uses the proton gradient"
    }
  ]
}
```

`version` is bumped on any breaking change to the shape. `scope` is `null` when the whole
document was used. `evidence` is the span the card was checked against, which is useful for
auditing a deck but can be ignored.

The same JSON comes back from the API, so a script can skip the UI entirely:

```bash
curl -s -N -X POST http://localhost:3000/api/generate \
  -F "file=@notes.pdf" -F "scope=chapter 3" \
  -F "provider=ollama" -F "model=qwen3:8b" | tail -1
```

The endpoint streams newline-delimited JSON: `{"type":"progress",…}` lines while it works,
then a final `{"type":"result","cards":[…]}` or `{"type":"error","error":"…"}`.

## Staying grounded in your source

Models like to answer from prior knowledge — asked about "URTC" in a conference paper, one
will happily invent "Unified Regional Transportation Corridor."

**Write.** Each section is turned into cards, and every card must also return an `evidence`
span quoted from the text.

**Check — is the quote real?** The server verifies that span actually appears in what the
model was shown (normalized substring, falling back to 85% word overlap). Invented content
shares almost no vocabulary with the source, so it fails here and is dropped. This is the
default, and it costs about a second.

**Optionally, review.** A quote being real doesn't mean the definition says what the quote
says. A second model pass can re-read the section and judge each card `ok`, `fix` (with a
corrected definition drawn only from the source), or `drop` — repairing cards rather than
just discarding them. It is **off by default**: benchmarking six arrangements found it
tripled runtime without changing any score ([bench/](bench/)). Turn it on per request with
`-F "pipeline=grounded-review"`.

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

Images take an extra step: the vision model transcribes the page first, and the
transcription then goes through the same grounded pipeline as any document, so an image
gets the same evidence check and review as a PDF.

**Limits:**

- Scanned/image-only PDFs have no extractable text — screenshot the pages and upload them
  as images with a vision model instead.
- Transparent PNGs can reach the model as a black rectangle. Save as JPEG if a screenshot
  comes back empty.
- Small vision models are weak on dense maths and can loop; generation is capped so that
  fails in seconds rather than minutes. Expect thin results from image uploads of
  formula-heavy pages, and prefer the original document when you have it.
- Card quality tracks the model. With Ollama, a bigger model (`ollama pull qwen3:14b`)
  gives noticeably better definitions.
- A dense textbook section is near the edge of what an 8B local model handles well, and a
  full section takes around ten minutes. Scope to a section rather than a chapter, and
  prefer a larger model or a cloud provider for maths-heavy material.

Running headers, footers, and other page furniture are stripped before the model reads a
page, so cards come from the content rather than the margins.

- [`lib/providers.ts`](lib/providers.ts) — the three providers and their defaults
- [`lib/llm.ts`](lib/llm.ts) — provider clients, JSON coaxing, error messages
- [`lib/extract.ts`](lib/extract.ts) — turns any upload into text, and chunks it
- [`app/api/generate/route.ts`](app/api/generate/route.ts) — card rules and streamed generation
- [`lib/duplex.ts`](lib/duplex.ts) — the front/back mirroring math
- [`app/globals.css`](app/globals.css) — screen styles and the `@page` print layout

See [PLAN.md](PLAN.md) for the roadmap.
