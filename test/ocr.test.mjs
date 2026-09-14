#!/usr/bin/env node --experimental-strip-types
// Run: npm test
//
// A scanned PDF is the input this app exists for — students have photocopies,
// not publisher files — and it was also the input that failed. The fixtures
// below are built the way a scanner builds one: a page is rendered to pixels
// and wrapped in a PDF with no text layer behind it, so nothing here can pass
// by accidentally reading text that a real scan would not have.
import { createCanvas } from "@napi-rs/canvas";
import { fileToSource, scanToSource } from "../lib/extract.ts";
import { ocrAvailable } from "../lib/ocr.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

const PROSE = [
  "Photosynthesis converts light energy into chemical energy.",
  "Chlorophyll absorbs red and blue light, reflecting green.",
  "The light reactions occur in the thylakoid membrane.",
  "The Calvin cycle fixes carbon dioxide into glucose.",
  "ATP and NADPH carry energy between the two stages.",
];

/** A page of printed text, as pixels — what a photocopy actually is. */
function pageJpeg(lines) {
  const c = createCanvas(1224, 1584);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 1224, 1584);
  g.fillStyle = "#000";
  g.font = "bold 44px Helvetica";
  g.fillText("Chapter 4 - Photosynthesis", 100, 140);
  g.font = "38px Helvetica";
  lines.forEach((l, i) => g.fillText(l, 100, 260 + i * 70));
  return c.encodeSync("jpeg", 92);
}

/** A blank page — the scan that has nothing on it for anything to read. */
function blankJpeg() {
  const c = createCanvas(1224, 1584);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 1224, 1584);
  g.fillStyle = "#ddd";
  g.fillRect(200, 400, 800, 600);
  return c.encodeSync("jpeg", 92);
}

/** Wrap JPEG pages in a PDF. `stamp` adds the page number a scanner leaves behind. */
function scannedPdf(jpegs, stamp = false) {
  const n = jpegs.length;
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1");
    parts.push(buf);
    len += buf.length;
  };
  const obj = (id, body, stream) => {
    offsets[id] = len;
    push(`${id} 0 obj\n${body}\n`);
    if (stream) push("stream\n"), push(stream), push("\nendstream\n");
    push("endobj\n");
  };

  push("%PDF-1.4\n");
  const pageIds = jpegs.map((_, i) => 3 + i);
  const contentIds = jpegs.map((_, i) => 3 + n + i);
  const imageIds = jpegs.map((_, i) => 3 + 2 * n + i);
  const fontId = 3 + 3 * n;

  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${n} >>`);
  pageIds.forEach((id, i) =>
    obj(id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imageIds[i]} 0 R >>` +
      (stamp ? ` /Font << /F1 ${fontId} 0 R >>` : "") + ` >> /Contents ${contentIds[i]} 0 R >>`));
  contentIds.forEach((id, i) => {
    const draw = "q 612 0 0 792 0 0 cm /Im0 Do Q" +
      (stamp ? `\nBT /F1 10 Tf 300 30 Td (${i + 1}) Tj ET` : "");
    obj(id, `<< /Length ${draw.length} >>`, Buffer.from(draw, "latin1"));
  });
  imageIds.forEach((id, i) =>
    obj(id,
      "<< /Type /XObject /Subtype /Image /Width 1224 /Height 1584 /ColorSpace /DeviceRGB " +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegs[i].length} >>`, jpegs[i]));
  if (stamp) obj(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const maxId = stamp ? fontId : imageIds[n - 1];
  const startxref = len;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  push(xref);
  return Buffer.concat(parts);
}

/** A PDF drawn with real text operators, for the layer-is-good path. */
function textPdf(bodies) {
  const n = bodies.length;
  const objs = [];
  const fontId = 3 + 2 * n;
  objs.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objs.push(`2 0 obj\n<< /Type /Pages /Kids [${bodies.map((_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${n} >>\nendobj\n`);
  bodies.forEach((_, i) =>
    objs.push(`${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${3 + n + i} 0 R >>\nendobj\n`));
  bodies.forEach((lines, i) => {
    const s = lines.map((l, j) => `BT /F1 14 Tf 72 ${720 - j * 24} Td (${l}) Tj ET`).join("\n");
    objs.push(`${3 + n + i} 0 obj\n<< /Length ${s.length} >>\nstream\n${s}\nendstream\nendobj\n`);
  });
  objs.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objs) offsets.push(Buffer.byteLength(pdf)), (pdf += o);
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const read = (buf, name) => fileToSource(new File([buf], name, { type: "application/pdf" }));

console.log("a PDF with a real text layer is read from the layer, not rasterised:");
{
  const src = await read(textPdf([PROSE, PROSE]), "chapter.pdf");
  check("comes back as text", src.kind, "text");
  check("keeps the prose", src.text.includes("thylakoid membrane"), true);
  check("was not sent through OCR", src.text.includes("read by OCR"), false);
  check("one entry per page", src.pages.length, 2);
}

console.log("\na scan whose only text layer is a page number is still a scan:");
{
  // This is the bug: "1" and "2" are not a document, but they are not nothing
  // either, so the old check called the file readable and the run died two
  // steps later with "couldn't read any text out of it".
  const src = await read(scannedPdf([blankJpeg(), blankJpeg()], true), "stamped.pdf");
  check("not mistaken for a document", src.kind, "scan");
  check("its pages were rendered for reading", src.dataUrls.length, 2);
}

console.log("\na PDF whose text layer is only control bytes is a scan, not an error:");
{
  const src = await read(textPdf([["\\001\\002\\003"]]), "brokenglyphs.pdf");
  check("does not throw", src.kind, "scan");
}

if (await ocrAvailable()) {
  console.log("\na photocopy is read by OCR, with no model involved:");
  {
    const src = await read(scannedPdf([pageJpeg(PROSE), pageJpeg(PROSE.slice().reverse())]), "photocopy.pdf");
    check("comes back as text", src.kind, "text");
    check("says where the text came from", src.text.includes("read by OCR"), true);
    check("reads the heading", /Photosynthesis/.test(src.text), true);
    check("reads the body", /thylakoid membrane/.test(src.text), true);
    check("reads every page", src.pages.length, 2);
  }

  console.log("\na page number stamped on a photocopy no longer costs the page:");
  {
    const src = await read(scannedPdf([pageJpeg(PROSE)], true), "stamped-photocopy.pdf");
    check("comes back as text", src.kind, "text");
    check("with the body, not the page number", /Calvin cycle/.test(src.text), true);
  }

  console.log("\nOCR that finds nothing hands the pages to the vision model instead:");
  {
    const src = await read(scannedPdf([blankJpeg(), blankJpeg()]), "blank.pdf");
    check("falls back rather than claiming an empty document", src.kind, "scan");
  }
} else {
  console.log("\ntesseract is not installed; skipping the OCR checks.");
  console.log('  install it with "brew install tesseract" to run them.');
}

console.log("\na thin text layer survives when nothing can read the pages:");
{
  // No pages render from a PDF this broken, so the few real characters in the
  // layer are all there is — better than refusing the file outright.
  const thin = ["Mitochondria are the powerhouse of the cell, more or less."];
  const src = await scanToSource(Buffer.from("%PDF-1.4\nbroken"), "thin.pdf", thin).catch((e) => e);
  check("kept rather than thrown away", src.kind, "text");
  check("with its text intact", src.text.includes("powerhouse"), true);
}

console.log(failures === 0 ? "\nall OCR checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
