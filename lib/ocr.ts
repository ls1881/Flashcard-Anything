/**
 * OCR for pages that have no text layer.
 *
 * The app used to read scans with the vision model it was already configured
 * with, on the argument that a second engine wasn't worth it. That argument
 * assumed the configured model could see: point a text-only model like
 * `qwen3:8b` at a photocopy and every page comes back empty, which is the
 * failure people actually hit. Tesseract is the same bargain whisper already
 * asks for — looked up on PATH rather than bundled, absence reported as
 * instructions — and on a page of printed body text it is both better and
 * faster than a small local vision model.
 *
 * The vision model is still the fallback, since tesseract is poor on
 * handwriting, whiteboards, and anything that isn't laid out like a page.
 */

/** Tesseract is slow on a big page; more than this and a scan takes minutes. */
const OCR_TIMEOUT_MS = 30_000;

let cached: Promise<boolean> | null = null;

/** Is tesseract installed? Asked once — the answer can't change mid-process. */
export function ocrAvailable(): Promise<boolean> {
  cached ??= capture(binary(), ["--version"]).then(
    (out) => /tesseract/i.test(out),
    () => false
  );
  return cached;
}

function binary(): string {
  return process.env.TESSERACT_BIN ?? "tesseract";
}

/**
 * Read printed text off rendered pages.
 *
 * Returns one entry per page, blanks included, so a caller can keep page
 * numbering intact. A page tesseract chokes on comes back empty rather than
 * losing the rest of the chapter.
 */
export async function ocrPages(pngs: Buffer[]): Promise<string[]> {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const lang = process.env.OCR_LANG ?? "eng";
  const dir = await mkdtemp(join(tmpdir(), "fca-ocr-"));
  try {
    const out: string[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const page = join(dir, `page-${i}.png`);
      await writeFile(page, pngs[i]);
      try {
        // "stdout" is tesseract's name for the output file, not a flag.
        // --psm 3 is full automatic page segmentation, which is what a
        // scanned page of a book or a handout actually is.
        const text = await capture(binary(), [page, "stdout", "-l", lang, "--psm", "3"]);
        out.push(clean(text));
      } catch {
        out.push("");
      }
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Tesseract emits form feeds between blocks and hyphenates across line ends
 * because the scan did. Left alone, the chunker splits on the wrong places and
 * a term arrives at the model cut in half.
 */
function clean(text: string): string {
  return text
    .replace(/\f/g, "\n\n")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Run a binary and return its stdout, rejecting on a non-zero exit. */
function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), OCR_TIMEOUT_MS);
      child.stdout?.on("data", (d) => (stdout += String(d)));
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim().split("\n").pop() ?? `exit ${code}`));
      });
    }, reject);
  });
}

/** What to tell someone who has neither OCR nor a model that can see. */
export const OCR_INSTALL_HINT =
  'install OCR with "brew install tesseract" (or "apt install tesseract-ocr")';
