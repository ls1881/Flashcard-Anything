import type { Card } from "./duplex";

/**
 * Deck storage in IndexedDB.
 *
 * A deck lives in the browser and nowhere else. IndexedDB rather than
 * localStorage because a textbook run is megabytes of cards, past the ~5MB
 * string quota; SQLite behind an API only earns its complexity once decks need
 * to follow you to another device.
 *
 * Every call here can reject — private windows and locked-down browsers refuse
 * to open a database at all. Callers treat that as "no saved decks" and carry
 * on in memory, the same way blocked settings storage falls back to defaults.
 */

export type DeckModel = { provider: string; name: string };

/** What the deck list needs, without paying for every card in every deck. */
export type DeckMeta = {
  id: string;
  name: string;
  source: string | null;
  scope: string | null;
  model: DeckModel | null;
  count: number;
  createdAt: number;
  updatedAt: number;
};

export type Deck = DeckMeta & {
  cards: Card[];
  /**
   * The cleaned text the cards were written from, kept so a single card can be
   * regenerated later. The uploaded file is long gone by then — extraction
   * happened on the server and the File object dies with the page — so without
   * this, regenerating would have nothing to read. Decks made before this
   * existed have none, and regenerate says so rather than inventing.
   */
  sourceText: string | null;
};

export const PASTED = "pasted text";

const DB_NAME = "flashcard-anything";
const DB_VERSION = 1;
const STORE = "decks";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Whether this browser will let us store anything at all. */
export function available(): boolean {
  return typeof globalThis.indexedDB !== "undefined";
}

/**
 * A name you would recognize in a list a week later: the file it came from,
 * narrowed by the scope you asked for. Pasted text has no name of its own, so
 * it falls back to the day.
 */
export function deckName(
  source: string | null,
  scope: string | null,
  now: Date = new Date()
): string {
  const base =
    source && source !== PASTED ? source.replace(/\.[^.]+$/, "").trim() : "";
  const part = scope?.trim() ?? "";
  if (base && part) return `${base} — ${part}`;
  if (base) return base;
  if (part) return part;
  return `Pasted text — ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

/** Relative for the recent past, absolute once "days ago" stops being useful. */
export function formatWhen(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const then = new Date(ts);
  return `${MONTHS[then.getMonth()]} ${then.getDate()}`;
}

/** A deck name reduced to something safe to hand a file system. */
export function deckSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    // Accents, punctuation and emoji all go; what's left is filename-safe.
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return slug || "flashcards";
}

export function exportFileName(name: string): string {
  return `${deckSlug(name)}.flashcards.json`;
}

/** The Anki package name for a deck. */
export function ankiFileName(name: string): string {
  return `${deckSlug(name)}.apkg`;
}

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** A fresh deck from a finished run. */
export function newDeck(input: {
  cards: Card[];
  source: string | null;
  scope: string | null;
  model: DeckModel | null;
  sourceText?: string | null;
  name?: string;
  now?: number;
}): Deck {
  const at = input.now ?? Date.now();
  return {
    id: newId(),
    name: input.name?.trim() || deckName(input.source, input.scope, new Date(at)),
    source: input.source,
    scope: input.scope,
    model: input.model,
    cards: input.cards,
    sourceText: input.sourceText ?? null,
    count: input.cards.length,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Swap one card, leaving the rest of the deck alone. Out-of-range indexes are
 * ignored rather than appending: the caller is editing a card that is on screen,
 * and a stale index means the deck moved under it.
 */
export function replaceCard(
  deck: Deck,
  index: number,
  card: Card,
  now: number = Date.now()
): Deck {
  if (!Number.isInteger(index) || index < 0 || index >= deck.cards.length) return deck;
  const term = card.term.replace(/\s+/g, " ").trim();
  const definition = card.definition.replace(/\s+/g, " ").trim();
  // A card with no front or no back isn't a card; keep what was there.
  if (!term || !definition) return deck;

  const cards = deck.cards.map((existing, i) =>
    i === index ? { ...existing, term, definition, ...(card.evidence !== undefined ? { evidence: card.evidence } : {}) } : existing
  );
  return { ...deck, cards, updatedAt: now };
}

/**
 * Trust nothing read back from disk. A deck written by an older version can be
 * missing fields, and a half-written one can be missing its cards; a deck we
 * cannot repair into something renderable is dropped rather than crashing the
 * list.
 */
export function normalizeDeck(raw: unknown): Deck | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) return null;

  const cards = Array.isArray(d.cards)
    ? (d.cards.filter(
        (c) =>
          c && typeof c === "object" &&
          typeof (c as Card).term === "string" &&
          typeof (c as Card).definition === "string"
      ) as Card[])
    : [];

  const createdAt = typeof d.createdAt === "number" ? d.createdAt : 0;
  const updatedAt = typeof d.updatedAt === "number" ? d.updatedAt : createdAt;
  const model =
    d.model && typeof d.model === "object" &&
    typeof (d.model as DeckModel).provider === "string" &&
    typeof (d.model as DeckModel).name === "string"
      ? (d.model as DeckModel)
      : null;

  return {
    id: d.id,
    name: typeof d.name === "string" && d.name.trim() ? d.name : "Untitled deck",
    source: typeof d.source === "string" ? d.source : null,
    scope: typeof d.scope === "string" ? d.scope : null,
    model,
    cards,
    sourceText: typeof d.sourceText === "string" && d.sourceText ? d.sourceText : null,
    // Recomputed, never trusted: a stale count would misreport the list.
    count: cards.length,
    createdAt,
    updatedAt,
  };
}

/**
 * Metadata only — used for the deck list, so the cards and the source text can
 * stay on disk. The source text is the larger of the two; carrying it into a
 * list of twenty decks would be the whole point of the summary thrown away.
 */
export function summarize(deck: Deck): DeckMeta {
  const { cards: _cards, sourceText: _sourceText, ...meta } = deck;
  return meta;
}

/** Most recently touched first; ties broken by id so the order never flickers. */
export function sortDecks<T extends { updatedAt: number; id: string }>(decks: T[]): T[] {
  return [...decks].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  );
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.reject(new Error("This browser has no IndexedDB."));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open the deck store."));
    req.onblocked = () => reject(new Error("The deck store is busy in another tab."));
  }).catch((e) => {
    // Don't cache a failure: a later call may succeed once the tab is unblocked.
    dbPromise = null;
    throw e;
  });

  return dbPromise;
}

/** Reset the cached handle. Tests use this to start from a clean database. */
export function closeDb(): void {
  const pending = dbPromise;
  dbPromise = null;
  pending?.then((d) => d.close()).catch(() => {});
}

function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        let result: T;
        req.onsuccess = () => {
          result = req.result as T;
        };
        // Resolve on the transaction, not the request: a write isn't durable
        // until the transaction commits.
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? new Error("The write was aborted."));
      })
  );
}

export async function listDecks(): Promise<DeckMeta[]> {
  const rows = await run<unknown[]>("readonly", (s) => s.getAll());
  const decks = rows.map(normalizeDeck).filter((d): d is Deck => d !== null);
  return sortDecks(decks.map(summarize));
}

export async function getDeck(id: string): Promise<Deck | null> {
  const row = await run<unknown>("readonly", (s) => s.get(id));
  return normalizeDeck(row);
}

export async function putDeck(deck: Deck): Promise<Deck> {
  // count and cards are written together so they can never disagree.
  const record: Deck = { ...deck, count: deck.cards.length };
  await run("readwrite", (s) => s.put(record));
  return record;
}

/** Blank or unchanged names are ignored rather than stored. */
export async function renameDeck(
  id: string,
  name: string,
  now: number = Date.now()
): Promise<Deck | null> {
  const deck = await getDeck(id);
  if (!deck) return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === deck.name) return deck;
  return putDeck({ ...deck, name: trimmed, updatedAt: now });
}

export async function deleteDeck(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}
