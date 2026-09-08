/**
 * Structure detection, so a request like "chapter 3, section 2" can be resolved against a
 * whole textbook without sending the whole textbook to a model. Headings and page offsets
 * are found with plain pattern matching; the model only ever sees the slice that wins.
 */

export type Heading = {
  /** 1 = chapter, 2 = section, 3 = subsection. */
  level: number;
  /** Dotted number when the document has one: "3", "3.2". */
  number: string | null;
  title: string;
  /** Character offset into the assembled text. */
  start: number;
  page: number;
};

export type Outline = {
  text: string;
  headings: Heading[];
  /** Character offset where each page (or slide) begins. */
  pageStarts: number[];
  pageCount: number;
};

export type Scope = {
  start: number;
  end: number;
  label: string;
  pages: [number, number];
};

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanToInt(s: string): number | null {
  let total = 0;
  const chars = s.toLowerCase().split("");
  if (!chars.every((c) => c in ROMAN)) return null;
  for (let i = 0; i < chars.length; i++) {
    const value = ROMAN[chars[i]];
    const next = ROMAN[chars[i + 1]] ?? 0;
    total += value < next ? -value : value;
  }
  return total || null;
}

/** "3" -> 3, "iv" -> 4 */
function toNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  return romanToInt(token);
}

const CHAPTER_RE = /^\s*(?:chapter|chap\.?|unit|part|lecture)\s+(\d{1,3}|[ivxlcdm]{1,7})\b[.:—–-]?\s*(.{0,90})$/i;
const SECTION_KW_RE = /^\s*section\s+(\d{1,3}(?:\.\d{1,3}){0,2})\b[.:—–-]?\s*(.{0,90})$/i;
const NUMBERED_RE = /^\s*(\d{1,3}(?:\.\d{1,3}){1,2})[.)]?\s+([A-Z][^.!?]{2,90})$/;

function headingFrom(line: string): Omit<Heading, "start" | "page"> | null {
  const chapter = CHAPTER_RE.exec(line);
  if (chapter) {
    const n = toNumber(chapter[1]);
    if (n !== null) return { level: 1, number: String(n), title: chapter[2].trim() };
  }

  const named = SECTION_KW_RE.exec(line);
  if (named) {
    const number = named[1];
    return { level: number.includes(".") ? 2 : 1, number, title: named[2].trim() };
  }

  const numbered = NUMBERED_RE.exec(line);
  if (numbered) {
    const number = numbered[1];
    return { level: Math.min(number.split(".").length, 3), number, title: numbered[2].trim() };
  }
  return null;
}

export function buildOutline(pages: string[]): Outline {
  const pageStarts: number[] = [];
  let text = "";
  for (const page of pages) {
    pageStarts.push(text.length);
    text += (text ? "\n\n" : "") + page;
  }

  const headings: Heading[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const found = headingFrom(line);
    if (found && found.title.length < 95) {
      // Running headers carry the page number; it isn't part of the title.
      found.title = found.title.replace(/\s+\d{1,4}$/, "").trim();
      headings.push({ ...found, start: offset, page: pageAt(pageStarts, offset) });
    }
    offset += line.length + 1;
  }

  return { text, headings, pageStarts, pageCount: pages.length };
}

function pageAt(pageStarts: number[], offset: number): number {
  let lo = 0;
  let hi = pageStarts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pageStarts[mid] <= offset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best + 1;
}

/** A heading runs until the next one at the same or higher level. */
function extentOf(outline: Outline, index: number): { start: number; end: number } {
  const heading = outline.headings[index];
  const next = outline.headings.findIndex(
    (h, i) => i > index && h.level <= heading.level
  );
  return {
    start: heading.start,
    end: next === -1 ? outline.text.length : outline.headings[next].start,
  };
}

/**
 * Textbooks repeat the section title as a running header on every page, so a number like
 * "1.2" can appear a dozen times — once in the contents, then once per page of the body.
 * Taking the first match yields the few characters before the next repeat. Instead, treat
 * repeats of the same number as one section and keep the occurrence that spans the most
 * text, which is the body rather than a contents line or a page header.
 */
function bestExtentForNumber(
  outline: Outline,
  number: string
): { index: number; start: number; end: number } | null {
  let best: { index: number; start: number; end: number; len: number } | null = null;

  outline.headings.forEach((heading, i) => {
    if (heading.number !== number) return;
    let end = outline.text.length;
    for (let j = i + 1; j < outline.headings.length; j++) {
      const next = outline.headings[j];
      if (next.number === number) continue; // the same section's running header
      if (next.level <= heading.level) {
        end = next.start;
        break;
      }
    }
    const len = end - heading.start;
    if (!best || len > best.len) best = { index: i, start: heading.start, end, len };
  });

  return best;
}

function describe(outline: Outline, heading: Heading, start: number, end: number): Scope {
  const name = [heading.number, heading.title].filter(Boolean).join(" ");
  return {
    start,
    end,
    label: name.trim() || "Selected section",
    pages: [pageAt(outline.pageStarts, start), pageAt(outline.pageStarts, Math.max(start, end - 1))],
  };
}

const STOPWORDS = new Set([
  "flashcards", "flashcard", "cards", "card", "for", "from", "the", "a", "an", "on", "about",
  "make", "just", "only", "please", "chapter", "chapters", "section", "sections", "page",
  "pages", "slide", "slides", "and", "of", "in", "to",
]);

/**
 * Resolve a natural request against the outline. Handles page/slide ranges, chapter and
 * section numbers, and falls back to matching words against heading titles.
 */
export function findScope(outline: Outline, query: string): Scope | null {
  const q = query.trim();
  if (!q) return null;

  // "pages 100-120", "slides 4 to 9"
  const range = /\b(?:pages?|slides?|pp?\.?)\s*(\d{1,4})\s*(?:-|–|—|to|through|thru)\s*(\d{1,4})/i.exec(q);
  if (range) {
    const from = Math.max(1, Number(range[1]));
    const to = Math.min(outline.pageCount, Number(range[2]));
    if (from <= to) {
      return {
        start: outline.pageStarts[from - 1] ?? 0,
        end: outline.pageStarts[to] ?? outline.text.length,
        label: `Pages ${from}–${to}`,
        pages: [from, to],
      };
    }
  }

  // "page 12", "slide 7"
  const single = /\b(?:page|slide)\s*(\d{1,4})\b/i.exec(q);
  if (single) {
    const n = Number(single[1]);
    if (n >= 1 && n <= outline.pageCount) {
      return {
        start: outline.pageStarts[n - 1],
        end: outline.pageStarts[n] ?? outline.text.length,
        label: `Page ${n}`,
        pages: [n, n],
      };
    }
  }

  const chapterMatch = /\bchapter\s+(\d{1,3}|[ivxlcdm]{1,7})\b/i.exec(q);
  const sectionMatch = /\bsection\s+(\d{1,3}(?:\.\d{1,3})?)\b/i.exec(q);
  const dotted = /\b(\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)\b/.exec(q);

  const chapterNo = chapterMatch ? toNumber(chapterMatch[1]) : null;

  // "chapter 3, section 2" -> section 3.2, or the 2nd subsection inside chapter 3.
  if (chapterNo !== null && sectionMatch) {
    const sec = sectionMatch[1];
    const target = sec.includes(".") ? sec : `${chapterNo}.${sec}`;
    const exact = bestExtentForNumber(outline, target);
    if (exact) {
      return describe(outline, outline.headings[exact.index], exact.start, exact.end);
    }

    const chapterIndex = outline.headings.findIndex(
      (h) => h.level === 1 && h.number === String(chapterNo)
    );
    if (chapterIndex !== -1) {
      const bounds = extentOf(outline, chapterIndex);
      const inside = outline.headings.filter(
        (h, i) => i > chapterIndex && h.start < bounds.end && h.level === 2
      );
      const nth = inside[Number(sec.split(".").pop()) - 1];
      if (nth) {
        const idx = outline.headings.indexOf(nth);
        const { start, end } = extentOf(outline, idx);
        return describe(outline, nth, start, end);
      }
    }
  }

  // "section 3.2" or a bare "3.2"
  const numbered = sectionMatch?.[1] ?? dotted?.[1];
  if (numbered) {
    const hit = bestExtentForNumber(outline, numbered);
    if (hit) return describe(outline, outline.headings[hit.index], hit.start, hit.end);
  }

  // "chapter 3"
  if (chapterNo !== null) {
    // Prefer the span covered by the chapter's own sections. "Chapter 3" also appears in
    // cross-references inside body text, which a plain heading lookup happily matches.
    const first = bestExtentForNumber(outline, `${chapterNo}.1`);
    if (first) {
      const nextChapter = bestExtentForNumber(outline, `${chapterNo + 1}.1`);
      const end = nextChapter && nextChapter.start > first.start ? nextChapter.start : outline.text.length;
      const h = outline.headings[first.index];
      return {
        ...describe(outline, h, first.start, end),
        label: `Chapter ${chapterNo}${h.title ? ` — ${h.title}` : ""}`,
      };
    }

    const hit = bestExtentForNumber(outline, String(chapterNo));
    if (hit) {
      const h = outline.headings[hit.index];
      return {
        ...describe(outline, h, hit.start, hit.end),
        label: `Chapter ${h.number}${h.title ? ` — ${h.title}` : ""}`,
      };
    }
  }

  // Fall back to matching words against heading titles.
  const words = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (!words.length) return null;

  let bestIndex = -1;
  let bestScore = 0;
  outline.headings.forEach((h, i) => {
    const title = h.title.toLowerCase();
    const score = words.filter((w) => title.includes(w)).length / words.length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });

  if (bestIndex !== -1 && bestScore >= 0.5) {
    const { start, end } = extentOf(outline, bestIndex);
    return describe(outline, outline.headings[bestIndex], start, end);
  }
  return null;
}

/** Chapter-level headings, for telling the user what they can ask for. */
export function tableOfContents(outline: Outline, limit = 14): string[] {
  // Numbered sections are the most useful thing to offer, since they're what a reader can
  // ask for by name. Chapter-level lines in a real book are often prose summaries.
  const sections = outline.headings.filter((h) => h.level >= 2 && h.number && h.title);
  const top = sections.length ? sections : outline.headings.filter((h) => h.level === 1);
  const source = top.length ? top : outline.headings;

  // The real title is the one that recurs, because it's printed as a running header on
  // every page of the section. A one-off match is usually a mid-sentence cross-reference.
  const counts = new Map<string, Map<string, number>>();
  for (const h of source) {
    const key = h.number ?? h.title;
    if (!h.title) continue;
    const forNumber = counts.get(key) ?? new Map<string, number>();
    forNumber.set(h.title, (forNumber.get(h.title) ?? 0) + 1);
    counts.set(key, forNumber);
  }

  const best: [string, string][] = [];
  for (const [number, titles] of counts) {
    const winner = [...titles].sort(
      (a, b) => b[1] - a[1] || b[0].length - a[0].length
    )[0];
    if (winner) best.push([number, winner[0]]);
  }

  return best.slice(0, limit).map(([number, title]) => `${number} ${title}`.trim());
}
