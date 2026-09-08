# Pipeline benchmark

Six arrangements of the writer / checker / reviewer roles, measured rather than argued
about. The pipelines live in [`../lib/pipelines.ts`](../lib/pipelines.ts) and the benchmark
drives them through the real `/api/generate` endpoint, so it tests the shipping code path
rather than a copy of it.

```bash
npm run dev
node bench/run.mjs --port 3000 --model qwen3:8b --chunk 700
```

| Flag | Meaning |
| --- | --- |
| `--port` | Where the dev server is listening |
| `--provider`, `--model` | What to benchmark against (default `ollama`, `qwen3:8b`) |
| `--chunk` | Chunk size in characters — small values force multi-chunk behaviour |
| `--pipelines` | Comma-separated subset |

## The pipelines

| id | Shape | Model calls per chunk |
| --- | --- | --- |
| `single` | Writer only, nothing checked | 1 |
| `grounded` | Writer + evidence check (code, not a model) | 1 |
| `grounded-review` | Writer + evidence check + reviewer | 2 |
| `review-only` | Writer + reviewer, no evidence check | 2 |
| `outline-first` | List the terms, then define them, then evidence check | 2 |
| `ensemble` | Two differently-framed writers, merged, checked, reviewed | 3 |

## Scoring

Deterministic, and deliberately independent of the pipelines' own checks — a pipeline
cannot score well by trusting itself.

| Metric | Definition |
| --- | --- |
| `grnd` | Share of cards whose definition's content words appear in the source. This is the hallucination measure. |
| `cov` | Share of the case's listed concepts that some card actually teaches, keyword-verified |
| `front` | Share of terms that are 1–5 words, as a card front should be |
| `trap` | Count of planted prior-knowledge phrases that leaked into any card |
| `secs` | Wall clock per case |

`acc` combines them: `0.4·grnd + 0.4·cov + 0.2·front − 0.05·traps − 0.25·failures`.
Accuracy decides; speed is the tiebreak.

## The cases

Four fixtures in [`cases.json`](cases.json), each written so prior knowledge is a liability:

- **paper-unexpanded-acronyms** — `URTC` is expanded in the text and must be used; `MPC` and
  `SBR` are never expanded, so inventing an expansion is a failure.
- **biology-dense** — ten concepts of ordinary factual prose; mainly a recall test.
- **redefined-terms** — a warehouse glossary that redefines *bank*, *transformer*, *memory*,
  *kernel*, *harvest*, and *golden hour* against their everyday meanings.
- **figures-and-dates** — an invented freight levy with specific numbers, where a model
  leaning on priors drifts toward real-world congestion-charge figures.

## Result

`qwen3:8b` via Ollama, four cases, `--chunk 700` to force multi-chunk behaviour:

| pipeline | grnd | cov | secs | calls/chunk |
| --- | --- | --- | --- | --- |
| **grounded** | 94% | 90% | **24** | 1 |
| single | 94% | 90% | 23 | 1 |
| grounded-review | 94% | 90% | 73 | 2 |
| review-only | 94% | 90% | 128¹ | 2 |
| outline-first | 80% | 91% | 65 | 2 |

¹ inflated by one 402s outlier, most likely a model reload; the other three cases averaged 37s.

**`grounded` is the default.** The checked and unchecked variants returned identical
per-case scores — 92/100/100/83 groundedness and 88/100/100/71 coverage — so the reviewer
pass tripled runtime without moving a single number. `outline-first` was actively worse:
it produced more cards (17 vs 12 on the acronym paper) at much lower fidelity, which is
what happens when a model defines a term list without re-reading the source.

The one gap worth having is `single` vs `grounded`: the evidence check costs about a
second and is the only thing standing between a deck and an unsupported definition.

**What this result does not say.** The benchmark cannot see the reviewer's value, because
its fixtures are clean self-contained prose where the writer does not drift — the evidence
check dropped nothing on any case. On real coursework the reviewer does rewrite cards (2 on
a conference paper, 4 on a lecture PDF, 2 on a slide deck). But "fixed" is not "improved",
and nothing here verifies those rewrites were better. `grounded-review` stays available for
messy material; it just cannot justify being the default on this evidence.

## Honest limitations

- **Traps never fired.** No pipeline, including the unchecked `single` baseline, emitted any
  of the planted phrases. The forbidden strings are specific, and a drifting model tends to
  produce vaguer wording rather than those exact phrases. `grnd` turned out to be the metric
  that actually separates the pipelines, so the trap list currently earns its keep as a
  regression guard rather than as a discriminator.
- **One model.** Results are for `qwen3:8b`. A larger or hosted model may reorder them —
  in particular, review passes should matter more where the writer is weaker, and less
  where it is stronger.
- **Small fixtures.** The cases are a few thousand characters. `--chunk` is what forces
  multi-chunk behaviour; at default chunk sizes every case fits in one call and the
  pipelines become nearly indistinguishable, which is what the first run showed.
- **Single run per cell.** Temperature is 0, but decoding is not perfectly deterministic
  across runs, and differences under about two points should not be read as real.
