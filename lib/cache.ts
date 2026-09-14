import { createHash } from "node:crypto";
import type { Card } from "./duplex";

/**
 * Cached results, keyed by what actually determines them.
 *
 * Generation is the slow part of this app by orders of magnitude — minutes on a
 * local model — and rerunning the same chapter with the same settings is a
 * thing people do constantly: they print, notice a typo in the scope, come
 * back. Everything the key covers is an input to the deck, so a hit is the same
 * deck the model would have produced.
 *
 * In memory, not on disk: a dev server restart losing the cache costs one
 * regeneration, where a stale file on disk would cost trust in the results.
 */

export type CacheKeyInput = {
  text: string;
  scope: string;
  provider: string;
  model: string;
  pipeline: string;
  style: string;
  difficulty: string;
  chunkChars: number;
};

export type CachedRun = {
  cards: Card[];
  sourceText: string;
  scopeLabel: string | null;
  dropped: number;
  fixed: number;
  duplicates: number;
};

/**
 * Everything that changes the output goes in the key, so a hit cannot be wrong.
 * The source text is hashed rather than stored: a key holding a whole textbook
 * would cost more memory than the cards it points at.
 */
export function cacheKey(input: CacheKeyInput): string {
  const digest = createHash("sha256").update(input.text).digest("hex");
  return [
    digest,
    input.scope,
    input.provider,
    input.model,
    input.pipeline,
    input.style,
    input.difficulty,
    String(input.chunkChars),
  ].join(" ");
}

/** Enough for a study session; a deck is small next to the model that wrote it. */
const MAX_ENTRIES = 24;

const entries = new Map<string, CachedRun>();

export function getCached(key: string): CachedRun | null {
  const hit = entries.get(key);
  if (!hit) return null;
  // Least-recently-used: re-inserting moves it to the end of the iteration order.
  entries.delete(key);
  entries.set(key, hit);
  return hit;
}

export function putCached(key: string, run: CachedRun): void {
  if (!run.cards.length) return;
  entries.delete(key);
  entries.set(key, run);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** Test seam, and the thing to call if caching ever needs disabling by hand. */
export function clearCache(): void {
  entries.clear();
  chunks.clear();
}

export function cacheSize(): number {
  return entries.size;
}

/**
 * Per-section results, so an interrupted run can be finished rather than
 * restarted.
 *
 * A run that dies on section nine of ten has already paid for eight sections.
 * Keying on the section's own text means the retry reuses them without anyone
 * having to track "where was I" — and a document edited in the middle still
 * reruns only the sections that actually changed.
 */
export type ChunkResult = { cards: Card[]; dropped: number; fixed: number };

const chunks = new Map<string, ChunkResult>();
const MAX_CHUNKS_CACHED = 400;

export function chunkKey(settingsKey: string, chunk: string): string {
  return `${settingsKey} ${createHash("sha256").update(chunk).digest("hex")}`;
}

export function getChunk(key: string): ChunkResult | null {
  const hit = chunks.get(key);
  if (!hit) return null;
  chunks.delete(key);
  chunks.set(key, hit);
  return hit;
}

export function putChunk(key: string, result: ChunkResult): void {
  chunks.delete(key);
  chunks.set(key, result);
  while (chunks.size > MAX_CHUNKS_CACHED) {
    const oldest = chunks.keys().next();
    if (oldest.done) break;
    chunks.delete(oldest.value);
  }
}

export function chunkCacheSize(): number {
  return chunks.size;
}
