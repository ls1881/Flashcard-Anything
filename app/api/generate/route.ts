import { NextResponse } from "next/server";
import {
  buildGlossary,
  chunkText,
  fileToSource,
  MAX_BYTES,
  removeRepeatedLines,
  repeatedLines,
  type Source,
} from "@/lib/extract";
import { completeText, resolveKey, type LlmConfig } from "@/lib/llm";
import { PROVIDERS, isProviderId } from "@/lib/providers";
import { pipelineFor, type Progress } from "@/lib/pipelines";
import { buildOutline, findScope, tableOfContents } from "@/lib/outline";
import type { Card } from "@/lib/duplex";

type TextSource = Extract<Source, { kind: "text" }>;

export const runtime = "nodejs";
export const maxDuration = 800;

const MAX_CARDS = 60;
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

  try {
    const form = await req.formData();
    const file = form.get("file");
    const text = String(form.get("text") ?? "").trim();
    scopeRequest = String(form.get("scope") ?? "").trim();
    pipelineId = String(form.get("pipeline") ?? "").trim();
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

    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_BYTES) {
        return NextResponse.json(
          { error: `"${file.name}" is over the ${MAX_BYTES / 1024 / 1024}MB limit.` },
          { status: 413 }
        );
      }
      source = await fileToSource(file);
    } else if (text) {
      source = { kind: "text", text, pages: [text] };
    } else {
      return NextResponse.json({ error: "Add a file or some text first." }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Couldn't read that file.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Narrow a big document to the requested part before anything reaches a model.
  let scopeLabel: string | null = null;
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
              error: `"${cfg.model}" couldn't read any text in that image. Use a vision model such as qwen2.5vl:7b, or upload the document itself.`,
            });
            controller.close();
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

        const pipeline = pipelineFor(pipelineId);
        const result = await pipeline.run({
          cfg,
          chunks,
          context,
          glossary,
          maxCards: MAX_CARDS,
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
          send({
            type: "result",
            cards,
            dropped,
            fixed,
            duplicates,
            scope: scopeLabel,
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
