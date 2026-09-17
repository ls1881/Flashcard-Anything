# Flashcard Anything

Turn a PDF, slide deck, chapter, lecture recording, or web page into study flashcards.

Feed it a file. Get back a deck you can flip through in the browser, print double-sided, or
import into Anki. With a local model it runs entirely on your own machine — no account, no
API key, nothing uploaded anywhere.

**[Quickstart](#quickstart)** · [What it reads](#what-you-can-feed-it) ·
[Card options](#the-three-choices) · [Print & Anki](#what-you-get-out) ·
[Part of a book](#pointing-at-part-of-a-book) · [Providers](#providers) ·
[Troubleshooting](#troubleshooting)

---

## Quickstart

**Requirements:** Node 18.18 or newer (20+ recommended).

### Option A — free and local (recommended)

```bash
# 1. Install and start Ollama, then pull a model (~5GB, one time)
brew install ollama          # or download from ollama.com
ollama serve                 # leave this running in its own terminal
ollama pull qwen3:8b

# 2. Start the app
npm install
npm run dev                  # → http://localhost:3000
```

Nothing leaves your machine. No key, no signup, no cost.

### Option B — a cloud model (much faster)

```bash
npm install
npm run dev                  # → http://localhost:3000
```

Then click **Settings** at the bottom of the page, choose a provider, and paste your API key.

> **Pick Anthropic or OpenRouter for zero extra steps** — they come with a default model
> already filled in. Every other provider needs you to type a model name too.

Keys are stored in your browser and never written to the repo. To keep them out of the
browser entirely, put the key in `.env.local` instead and leave the field blank:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local
```

### Make your first deck

1. Paste a few paragraphs into the big text box (or drop in a file).
2. Click **Make flashcards**.
3. Cards appear as they're written. Click one to flip it.

That's it. The deck saves itself — reload the page and it's still there.

---

## What you can feed it

| Input | Notes |
| --- | --- |
| **PDF** | Including scans and photocopies — see [Optional extras](#optional-extras) |
| **PowerPoint** `.pptx` | Slide text *and* speaker notes |
| **Word** `.docx`, **EPUB**, **RTF**, **HTML** | Read directly |
| **Text** `.txt` `.md` `.csv` | Or just paste into the box |
| **Images** | Screenshots of slides, photos of a page |
| **Audio/video** | `.mp3` `.m4a` `.wav` `.mp4` — see [Optional extras](#optional-extras) |
| **A web page** | Paste the URL. Public `http`/`https` only |
| **A YouTube lecture** | Paste the video link; its captions become the source |

Drop in **several files at once** and they become one deck. File type is detected from the
bytes, not the extension, so a mislabelled file still works.

---

## The three choices

Three dropdowns sit above the **Make flashcards** button.

**Cards as**

| Style | Front | Back |
| --- | --- | --- |
| **Definitions** | a term, 1–5 words | what it means |
| **Questions** | a question the source answers | the answer |

**Level** — **Introductory** (core vocabulary, headline figures) or **Exam level**
(mechanisms, conditions, exceptions, exact figures).

**How many**

| Setting | What you get |
| --- | --- |
| **Fewest** | Only the ideas you couldn't skip |
| **Normal** | One card per idea worth memorizing |
| **Most** | Everything the material supports, minus repeats |

This changes how selective the writer is *per section*, so **Fewest** still covers the whole
document — just sparsely. It's a ceiling, not a quota: thin material gives a short deck at
any setting. One page of biology notes against a local `qwen3:8b` gave **3, 8 and 17 cards**.

> ⚠️ **Most** is much slower on a local model — minutes where **Normal** takes seconds. On a
> cloud provider the difference is small.

---

## What you get out

### On screen

Click a card to flip it. **Edit** fixes one by hand; **AI rewrite** asks the model for a
different definition (one quick call, not a rerun); **Source** shows the passage the card
came from, highlighted.

### Printed, double-sided

1. Pick **Paper** (US Letter or A4) and a **Cards** size.
2. Click **Print** and turn on two-sided/duplex printing.
3. Set **Flip on** to match your printer — **long edge** (the usual default) or **short edge**.
4. Cut along the dashed lines.

| Cards | Size | Per sheet |
| --- | --- | --- |
| **6 per sheet** | fills the page | 6 |
| **Index card** | 3 × 5 in | 4 |
| **Business card** | 3.5 × 2 in | 10 |

Backs are reordered to compensate for the flip, so every definition lands behind its own
term. Index and business cards come out at exactly that size on either paper.

### In Anki

**Export Anki** gives you a real `.apkg` — double-click it. No CSV mapping to fill in.

**You can re-export the same deck.** Fix a card here, export again, re-import: Anki updates
the notes it already has instead of duplicating the deck, and **your review history is
kept**. Works with Anki 2.1+, AnkiDroid and AnkiMobile.

### As JSON

**Export JSON** gives a stable, documented shape.

<details>
<summary>The JSON shape</summary>

```json
{
  "version": 1,
  "generatedAt": "2026-09-08T14:03:11.000Z",
  "source": "lecture8.pdf",
  "scope": "3.2 Entropy and the Second Law (pages 84–97)",
  "model": { "provider": "ollama", "name": "qwen3:8b" },
  "count": 1,
  "cards": [
    {
      "term": "Chemiosmosis",
      "definition": "ATP synthase uses the proton gradient to phosphorylate ADP into ATP.",
      "evidence": "Chemiosmosis is the process by which ATP synthase uses the proton gradient"
    }
  ]
}
```

`scope` is `null` when the whole document was used; `evidence` is the span the card was
checked against, safe to ignore.

</details>

---

## Pointing at part of a book

Upload the whole textbook and name the part you want in the **Which part?** box. It's
resolved against the document's own structure before any model sees it.

| You type | What you get |
| --- | --- |
| `chapter 3, section 2` | Section 3.2 |
| `chapter 4` | The whole chapter |
| `section 2.3` or `2.3` | That numbered section |
| `Heat Engines` | Matched against heading titles |
| `pages 100-120`, `slides 4-9` | A page or slide range |

The bar above your deck reports what it actually used, so a wrong guess is visible. A whole
textbook with no part named is **refused** rather than quietly turned into cards from page
one.

---

## Optional extras

Looked up on your PATH, not bundled. The app tells you if one is missing.

**Scanned PDFs and photos of text** — read by OCR, no model needed:

```bash
brew install tesseract        # or: apt install tesseract-ocr
```

Without it, pages go to a vision model instead (`ollama pull qwen2.5vl:7b`). OCR is tried
first — faster and more accurate on printed text; the vision model is better for handwriting
and whiteboards.

**Lecture recordings** — transcribed on your machine:

```bash
brew install whisper-cpp ffmpeg
curl -L -o ~/whisper-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
WHISPER_MODEL=~/whisper-base.en.bin npm run dev
```

---

## Providers

| Provider | Key | Default model | Notes |
| --- | --- | --- | --- |
| **Ollama** (default) | No | `qwen3:8b` | Local, free, private |
| **Anthropic** | Yes | `claude-sonnet-5` | Claude direct |
| **OpenRouter** | Yes | `anthropic/claude-sonnet-5` | One key, hundreds of models |
| **OpenAI** | Yes | — | GPT models |
| **Google** | Yes | — | Gemini, via its OpenAI-compatible endpoint |
| **Groq** | Yes | — | Open models, very fast |
| **DeepSeek**, **Mistral**, **Together** | Yes | — | Hosted models |
| **Custom** | Optional | — | Any OpenAI-compatible URL: vLLM, LM Studio, llama.cpp |

Providers showing no default model need one typed into **Settings**. Environment variables
work for all of them: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`GOOGLE_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`,
`CUSTOM_LLM_API_KEY`.

---

## Good to know

- **Decks save themselves**, to this browser only. Reloading returns you to the deck you were
  reading. Use **Export JSON** or **Export Anki** to get one onto another device.
- **Reruns are free.** Same material, same settings — cached, instant.
- **Light or dark** is the sun/moon button in the top right.
- **Nothing is lost if a run ends early.** Whether it fails or you press **Stop**, the
  sections already written are saved, and running it again picks up from there.
- **Cards must quote your source.** Every card carries a span copied from your document, and
  the server checks it really appears there — invented content is dropped, as are duplicates.
  See [PLAN.md](PLAN.md) for how and why.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Can't reach Ollama" | Run `ollama serve` in another terminal |
| "Model isn't pulled yet" | Run `ollama pull qwen3:8b` |
| Definitions are weak | Use a bigger model (`ollama pull qwen3:14b`) or a cloud provider |
| A dense textbook section is slow | Scope to a section, not a chapter — an 8B local model is near its limit on maths-heavy material |
| A screenshot came back empty | Transparent PNGs can reach the model as a black rectangle; save as JPEG |
| A scan produced nothing | Install `tesseract`, or configure a vision model |

---

## For scripts

The API streams newline-delimited JSON, so you can generate a deck without the UI.

<details>
<summary>Example request</summary>

```bash
curl -s -N -X POST http://localhost:3000/api/generate \
  -F "file=@notes.pdf" \
  -F "provider=ollama" -F "model=qwen3:8b" \
  -F "density=normal" | tail -1
```

Add `-F "scope=chapter 3"` to narrow it, or swap `file=@…` for `text=…` or `url=…`.

`{"type":"progress",…}` lines while it works, then a final `{"type":"result","cards":[…]}`
or `{"type":"error","error":"…"}`.

</details>

---

## Development

```bash
npm test              # all checks
npm run build
```

`npm run test:anki` imports a real `.apkg` with Anki itself; it skips unless Anki's Python
library is present:

```bash
python3 -m venv /tmp/ankienv && /tmp/ankienv/bin/pip install anki
ANKI_PYTHON=/tmp/ankienv/bin/python npm run test:anki
```

<details>
<summary>Where things live</summary>

| File | What's in it |
| --- | --- |
| [`lib/providers.ts`](lib/providers.ts) | Provider presets — adding one is a table entry |
| [`lib/llm.ts`](lib/llm.ts) | Provider clients and error messages |
| [`lib/extract.ts`](lib/extract.ts) | Any upload → text, and chunking |
| [`lib/ocr.ts`](lib/ocr.ts) | Tesseract lookup and page OCR |
| [`app/api/generate/route.ts`](app/api/generate/route.ts) | Card rules, streamed generation |
| [`lib/duplex.ts`](lib/duplex.ts) | Front/back mirroring math |
| [`app/globals.css`](app/globals.css) | Screen styles and the `@page` print layout |

</details>

[PLAN.md](PLAN.md) — how it works and why. [ROADMAP.md](ROADMAP.md) — what's next.
[bench/](bench/) — the measurements behind the default pipeline.

MIT licensed.
