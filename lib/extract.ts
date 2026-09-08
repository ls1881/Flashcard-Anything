import JSZip from "jszip";
import type Anthropic from "@anthropic-ai/sdk";

type Block = Anthropic.Messages.ContentBlockParam;

export const MAX_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

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

/** Slide XML parts sort lexically (slide10 before slide2), so order by their trailing number. */
function numericOrder(names: string[]): string[] {
  return names.sort((a, b) => {
    const n = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);
    return n(a) - n(b);
  });
}

async function pptxToText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slides = numericOrder(
    Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  );
  const sections: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const body = textFromOoxml(await zip.files[slides[i]].async("string"), "a:t");
    const notesName = `ppt/notesSlides/notesSlide${i + 1}.xml`;
    const notesFile = zip.files[notesName];
    const notes = notesFile ? textFromOoxml(await notesFile.async("string"), "a:t") : "";
    if (!body && !notes) continue;
    sections.push(
      `--- Slide ${i + 1} ---\n${body}${notes ? `\n[Speaker notes] ${notes}` : ""}`
    );
  }
  return sections.join("\n\n");
}

async function docxToText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.files["word/document.xml"];
  if (!doc) return "";
  return textFromOoxml(await doc.async("string"), "w:t");
}

/**
 * Normalize any upload into content blocks for the model. PDFs and images go
 * straight through (the model reads them natively); Office files and plain text
 * are unpacked to text here.
 */
export async function fileToBlocks(file: File): Promise<Block[]> {
  const buf = Buffer.from(await file.arrayBuffer());
  const name = file.name;
  const lower = name.toLowerCase();
  const type = file.type;

  if (type === "application/pdf" || lower.endsWith(".pdf")) {
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") },
      },
    ];
  }

  if (IMAGE_TYPES.has(type)) {
    return [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: buf.toString("base64"),
        },
      },
    ];
  }

  let text: string;
  if (lower.endsWith(".pptx")) text = await pptxToText(buf);
  else if (lower.endsWith(".docx")) text = await docxToText(buf);
  else text = buf.toString("utf8");

  if (!text.trim()) {
    throw new Error(`Couldn't read any text out of "${name}".`);
  }
  return [{ type: "text", text: `Source document "${name}":\n\n${text}` }];
}
