import { completeJson, type JsonSchema, type LlmConfig, type Part } from "./llm";
import { reviewCards } from "./verify";
import { addCards, newDeck, type Deck } from "./dedupe";
import { shapeCard, type CardStyle, type Difficulty } from "./style";
import type { Card } from "./duplex";

/**
 * Alternative arrangements of the writer/checker/reviewer roles. They exist so the
 * choice between them can be measured rather than asserted — see bench/README.md for
 * the numbers that picked the default.
 */

export type Progress = {
  phase: "reading" | "checking";
  done: number;
  total: number;
  cards: number;
};

export type PipelineCtx = {
  cfg: LlmConfig;
  /** Section text, already cleaned and chunked. */
  chunks: string[];
  /** Document context prepended to every call. */
  context: string;
  /** "ACR = Expansion" pairs from the document, used to fold acronym duplicates. */
  glossary: string[];
  maxCards: number;
  /** Card shape and difficulty. Both default to what the app shipped with. */
  style?: CardStyle;
  difficulty?: Difficulty;
  /** Sections in flight at once. 1 for a local model, which serializes anyway. */
  concurrency?: number;
  /**
   * Results of sections already written, so a run that died partway can be
   * finished instead of started again. Supplied by the route; the pipelines
   * neither know nor care where it is kept.
   */
  sectionCache?: {
    get: (chunk: string) => { cards: Card[]; dropped: number; fixed: number } | null;
    put: (chunk: string, result: { cards: Card[]; dropped: number; fixed: number }) => void;
  };
  onProgress: (p: Progress) => void;
  /**
   * Cards accepted into the deck, handed over section by section as they are
   * written. Only what survived the evidence check, dedupe and the card cap, so
   * the batches concatenate to exactly the deck returned at the end.
   */
  onCards?: (cards: Card[]) => void;
};

export type PipelineResult = {
  cards: Card[];
  dropped: number;
  fixed: number;
  /** Cards discarded for repeating a term or restating a definition. */
  duplicates: number;
};

export type Pipeline = {
  id: string;
  label: string;
  description: string;
  run: (ctx: PipelineCtx) => Promise<PipelineResult>;
};

const STYLE_RULES: Record<CardStyle, string> = {
  definition: `Rules for every card:
- "term" is only the thing being learned: a term, name, concept, formula name, date, or event. 1 to 5 words. Never a sentence, never a question, no trailing punctuation, and never any part of the definition.
- "definition" carries all the substance: 1 to 3 sentences, under 45 words, understandable without seeing the term, and faithful to how this document uses it.
- One card per distinct idea worth memorizing. Skip title slides, agendas, page numbers, and citations.
- No duplicate terms.`,

  question: `You are writing QUESTION cards, not definitions.

Rules for every card:
- "term" is a question the source answers. It must end in a question mark, stand on its own without the answer, and be under 20 words. Ask what the source explains — how something works, why it happens, what distinguishes two things, what a figure means.
- "definition" is the answer: 1 to 3 sentences, under 45 words, drawn only from the source.
- Never ask a question the source does not answer, and never ask one whose answer is only "yes" or "no".
- One card per distinct idea worth knowing. Skip title slides, agendas, page numbers, and citations.
- No two questions that test the same fact.`,

};

const DIFFICULTY_RULES: Record<Difficulty, string> = {
  intro: `Aim at someone meeting this material for the first time. Favour the core vocabulary and the central ideas: what things are, what they do, and the headline figures. Prefer plain wording over the source's most technical phrasing, while keeping every claim faithful to it.`,
  exam: `Aim at someone who has already read this and is being examined on it. Favour what is actually tested: mechanisms and the order of steps, conditions and exceptions, the distinctions between things that are easily confused, exact figures and their units, and the reasoning behind a result rather than the result alone. Skip the material a first reading already makes obvious.`,
};

const WRITER_RULES = `Rules for every card:
- "term" is only the thing being learned: a term, name, concept, formula name, date, or event. 1 to 5 words. Never a sentence, never a question, no trailing punctuation, and never any part of the definition.
- "definition" carries all the substance: 1 to 3 sentences, under 45 words, understandable without seeing the term, and faithful to how this document uses it.
- One card per distinct idea worth memorizing. Skip title slides, agendas, page numbers, and citations.
- No duplicate terms.`;

const GROUNDING_RULE = `THE GROUNDING RULE, which overrides everything else:
Every definition must come from THIS document and nothing else. You are not being asked what a term means in general — you are being asked what it means in this text. The same acronym or phrase means different things in different fields, and your prior knowledge of it is almost certainly wrong here.
- Never expand an acronym unless the expansion appears in the document. If the text doesn't expand it, describe how the document uses it instead.
- Never define a term using outside knowledge, even when you are confident.
- If the document uses a term but never explains it, do not make a card for it.
- "evidence" must be a short span copied word-for-word from the text above that states what you wrote. If you cannot copy such a span, do not emit that card.`;

export const WRITER_SYSTEM = `You write study flashcards from a source document. You reply with JSON only — no commentary, no markdown fences.

Reply with exactly this shape:
{"cards":[{"term":"...","definition":"...","evidence":"..."}]}

${GROUNDING_RULE}

${WRITER_RULES}`;

/** The writer prompt for a chosen card shape and difficulty. */
export function writerSystem(style: CardStyle, difficulty: Difficulty): string {
  return `You write study flashcards from a source document. You reply with JSON only — no commentary, no markdown fences.

Reply with exactly this shape:
{"cards":[{"term":"...","definition":"...","evidence":"..."}]}

${GROUNDING_RULE}

${STYLE_RULES[style]}

WHO THIS IS FOR:
${DIFFICULTY_RULES[difficulty]}`;
}

const sectionPrompt = (part: number, total: number) =>
  total > 1
    ? `Make flashcards from section ${part} of ${total} of the material above. Cover only what this section contains.`
    : `Make flashcards from the material above.`;

function partsFor(chunk: string, context: string, instruction: string): Part[] {
  return [
    ...(context ? [{ type: "text" as const, text: context }] : []),
    { type: "text" as const, text: `SOURCE TEXT:\n${chunk}` },
    { type: "text" as const, text: instruction },
  ];
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Does the model's quoted evidence actually appear in what it was shown? Exact match
 * after normalization, with a word-overlap fallback for models that mangle quotes
 * slightly. Invented content — an acronym expanded from prior knowledge, say — shares
 * almost no vocabulary with the source and fails either way.
 */
export function isGrounded(evidence: string, haystack: string): boolean {
  const needle = normalizeForMatch(evidence);
  if (needle.length < 12) return false;
  const hay = normalizeForMatch(haystack);
  if (hay.includes(needle)) return true;

  const words = needle.split(" ").filter((w) => w.length > 3);
  if (words.length < 3) return false;
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.85;
}

/**
 * Pull well-formed cards out of a model response. When `haystack` is given, keep only
 * those whose quoted evidence really appears in what the model was shown.
 */
export function harvest(
  raw: unknown,
  haystack: string | null,
  style: CardStyle = "definition"
): { cards: Card[]; dropped: number } {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { cards?: unknown })?.cards)
      ? (raw as { cards: unknown[] }).cards
      : [];

  const cards: Card[] = [];
  let dropped = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const term = String((item as Card).term ?? "").replace(/\s+/g, " ").trim();
    const definition = String((item as Card).definition ?? "").replace(/\s+/g, " ").trim();
    const evidence = String((item as Card).evidence ?? "").replace(/\s+/g, " ").trim();
    if (!term || !definition) continue;

    if (haystack !== null && !isGrounded(evidence, haystack)) {
      dropped++;
      continue;
    }
    const shaped = shapeCard({ term, definition, evidence }, style);
    if (!shaped) {
      dropped++;
      continue;
    }
    cards.push(shaped);
  }
  return { cards, dropped };
}

/** Add to the deck, dropping anything that repeats a term or restates a definition. */
export function mergeInto(deck: Deck, cards: Card[], maxCards: number): number {
  return addCards(deck, cards, maxCards);
}

/**
 * How many chunks to have in flight at once.
 *
 * Ollama serializes requests per model — measured while benchmarking the
 * ensemble pipeline: 1081s concurrently against 439s sequentially — so asking
 * for parallelism there buys nothing and makes the requests contend. Hosted
 * providers have no such limit, so a cloud run goes several times faster.
 */
export function concurrencyFor(provider: string): number {
  return provider === "ollama" ? 1 : 4;
}

/**
 * Walk the chunks, letting the caller decide what happens to each chunk's cards.
 *
 * Exported for `test/stream.test.mjs`, which drives it with a canned handler to
 * check the streaming contract without going near a model.
 */
export async function overChunks(
  ctx: PipelineCtx,
  handle: (chunk: string, shown: string, index: number, soFar: number) => Promise<{
    cards: Card[];
    dropped: number;
    fixed: number;
  }>
): Promise<PipelineResult> {
  const deck = newDeck(ctx.glossary);
  let dropped = 0;
  let fixed = 0;
  let duplicates = 0;

  const lanes = Math.max(1, Math.min(ctx.concurrency ?? 1, ctx.chunks.length));

  /**
   * A section, from the cache if it is already written. A hit skips the model
   * entirely, so it also skips the progress the handler would have reported —
   * hence reporting it here, or the page would sit still through the fast part.
   */
  const section = async (chunk: string, shown: string, i: number, soFar: number) => {
    const cached = ctx.sectionCache?.get(chunk);
    if (cached) {
      ctx.onProgress({ phase: "reading", done: i, total: ctx.chunks.length, cards: soFar });
      return cached;
    }
    const result = await handle(chunk, shown, i, soFar);
    ctx.sectionCache?.put(chunk, result);
    return result;
  };

  /** Fold one finished section into the deck, in section order. */
  const absorb = (result: { cards: Card[]; dropped: number; fixed: number }) => {
    dropped += result.dropped;
    fixed += result.fixed;
    // Counted separately from `dropped`: a repeat isn't a grounding failure.
    const before = deck.cards.length;
    duplicates += mergeInto(deck, result.cards, ctx.maxCards);
    // Hand over what was actually kept, not what the model returned. The page
    // appends these verbatim, so a rejected card must never reach it.
    if (deck.cards.length > before) ctx.onCards?.(deck.cards.slice(before));
  };

  if (lanes === 1) {
    for (let i = 0; i < ctx.chunks.length; i++) {
      const chunk = ctx.chunks[i];
      const shown = `${ctx.context}\n${chunk}`;
      absorb(await section(chunk, shown, i, deck.cards.length));
      if (deck.cards.length >= ctx.maxCards) break;
    }
    return { cards: deck.cards, dropped, fixed, duplicates };
  }

  // Several sections at once, but merged strictly in order: dedupe keeps the
  // first card it sees, so letting completion order decide would make the same
  // document give different decks on different days.
  for (let start = 0; start < ctx.chunks.length; start += lanes) {
    const batch = ctx.chunks.slice(start, start + lanes);
    const soFar = deck.cards.length;
    const results = await Promise.all(
      batch.map((chunk, n) => section(chunk, `${ctx.context}\n${chunk}`, start + n, soFar))
    );
    for (const result of results) absorb(result);
    if (deck.cards.length >= ctx.maxCards) break;
  }
  return { cards: deck.cards, dropped, fixed, duplicates };
}

function systemFor(ctx: PipelineCtx): string {
  return writerSystem(ctx.style ?? "definition", ctx.difficulty ?? "intro");
}

async function write(ctx: PipelineCtx, chunk: string, index: number): Promise<unknown> {
  return completeJson(
    ctx.cfg,
    systemFor(ctx),
    partsFor(chunk, ctx.context, sectionPrompt(index + 1, ctx.chunks.length))
  );
}

/** 1. Writer alone — whatever the model says, kept as-is. */
const single: Pipeline = {
  id: "single",
  label: "Writer only",
  description: "One call per section. No checking of any kind.",
  run: (ctx) =>
    overChunks(ctx, async (chunk, _shown, i, soFar) => {
      ctx.onProgress({ phase: "reading", done: i, total: ctx.chunks.length, cards: soFar });
      const found = harvest(await write(ctx, chunk, i), null, ctx.style);
      return { ...found, fixed: 0 };
    }),
};

/** 2. Writer plus the deterministic quote check. No second model call. */
const grounded: Pipeline = {
  id: "grounded",
  label: "Writer + evidence check",
  description: "Cards must quote the source; the quote is verified in code.",
  run: (ctx) =>
    overChunks(ctx, async (chunk, shown, i, soFar) => {
      ctx.onProgress({ phase: "reading", done: i, total: ctx.chunks.length, cards: soFar });
      const found = harvest(await write(ctx, chunk, i), shown, ctx.style);
      return { ...found, fixed: 0 };
    }),
};

/** 3. Writer, quote check, then a reviewer that repairs or drops each card. */
const groundedReview: Pipeline = {
  id: "grounded-review",
  label: "Writer + evidence check + reviewer",
  description: "Adds a second model pass that judges each definition against the source.",
  run: (ctx) =>
    overChunks(ctx, async (chunk, shown, i, soFar) => {
      ctx.onProgress({ phase: "reading", done: i, total: ctx.chunks.length, cards: soFar });
      const found = harvest(await write(ctx, chunk, i), shown, ctx.style);
      if (!found.cards.length) return { ...found, fixed: 0 };

      ctx.onProgress({ phase: "checking", done: i, total: ctx.chunks.length, cards: soFar });
      const reviewed = await reviewCards(ctx.cfg, shown, found.cards);
      return {
        cards: reviewed.cards,
        dropped: found.dropped + reviewed.dropped,
        fixed: reviewed.fixed,
      };
    }),
};

/** 4. Writer plus reviewer, with no deterministic check between them. */
const reviewOnly: Pipeline = {
  id: "review-only",
  label: "Writer + reviewer",
  description: "Two model passes, but nothing verifies the quotes mechanically.",
  run: (ctx) =>
    overChunks(ctx, async (chunk, shown, i, soFar) => {
      ctx.onProgress({ phase: "reading", done: i, total: ctx.chunks.length, cards: soFar });
      const found = harvest(await write(ctx, chunk, i), null, ctx.style);
      if (!found.cards.length) return { ...found, fixed: 0 };

      ctx.onProgress({ phase: "checking", done: i, total: ctx.chunks.length, cards: soFar });
      const reviewed = await reviewCards(ctx.cfg, shown, found.cards);
      return {
        cards: reviewed.cards,
        dropped: found.dropped + reviewed.dropped,
        fixed: reviewed.fixed,
      };
    }),
};

const TERMS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    terms: {
      type: "array",
      items: { type: "string", description: "A term the section explains. 1-5 words." },
    },
  },
  required: ["terms"],
};

const TERMS_SYSTEM = `You list the concepts a section of a document teaches. Reply with JSON only: {"terms":["...","..."]}.

List only terms, names, or concepts that this text actually explains — never something it merely mentions, and never a term you know from elsewhere. 1 to 5 words each, no sentences, no duplicates.`;

const DEFINE_SYSTEM = `You define terms strictly from a source document. You reply with JSON only — no commentary.

Reply with exactly this shape:
{"cards":[{"term":"...","definition":"...","evidence":"..."}]}

You are given a list of terms. Define each one using only the source text above. Drop any term the source does not actually explain.

${GROUNDING_RULE}

${WRITER_RULES}`;

/** 5. Decide what to learn first, then define those terms — decomposition instead of review. */
const outlineFirst: Pipeline = {
  id: "outline-first",
  label: "Term list, then define",
  description: "First pass names the concepts, second defines them, then the evidence check.",
  run: (ctx) =>
    overChunks(ctx, async (chunk, shown, i, soFar) => {
      ctx.onProgress({ phase: "reading", done: i, total: ctx.chunks.length, cards: soFar });
      const listed = await completeJson(
        ctx.cfg,
        TERMS_SYSTEM,
        partsFor(chunk, ctx.context, "List the concepts this section explains."),
        TERMS_SCHEMA,
        "emit_terms"
      );
      const terms = (((listed as { terms?: unknown })?.terms ?? []) as unknown[])
        .map((t) => String(t ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 25);
      if (!terms.length) return { cards: [], dropped: 0, fixed: 0 };

      ctx.onProgress({ phase: "checking", done: i, total: ctx.chunks.length, cards: soFar });
      const defined = await completeJson(
        ctx.cfg,
        DEFINE_SYSTEM,
        partsFor(chunk, ctx.context, `Define these terms:\n${terms.map((t) => `- ${t}`).join("\n")}`)
      );
      const found = harvest(defined, shown, ctx.style);
      return { ...found, fixed: 0 };
    }),
};

const ALT_WRITER_NOTE =
  "Work through the section from beginning to end and favour the concepts a student would be tested on, including any that a first reading would skip over.";

/** 6. Two writers with different framings, merged, then checked and reviewed. */
const ensemble: Pipeline = {
  id: "ensemble",
  label: "Two writers + evidence check + reviewer",
  description: "Two differently-framed writer passes are merged before checking.",
  run: (ctx) =>
    overChunks(ctx, async (chunk, shown, i, soFar) => {
      ctx.onProgress({ phase: "reading", done: i, total: ctx.chunks.length, cards: soFar });
      const instruction = sectionPrompt(i + 1, ctx.chunks.length);
      // Sequential on purpose. A local server runs one request per model at a time, so
      // issuing both at once buys no parallelism and makes them contend: 1081s per case
      // concurrently against 439s sequentially. Even sequential this is 18x `grounded`,
      // which is why the extra coverage it buys isn't the default.
      const a = await completeJson(ctx.cfg, systemFor(ctx), partsFor(chunk, ctx.context, instruction));
      const b = await completeJson(
        ctx.cfg,
        `${systemFor(ctx)}\n\n${ALT_WRITER_NOTE}`,
        partsFor(chunk, ctx.context, instruction)
      );

      const first = harvest(a, shown, ctx.style);
      const second = harvest(b, shown, ctx.style);
      const pool = newDeck(ctx.glossary);
      mergeInto(pool, [...first.cards, ...second.cards], ctx.maxCards);
      const pooled = pool.cards;
      if (!pooled.length) {
        return { cards: [], dropped: first.dropped + second.dropped, fixed: 0 };
      }

      ctx.onProgress({ phase: "checking", done: i, total: ctx.chunks.length, cards: soFar });
      const reviewed = await reviewCards(ctx.cfg, shown, pooled);
      return {
        cards: reviewed.cards,
        dropped: first.dropped + second.dropped + reviewed.dropped,
        fixed: reviewed.fixed,
      };
    }),
};

export const PIPELINES: Record<string, Pipeline> = {
  [single.id]: single,
  [grounded.id]: grounded,
  [groundedReview.id]: groundedReview,
  [reviewOnly.id]: reviewOnly,
  [outlineFirst.id]: outlineFirst,
  [ensemble.id]: ensemble,
};

/**
 * Chosen by measurement, not preference — see bench/README.md.
 *
 * `grounded` matched every checked and unchecked variant on accuracy across the whole
 * benchmark while costing one model call per chunk instead of two, so the reviewer pass
 * tripled runtime without moving any score. The evidence check itself is worth its ~1s:
 * it is the only thing between a card and an unsupported definition.
 *
 * `grounded-review` remains the better choice on messy source material, where the
 * reviewer does rewrite cards — it just isn't measurable on the benchmark's clean prose.
 */
export const DEFAULT_PIPELINE = "grounded";

export function pipelineFor(id: string | null | undefined): Pipeline {
  return PIPELINES[id ?? ""] ?? PIPELINES[DEFAULT_PIPELINE];
}
