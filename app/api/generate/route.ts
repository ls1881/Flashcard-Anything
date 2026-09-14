import { NextResponse } from "next/server";
import {
  buildGlossary,
  chunkText,
  fileToSource,
  MAX_BYTES,
  urlToSource,
  youtubeId,
  youtubeToSource,
  removeRepeatedLines,
  repeatedLines,
  type Source,
} from "@/lib/extract";
import { OCR_INSTALL_HINT } from "@/lib/ocr";
import { completeText, resolveKey, type LlmConfig } from "@/lib/llm";
import { PROVIDERS, isProviderId } from "@/lib/providers";
import { cardCapFor, pipelineFor, type Progress } from "@/lib/pipelines";
import {
  isCardStyle,
  isDensity,
  isDifficulty,
  type CardStyle,
  type Density,
  type Difficulty,
} from "@/lib/style";
import { cacheKey, chunkKey, getCached, getChunk, putCached, putChunk } from "@/lib/cache";
import { concurrencyFor } from "@/lib/pipelines";
import { buildOutline, findScope, tableOfContents } from "@/lib/outline";
import type { Card } from "@/lib/duplex";

type TextSource = Extract<Source, { kind: "text" }>;

export const runtime = "nodejs";
export const maxDuration = 800;

const MAX_CHUNKS = 16;

const TRANSCRIBE_SYSTEM = `You transcribe images. Reply with the transcription only — no preamble, no commentary.

Copy out every word, heading, label, formula, and caption you can see, in reading order. Transcribe only — never summarize, explain, answer, or add anything that is not visibly written in the image.

Write formulas in plain readable notation, like "E[Q] = 3/4 + 1/2 + 1/4 = 1.5" or "Var(Q) = 5/8". Never use LaTeX markup, backslash commands, or math delimiters. If there is no readable text, return an empty string.`;

/**
 * Chunking hides the rest of the paper from each call, which is exactly when a model
 * starts inventing. Every chunk gets the document's opening and its acronym glossary so
 * terms are read in this document's context rather than the model's priors.
 */
function contextBlock(source: TextSource): string {
  const glossary = buildGlossary(source.text);
  const opening = source.text.slice(0, 700).trim();
  const parts = [
    "DOCUMENT CONTEXT — use this to interpret terms correctly. Do not make cards from this block alone.",
    `Opening of the document:\n${opening}`,
  ];
  if (glossary.length) {
    parts.push(
      `Abbreviations as this document defines them — always use these, never your own expansion:\n${glossary
        .map((g) => `- ${g}`)
        .join("\n")}`
    );
  }
  return parts.join("\n\n");
}

export async function POST(req: Request) {
  let source: Source;
  let cfg: LlmConfig;
  let scopeRequest = "";
  let pipelineId = "";
  let chunkOverride = 0;
  let style: CardStyle = "definition";
  let difficulty: Difficulty = "intro";
  let density: Density = "normal";

  try {
    const form = await req.formData();
    const file = form.get("file");
    const text = String(form.get("text") ?? "").trim();
    scopeRequest = String(form.get("scope") ?? "").trim();
    pipelineId = String(form.get("pipeline") ?? "").trim();
    const wantedStyle = String(form.get("style") ?? "");
    if (isCardStyle(wantedStyle)) style = wantedStyle;
    const wantedDifficulty = String(form.get("difficulty") ?? "");
    if (isDifficulty(wantedDifficulty)) difficulty = wantedDifficulty;
    const wantedDensity = String(form.get("density") ?? "");
    if (isDensity(wantedDensity)) density = wantedDensity;
    // Smaller chunks suit a small model, and let the benchmark reproduce the
    // cross-section context loss that long documents cause.
    const requested = Number(form.get("chunkChars"));
    if (Number.isFinite(requested) && requested > 0) {
      chunkOverride = Math.min(40000, Math.max(500, Math.round(requested)));
    }

    const provider = String(form.get("provider") ?? "ollama");
    if (!isProviderId(provider)) {
      return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
    }
    cfg = {
      provider,
      model: String(form.get("model") ?? "").trim() || PROVIDERS[provider].defaultModel,
      apiKey: resolveKey(provider, String(form.get("apiKey") ?? "")),
      baseUrl: String(form.get("baseUrl") ?? "").trim() || undefined,
    };

    const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    const url = String(form.get("url") ?? "").trim();

    if (files.length) {
      for (const f of files) {
        if (f.size > MAX_BYTES) {
          return NextResponse.json(
            { error: `"${f.name}" is over the ${MAX_BYTES / 1024 / 1024}MB limit.` },
            { status: 413 }
          );
        }
      }
      // "Everything for this exam" is the natural unit, not one file. Images
      // still go one at a time: each needs its own vision pass, and mixing a
      // transcription into a text merge would lose which page it came from.
      if (files.length === 1) {
        source = await fileToSource(files[0]);
      } else {
        const parts: string[] = [];
        const pages: string[] = [];
        for (const f of files) {
          const one = await fileToSource(f);
          if (one.kind !== "text") {
            return NextResponse.json(
              {
                error: `"${f.name}" has to be read by a vision model, which happens one file at a time — upload it on its own.`,
              },
              { status: 400 }
            );
          }
          // A heading per file keeps the outline navigable and tells the model
          // where one document ends and the next begins.
          parts.push(`## ${f.name}\n\n${one.text}`);
          pages.push(...one.pages);
        }
        source = { kind: "text", text: parts.join("\n\n"), pages };
      }
    } else if (url) {
      // A YouTube link is a transcript, not a page: the page itself is a shell.
      const video = youtubeId(url);
      source = video ? await youtubeToSource(video) : await urlToSource(url);
    } else if (text) {
      source = { kind: "text", text, pages: [text] };
    } else {
      return NextResponse.json({ error: "Add a file, a link, or some text first." }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Couldn't read that file.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Narrow a big document to the requested part before anything reaches a model.
  let scopeLabel: string | null = null;
  // A scan has no text to outline yet; it is transcribed inside the stream, and
  // the length guard below applies to what comes out of that.
  if (source.kind === "text") {
    const outline = buildOutline(source.pages);

    if (scopeRequest) {
      const scope = findScope(outline, scopeRequest);
      if (!scope) {
        const toc = tableOfContents(outline);
        return NextResponse.json(
          {
            error:
              `Couldn't find "${scopeRequest}" in that document.` +
              (toc.length
                ? ` It looks like it contains: ${toc.join("; ")}.`
                : " No chapter or section headings were detected, so try a page range like \"pages 40-60\"."),
          },
          { status: 404 }
        );
      }
      scopeLabel =
        scope.pages[0] === scope.pages[1]
          ? `${scope.label} (page ${scope.pages[0]})`
          : `${scope.label} (pages ${scope.pages[0]}–${scope.pages[1]})`;
      source = { ...source, text: outline.text.slice(scope.start, scope.end) };
    } else {
      // Without a scope, a whole textbook would silently become cards from page one only.
      const capacity = (chunkOverride || PROVIDERS[cfg.provider].chunkChars) * MAX_CHUNKS;
      if (source.text.length > capacity) {
        const toc = tableOfContents(outline);
        return NextResponse.json(
          {
            error:
              `That document is too long to turn into one deck (${Math.round(
                source.text.length / 1000
              )}k characters across ${outline.pageCount} pages). Say which part you want — ` +
              (toc.length
                ? `for example "${toc[Math.min(1, toc.length - 1)]}".`
                : 'for example "pages 40-60".'),
          },
          { status: 413 }
        );
      }
    }
  }

  const encoder = new TextEncoder();

  // Streamed as NDJSON so the page can show progress; local runs take real time.
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      const cards: Card[] = [];
      let dropped = 0;
      let fixed = 0;
      let duplicates = 0;

      try {
        // An image has no text to check a quote against, so read it out first and then
        // run the same grounded pipeline everything else goes through.
        let material = source;
        if (material.kind === "scan") {
          const pages: string[] = [];
          const total = material.dataUrls.length;
          for (let i = 0; i < total; i++) {
            send({ type: "progress", phase: "reading", done: i, total, cards: 0 });
            const page = (
              await completeText(cfg, TRANSCRIBE_SYSTEM, [
                { type: "image_url", image_url: { url: material.dataUrls[i] } },
                { type: "text", text: "Transcribe this page." },
              ])
            ).trim();
            // A blank page in a scan is normal; a blank *every* page is not,
            // and that is caught below.
            if (page.length >= 20) pages.push(page);
          }
          if (!pages.length) {
            send({
              type: "error",
              error:
                `"${material.name}" is a scan, so it has to be read as pictures — and "${cfg.model}" ` +
                `read nothing on any of its pages. Either ${OCR_INSTALL_HINT}, which needs no model at all, ` +
                `or switch to a vision model such as qwen2.5vl:7b.`,
            });
            return;
          }
          material = { kind: "text", text: pages.join("\n\n"), pages };
        }

        if (material.kind === "image") {
          send({ type: "progress", phase: "reading", done: 0, total: 1, cards: 0 });
          const transcript = (
            await completeText(cfg, TRANSCRIBE_SYSTEM, [
              { type: "image_url", image_url: { url: material.dataUrl } },
              { type: "text", text: "Transcribe this image." },
            ])
          ).trim();
          if (transcript.length < 20) {
            send({
              type: "error",
              error:
                `"${cfg.model}" couldn't read any text in that image. Either ${OCR_INSTALL_HINT}, ` +
                `which needs no model at all, switch to a vision model such as qwen2.5vl:7b, ` +
                `or upload the document itself.`,
            });
            // The `finally` closes the stream; doing it here as well throws and
            // drops the connection, so the reader sees a network error rather
            // than the message above.
            return;
          }
          material = { kind: "text", text: transcript, pages: [transcript] };
        }

        const glossary = buildGlossary(material.text);
        const context = contextBlock(material);
        // Strip page furniture from what the model reads. Headings were already located,
        // so removing the repeated lines now costs nothing and cleans up the chunks.
        const body = removeRepeatedLines(material.text, repeatedLines(material.pages));
        const chunks = chunkText(
          body,
          chunkOverride || PROVIDERS[cfg.provider].chunkChars,
          MAX_CHUNKS
        );

        // Sent before any card so it reaches the deck even if the run dies
        // partway. The original upload is gone by the time someone rewrites a
        // card — extraction happened here, and the File died with the page — so
        // this is the only copy that survives.
        send({ type: "source", sourceText: body });

        // An unchanged document with unchanged settings is the same deck, and
        // the model already spent the minutes once.
        const key = cacheKey({
          text: body,
          scope: scopeLabel ?? "",
          provider: cfg.provider,
          model: cfg.model,
          pipeline: pipelineFor(pipelineId).id,
          style,
          difficulty,
          density,
          chunkChars: chunkOverride || PROVIDERS[cfg.provider].chunkChars,
        });
        const cached = getCached(key);
        if (cached) {
          // Replay the messages a real run sends, so the page cannot tell the
          // difference beyond the speed.
          send({ type: "cards", cards: cached.cards });
          send({
            type: "result",
            cards: cached.cards,
            dropped: cached.dropped,
            fixed: cached.fixed,
            duplicates: cached.duplicates,
            scope: cached.scopeLabel,
            style,
            cached: true,
            pipeline: pipelineFor(pipelineId).id,
          });
          // No close here: the `finally` below owns that, and closing twice
          // throws inside the stream and drops the connection.
          return;
        }

        const pipeline = pipelineFor(pipelineId);
        const result = await pipeline.run({
          cfg,
          chunks,
          context,
          glossary,
          maxCards: cardCapFor(density, chunks.length),
          style,
          difficulty,
          density,
          concurrency: concurrencyFor(cfg.provider),
          // Finishing an interrupted run rather than starting it again.
          sectionCache: {
            get: (chunk) => getChunk(chunkKey(key, chunk)),
            put: (chunk, result) => putChunk(chunkKey(key, chunk), result),
          },
          onProgress: (p: Progress) => send({ type: "progress", ...p }),
          // Sent as each section lands so the page can fill in while the rest
          // of the run continues. The final `result` repeats the whole deck.
          onCards: (batch: Card[]) => send({ type: "cards", cards: batch }),
        });
        cards.push(...result.cards);
        dropped += result.dropped;
        fixed += result.fixed;
        duplicates += result.duplicates;

        if (!cards.length) {
          send({
            type: "error",
            error:
              dropped > 0
                ? `Every card "${cfg.model}" produced was making things up rather than reading the text, so all ${dropped} were dropped. Try a larger model.`
                : "Couldn't find anything to make flashcards from in that.",
          });
        } else {
          putCached(key, {
            cards,
            sourceText: body,
            scopeLabel,
            dropped,
            fixed,
            duplicates,
          });
          send({
            type: "result",
            cards,
            dropped,
            fixed,
            duplicates,
            scope: scopeLabel,
            style,
            pipeline: pipelineFor(pipelineId).id,
          });
        }
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "Something went wrong." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
