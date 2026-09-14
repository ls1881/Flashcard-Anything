/**
 * Locating a card inside the document it came from.
 *
 * Kept apart from `lib/regenerate.ts` because the page needs this too — showing
 * a reader the passage behind a card is a local lookup, not a server round
 * trip — and regenerate.ts reaches for the model, which cannot be imported into
 * a client bundle.
 */

export const WINDOW_RADIUS = 1500;

/**
 * Lowercase, with every run of non-alphanumerics collapsed to one space, plus a
 * map back to offsets in the original. Matching has to be done on the
 * normalized form — a model's quote differs from the source in whitespace and
 * punctuation far more often than in words — but any slice has to be cut from
 * the original text, so the mapping is what makes both possible.
 */
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i].toLowerCase();
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      if (pendingSpace && norm.length > 0) {
        norm += " ";
        map.push(i);
        pendingSpace = false;
      }
      norm += ch;
      map.push(i);
    } else {
      pendingSpace = true;
    }
  }
  return { norm, map };
}

/** Where a quote sits in the source, in original-string offsets. */
export function locateEvidence(
  text: string,
  evidence: string
): { start: number; end: number } | null {
  if (!text || !evidence) return null;
  const needle = normalizeWithMap(evidence).norm;
  if (needle.length < 12) return null;

  const hay = normalizeWithMap(text);
  const at = hay.norm.indexOf(needle);
  if (at === -1) return null;

  return {
    start: hay.map[at],
    end: hay.map[Math.min(at + needle.length - 1, hay.map.length - 1)] + 1,
  };
}

/**
 * The slice of the source a card came from: a window around its quoted
 * evidence. Sending a whole document back for one card would be slower, and on
 * a long document would push the real passage out of a small context window
 * entirely.
 *
 * Falls back to the opening of the document when the evidence can't be located
 * — a card with no usable quote still deserves an attempt, and the caller
 * checks the result against the source either way.
 */
export function sourceWindow(text: string, evidence: string, radius = WINDOW_RADIUS): string {
  if (!text) return "";
  if (text.length <= radius * 2) return text;

  const at = locateEvidence(text, evidence);
  if (at) {
    return text.slice(Math.max(0, at.start - radius), Math.min(text.length, at.end + radius));
  }
  return text.slice(0, radius * 2);
}

export type SourcePassage = {
  /** The passage, trimmed to whole words at both ends. */
  text: string;
  /** Offsets of the quote within `text`, or null when it couldn't be found. */
  highlight: { start: number; end: number } | null;
  /** True when the passage is the whole document rather than a slice of it. */
  whole: boolean;
};

/**
 * A readable passage around a card's evidence, for showing a reader where the
 * card came from. Shorter than the model's window — this is for eyes, not for a
 * context window — and cut at word boundaries so it doesn't start mid-word.
 */
export function passageFor(
  text: string,
  evidence: string,
  radius = 420
): SourcePassage | null {
  if (!text.trim()) return null;

  const at = locateEvidence(text, evidence ?? "");
  if (!at) {
    // No usable quote: show the opening rather than nothing, and say so by
    // leaving the highlight empty.
    const head = text.slice(0, radius * 2);
    return { text: trimToWords(head, text, 0), highlight: null, whole: head.length >= text.length };
  }

  const from = Math.max(0, at.start - radius);
  const to = Math.min(text.length, at.end + radius);
  const raw = text.slice(from, to);
  const lead = from === 0 ? 0 : leadingPartialWord(raw);
  const tail = to === text.length ? 0 : trailingPartialWord(raw);
  const sliced = raw.slice(lead, raw.length - tail);

  return {
    text: sliced,
    highlight: { start: at.start - from - lead, end: at.end - from - lead },
    whole: from === 0 && to === text.length,
  };
}

function leadingPartialWord(s: string): number {
  const m = /^\S+\s/.exec(s);
  return m ? m[0].length : 0;
}

function trailingPartialWord(s: string): number {
  const m = /\s\S+$/.exec(s);
  return m ? m[0].length : 0;
}

function trimToWords(slice: string, whole: string, from: number): string {
  if (from === 0 && slice.length >= whole.length) return slice;
  const tail = slice.length + from >= whole.length ? 0 : trailingPartialWord(slice);
  return slice.slice(0, slice.length - tail);
}
