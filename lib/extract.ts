import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";

export const MAX_BYTES = 100 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Everything an upload can become before it reaches the model. */
export type Source =
  | { kind: "text"; text: string; pages: string[] }
  | { kind: "image"; dataUrl: string };

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Pull the text runs out of an OOXML part, treating paragraph ends as line breaks. */
function textFromOoxml(xml: string, runTag: "a:t" | "w:t"): string {
  const paraBreak = runTag === "a:t" ? /<\/a:p>/g : /<\/w:p>/g;
  const withBreaks = xml.replace(paraBreak, "\n");
  const runs = withBreaks.match(new RegExp(`<${runTag}[^>]*>([\\s\\S]*?)</${runTag}>`, "g")) ?? [];
  const text = runs
    .map((r) => decodeXmlEntities(r.replace(new RegExp(`</?${runTag}[^>]*>`, "g"), "")))
    .join(" ");
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Slide parts sort lexically (slide10 before slide2), so order by trailing number. */
function numericOrder(names: string[]): string[] {
  return names.sort((a, b) => {
    const n = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);
    return n(a) - n(b);
  });
}

/** Per page, so "pages 100-120" can be honoured later. */
async function pdfToPages(buf: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((p) => String(p ?? "").trim());
}

/** One entry per slide, which doubles as the page unit for slide ranges. */
async function pptxToPages(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const slides = numericOrder(
    Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  );
  const sections: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const body = textFromOoxml(await zip.files[slides[i]].async("string"), "a:t");
    const notesFile = zip.files[`ppt/notesSlides/notesSlide${i + 1}.xml`];
    const notes = notesFile ? textFromOoxml(await notesFile.async("string"), "a:t") : "";
    if (!body && !notes) continue;
    sections.push(`--- Slide ${i + 1} ---\n${body}${notes ? `\n[Speaker notes] ${notes}` : ""}`);
  }
  return sections;
}

async function docxToText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.files["word/document.xml"];
  if (!doc) return "";
  return textFromOoxml(await doc.async("string"), "w:t");
}

function stripHtml(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** RTF is a plausible format for exported notes; keep the text, drop the control words. */
function rtfToText(rtf: string): string {
  return rtf
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\[a-z]+-?\d*\s?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** EPUB chapters, read in spine order so a book reads front to back. */
async function epubToPages(zip: JSZip): Promise<string[]> {
  const container = zip.files["META-INF/container.xml"];
  let order: string[] = [];
  let base = "";

  if (container) {
    const opfPath = /full-path="([^"]+)"/.exec(await container.async("string"))?.[1];
    const opf = opfPath ? zip.files[opfPath] : undefined;
    if (opf && opfPath) {
      base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
      const xml = await opf.async("string");
      const manifest = new Map<string, string>();
      for (const m of xml.matchAll(/<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*>/g)) {
        manifest.set(m[1], m[2]);
      }
      for (const m of xml.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)) {
        const href = manifest.get(m[1]);
        if (href) order.push(base + href.replace(/^\.\//, ""));
      }
    }
  }

  if (!order.length) {
    order = Object.keys(zip.files)
      .filter((n) => /\.x?html?$/i.test(n))
      .sort();
  }

  const pages: string[] = [];
  for (const name of order) {
    const file = zip.files[name];
    if (!file) continue;
    const text = stripHtml(await file.async("string"));
    if (text) pages.push(text);
  }
  return pages;
}

/** Text extracted from the wrong kind of file is mostly control bytes; say so plainly. */
function looksBinary(s: string): boolean {
  const sample = s.slice(0, 4000);
  if (!sample) return true;
  const bad = sample.replace(/[\s\P{C}]/gu, "").length + (sample.match(/�/g)?.length ?? 0);
  return bad / sample.length > 0.1;
}

type Kind = "pdf" | "docx" | "pptx" | "epub" | "rtf" | "html" | "legacy-office" | "zip" | "text";

/** Trust the bytes over the extension, so a mislabelled or extension-less file still works. */
async function detectKind(buf: Buffer, lower: string): Promise<{ kind: Kind; zip?: JSZip }> {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf" };
  if (buf.subarray(0, 5).toString("latin1") === "{\\rtf") return { kind: "rtf" };
  // OLE2 compound file: legacy .doc/.ppt/.xls
  if (buf.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1") return { kind: "legacy-office" };

  if (buf.subarray(0, 2).toString("latin1") === "PK") {
    const zip = await JSZip.loadAsync(buf);
    if (zip.files["word/document.xml"]) return { kind: "docx", zip };
    if (Object.keys(zip.files).some((n) => n.startsWith("ppt/slides/"))) return { kind: "pptx", zip };
    if (zip.files["META-INF/container.xml"] || zip.files["mimetype"]) return { kind: "epub", zip };
    return { kind: "zip", zip };
  }

  if (/\.(html?|xhtml)$/.test(lower)) return { kind: "html" };
  const head = buf.subarray(0, 1000).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return { kind: "html" };
  return { kind: "text" };
}

/**
 * Normalize any upload into text, or into a data URL for images (which need a
 * vision-capable local model). Runs entirely on this machine.
 */
export async function fileToSource(file: File): Promise<Source> {
  const buf = Buffer.from(await file.arrayBuffer());
  const name = file.name;
  const lower = name.toLowerCase();

  if (IMAGE_TYPES.has(file.type)) {
    return { kind: "image", dataUrl: `data:${file.type};base64,${buf.toString("base64")}` };
  }

  const { kind, zip } = await detectKind(buf, lower);

  let pages: string[];
  switch (kind) {
    case "pdf":
      pages = await pdfToPages(buf);
      if (!pages.join("").trim()) {
        throw new Error(
          `"${name}" has no extractable text — it's probably a scan. Export a text-based PDF, or screenshot the pages and upload them as images with a vision model.`
        );
      }
      break;
    case "pptx":
      pages = await pptxToPages(buf);
      break;
    case "docx":
      pages = [await docxToText(buf)];
      break;
    case "epub":
      pages = await epubToPages(zip!);
      break;
    case "rtf":
      pages = [rtfToText(buf.toString("utf8"))];
      break;
    case "html":
      pages = [stripHtml(buf.toString("utf8"))];
      break;
    case "legacy-office":
      throw new Error(
        `"${name}" is in the old Office format. Open it and "Save As" .docx or .pptx, then try again.`
      );
    case "zip":
      throw new Error(
        `"${name}" is an archive this can't read (Pages, Keynote, and .zip aren't supported). Export it as PDF, .docx, or .pptx.`
      );
    default:
      pages = [buf.toString("utf8")];
  }

  pages = pages.map(stripControlChars);
  const text = pages.join("\n\n");
  if (!text.trim()) throw new Error(`Couldn't read any text out of "${name}".`);
  if (looksBinary(text)) {
    throw new Error(
      `"${name}" doesn't appear to be a readable document. Try a PDF, Word, PowerPoint, EPUB, or plain-text file.`
    );
  }
  return { kind: "text", text: `Source document "${name}":\n\n${text}`, pages };
}

/**
 * PDF extraction yields C0 control bytes where the file used custom glyphs. A model
 * echoes them into its JSON strings, and a raw control character inside a JSON string
 * is invalid, so a single ligature could void a whole batch of cards.
 */
export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

const normalizeLine = (line: string) => line.trim().replace(/\d+/g, "#").replace(/\s+/g, " ");

/**
 * Page furniture — running headers, footers, the book title on every page — is extracted
 * as body text and lands mid-sentence in a chunk. Models then make cards out of it
 * ("term": "T ( 2.3 Matrix Products 75"). Any line repeated across a good share of the
 * pages is furniture, not content.
 *
 * Headings are found before this runs, because the repetition is exactly what makes a
 * running header useful for locating a section.
 */
export function repeatedLines(pages: string[]): Set<string> {
  if (pages.length < 4) return new Set();

  // Only the top and bottom of each page can be furniture. Counting every line instead
  // flags ordinary repeated words ("Solution"), and a per-section header recurs on far
  // too few pages of a long book to clear any sensible document-wide threshold.
  const edges = new Map<string, number>();
  for (const page of pages) {
    const lines = page
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    const candidates = [lines[0], lines[1], lines[lines.length - 1], lines[lines.length - 2]];
    for (const line of new Set(candidates)) {
      if (!line || line.length <= 3 || line.length >= 120) continue;
      const key = normalizeLine(line);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }

  return new Set([...edges].filter(([, n]) => n >= 3).map(([line]) => line));
}

/** Drop the furniture from a slice of text that's about to be read by a model. */
export function removeRepeatedLines(text: string, noisy: Set<string>): string {
  if (!noisy.size) return text;
  const kept = text.split("\n").filter((line) => !noisy.has(normalizeLine(line)));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Does `acro` read as the initials of `expansion`, allowing skipped filler words? */
function initialsMatch(expansion: string, acro: string): boolean {
  const words = expansion.split(/[\s-]+/).filter(Boolean);
  const letters = acro.replace(/s$/, "").toUpperCase().split("");
  let w = 0;
  for (const letter of letters) {
    let found = false;
    while (w < words.length) {
      if (words[w++][0]?.toUpperCase() === letter) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Text before "(ACR)" is usually a whole sentence fragment, and skipping filler words to
 * match initials will happily swallow a title. Take the shortest trailing phrase that both
 * starts on the acronym's first letter and matches its initials, so "…Parallel Crossword
 * Filling Abstract Parallel Constraint Satisfaction Problem (CSP)" yields the last three
 * words, not all eight.
 */
function shortestExpansion(phrase: string, acro: string): string | null {
  const words = phrase.split(/[\s-]+/).filter(Boolean);
  const letters = acro.replace(/s$/, "").toUpperCase();
  const max = Math.min(words.length, letters.length * 2 + 1);

  for (let take = letters.length; take <= max; take++) {
    const candidate = words.slice(words.length - take);
    if (candidate[0]?.[0]?.toUpperCase() !== letters[0]) continue;
    const joined = candidate.join(" ");
    if (initialsMatch(joined, acro)) return joined;
  }
  return null;
}

/**
 * Harvest "Expansion Words (ACRONYM)" pairs from the whole document. Chunking otherwise
 * strands an acronym in a later section with nothing to define it, and the model fills
 * the gap from its own priors instead of the paper.
 */
export function buildGlossary(text: string): string[] {
  const found = new Map<string, string>();

  const forward = /((?:[\w'’-]+[\s-]+){0,9}[\w'’-]+)\s*\(([A-Z][A-Za-z]{1,7})s?\)/g;
  for (const m of text.matchAll(forward)) {
    const [, phrase, acro] = m;
    if (found.has(acro)) continue;
    const best = shortestExpansion(phrase, acro);
    if (best) found.set(acro, best);
  }

  const backward = /\b([A-Z]{2,7})\s*\(([^)]{5,90})\)/g;
  for (const m of text.matchAll(backward)) {
    const [, acro, expansion] = m;
    if (!found.has(acro) && initialsMatch(expansion, acro)) found.set(acro, expansion.trim());
  }

  return [...found].map(([acro, expansion]) => `${acro} = ${expansion}`);
}

/**
 * Local models have small context windows, so long material is split on paragraph
 * boundaries and turned into cards a piece at a time. Chunks overlap slightly so a
 * definition sitting on a boundary isn't cut away from the term it defines.
 */
export function chunkText(text: string, maxChars = 3500, maxChunks = 16, overlap = 320): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    // A single oversized paragraph gets hard-split rather than blowing the window.
    if (para.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
      for (let i = 0; i < para.length; i += maxChars) chunks.push(para.slice(i, i + maxChars));
      continue;
    }
    if (current.length + para.length + 2 > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const trimmed = chunks.filter(Boolean).slice(0, maxChunks);
  return trimmed.map((chunk, i) =>
    i === 0 ? chunk : `${trimmed[i - 1].slice(-overlap)}\n\n${chunk}`
  );
}
