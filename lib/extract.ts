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

  let pages: string[];
  if (file.type === "application/pdf" || lower.endsWith(".pdf")) {
    pages = await pdfToPages(buf);
    if (!pages.join("").trim()) {
      throw new Error(
        `"${name}" has no extractable text — it's probably a scan. Export a text-based PDF, or screenshot the pages and upload them as images with a vision model.`
      );
    }
  } else if (lower.endsWith(".pptx")) {
    pages = await pptxToPages(buf);
  } else if (lower.endsWith(".docx")) {
    pages = [await docxToText(buf)];
  } else {
    pages = [buf.toString("utf8")];
  }

  const text = pages.join("\n\n");
  if (!text.trim()) throw new Error(`Couldn't read any text out of "${name}".`);
  return { kind: "text", text: `Source document "${name}":\n\n${text}`, pages };
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
 * Harvest "Expansion Words (ACRONYM)" pairs from the whole document. Chunking otherwise
 * strands an acronym in a later section with nothing to define it, and the model fills
 * the gap from its own priors instead of the paper.
 */
export function buildGlossary(text: string): string[] {
  const found = new Map<string, string>();

  const forward = /([A-Z][\w'’-]*(?:[\s-]+[\w'’-]+){0,7})\s*\(([A-Z][A-Za-z]{1,7})s?\)/g;
  for (const m of text.matchAll(forward)) {
    const [, expansion, acro] = m;
    if (!found.has(acro) && initialsMatch(expansion, acro)) found.set(acro, expansion.trim());
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
