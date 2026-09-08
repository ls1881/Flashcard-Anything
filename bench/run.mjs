#!/usr/bin/env node
/**
 * Benchmarks the pipelines in lib/pipelines.ts against bench/cases.json.
 *
 * Scoring is deterministic and independent of the pipelines' own checks, so a pipeline
 * cannot score well by trusting itself:
 *
 *   grounded   share of cards whose definition's content words appear in the source
 *   traps      count of planted prior-knowledge phrases that leaked in (lower is better)
 *   coverage   share of the case's key concepts that some card actually teaches
 *   fronts     share of terms that are 1-5 words, as a card front should be
 *   seconds    wall clock
 *
 * Usage: node bench/run.mjs [--port 3000] [--model qwen3:8b] [--pipelines a,b,c]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const PORT = args.port ?? "3000";
const MODEL = args.model ?? "qwen3:8b";
const PROVIDER = args.provider ?? "ollama";
const CASES = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const CHUNK = args.chunk ?? "";
const PIPELINES = (args.pipelines ?? "single,grounded,grounded-review,review-only,outline-first,ensemble").split(",");

const STOP = new Set(
  ("the a an of to in and or is are was were be been being that this these those it its for on at by with as from " +
   "which who whom whose what when where why how not no nor but if then than so such can could may might will would " +
   "shall should must do does did done have has had having there here their they them he she his her you your we our " +
   "one two three each every any all both few more most other some only own same too very s t").split(" ")
);

const words = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** A definition is grounded if nearly all its content words occur in the source. */
function grounded(definition, sourceWords) {
  const w = words(definition);
  if (!w.length) return false;
  const hits = w.filter((x) => sourceWords.has(x)).length;
  return hits / w.length >= 0.75;
}

function scoreCase(testCase, cards) {
  const sourceWords = new Set(words(testCase.text));
  const blob = cards.map((c) => `${c.term} ${c.definition}`.toLowerCase()).join(" | ");

  const groundedCount = cards.filter((c) => grounded(c.definition, sourceWords)).length;
  const trapHits = testCase.forbidden.filter((f) => blob.includes(f.toLowerCase()));
  const covered = testCase.concepts.filter((concept) => {
    const match = cards.find((c) => {
      const text = `${c.term} ${c.definition}`.toLowerCase();
      return text.includes(concept.name.toLowerCase());
    });
    if (!match) return false;
    const text = `${match.term} ${match.definition}`.toLowerCase();
    return concept.keywords.some((k) => text.includes(k.toLowerCase()));
  });
  const goodFronts = cards.filter((c) => {
    const n = c.term.trim().split(/\s+/).length;
    return n >= 1 && n <= 5;
  }).length;

  return {
    cards: cards.length,
    grounded: cards.length ? groundedCount / cards.length : 0,
    traps: trapHits.length,
    trapList: trapHits,
    coverage: covered.length / testCase.concepts.length,
    fronts: cards.length ? goodFronts / cards.length : 0,
  };
}

async function generate(testCase, pipeline) {
  const body = new FormData();
  body.append("text", testCase.text);
  body.append("provider", PROVIDER);
  body.append("model", MODEL);
  body.append("pipeline", pipeline);
  if (CHUNK) body.append("chunkChars", CHUNK);

  const started = Date.now();
  let res;
  let text;
  try {
    res = await fetch(`http://localhost:${PORT}/api/generate`, { method: "POST", body });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { error: data.error ?? `HTTP ${res.status}`, seconds: (Date.now() - started) / 1000 };
    }
    text = await res.text();
  } catch (err) {
    // A slow local generation can exceed Node's 300s header timeout. Record the cell as a
    // failure rather than losing every result collected so far.
    return {
      error: `${err.cause?.code ?? err.name}: ${err.message}`,
      seconds: (Date.now() - started) / 1000,
    };
  }
  let cards = null;
  let error = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "result") cards = msg.cards;
    if (msg.type === "error") error = msg.error;
  }
  return { cards, error, seconds: (Date.now() - started) / 1000 };
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;

const results = {};
for (const pipeline of PIPELINES) {
  results[pipeline] = [];
  for (const testCase of CASES) {
    process.stderr.write(`  ${pipeline} / ${testCase.id} … `);
    const { cards, error, seconds } = await generate(testCase, pipeline);
    if (error || !cards) {
      process.stderr.write(`FAILED (${error})\n`);
      results[pipeline].push({ id: testCase.id, failed: true, seconds, error });
      continue;
    }
    const score = scoreCase(testCase, cards);
    process.stderr.write(
      `${score.cards} cards, grounded ${pct(score.grounded)}, coverage ${pct(score.coverage)}, traps ${score.traps}, ${seconds.toFixed(0)}s\n`
    );
    results[pipeline].push({ id: testCase.id, seconds, ...score });
  }
}

const summary = Object.entries(results).map(([pipeline, runs]) => {
  const ok = runs.filter((r) => !r.failed);
  const avg = (f) => (ok.length ? ok.reduce((s, r) => s + f(r), 0) / ok.length : 0);
  return {
    pipeline,
    failures: runs.length - ok.length,
    cards: avg((r) => r.cards).toFixed(1),
    grounded: avg((r) => r.grounded),
    coverage: avg((r) => r.coverage),
    fronts: avg((r) => r.fronts),
    traps: ok.reduce((s, r) => s + r.traps, 0),
    seconds: avg((r) => r.seconds),
    trapList: [...new Set(ok.flatMap((r) => r.trapList ?? []))],
  };
});

// Accuracy first, then speed as the tiebreak.
for (const row of summary) {
  row.accuracy = row.grounded * 0.4 + row.coverage * 0.4 + row.fronts * 0.2 - row.traps * 0.05 - row.failures * 0.25;
}
summary.sort((a, b) => b.accuracy - a.accuracy);

console.log(`\nmodel: ${MODEL} via ${PROVIDER}   cases: ${CASES.length}   chunkChars: ${CHUNK || "default"}\n`);
console.log(
  ["pipeline", "acc", "grnd", "cov", "front", "trap", "fail", "cards", "secs"]
    .map((h, i) => (i === 0 ? h.padEnd(22) : h.padStart(7)))
    .join("")
);
for (const r of summary) {
  console.log(
    r.pipeline.padEnd(22) +
      r.accuracy.toFixed(2).padStart(7) +
      pct(r.grounded).padStart(7) +
      pct(r.coverage).padStart(7) +
      pct(r.fronts).padStart(7) +
      String(r.traps).padStart(7) +
      String(r.failures).padStart(7) +
      String(r.cards).padStart(7) +
      r.seconds.toFixed(0).padStart(7)
  );
}
const trapped = summary.filter((r) => r.trapList.length);
if (trapped.length) {
  console.log("\nprior-knowledge phrases that leaked in:");
  for (const r of trapped) console.log(`  ${r.pipeline}: ${r.trapList.join(", ")}`);
}
console.log(`\nwinner: ${summary[0].pipeline}\n`);
console.log(JSON.stringify({ model: MODEL, summary }, null, 2));
