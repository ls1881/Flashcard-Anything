import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { fileToBlocks, MAX_BYTES } from "@/lib/extract";
import type { Card } from "@/lib/duplex";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_CARDS = 60;

const TOOL: Anthropic.Messages.Tool = {
  name: "emit_flashcards",
  description: "Return the finished set of flashcards.",
  input_schema: {
    type: "object",
    properties: {
      cards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            term: {
              type: "string",
              description:
                "The front of the card: a single term, name, or concept. 1-5 words. Never a sentence, question, or definition.",
            },
            definition: {
              type: "string",
              description:
                "The back of the card: the definition or explanation. 1-3 sentences, under 45 words, self-contained.",
            },
          },
          required: ["term", "definition"],
        },
      },
    },
    required: ["cards"],
  },
};

const PROMPT = `Turn the material above into a set of study flashcards.

Rules, applied to every card without exception:
- FRONT ("term") is only the thing being learned: a term, name, concept, formula name, date, or event. 1-5 words. No sentences, no questions, no punctuation at the end, no definition text leaking onto the front.
- BACK ("definition") carries all the substance: the definition or explanation, 1-3 sentences and under 45 words. It must stand on its own without the front being visible.
- One card per distinct concept worth memorizing. Skip filler, title slides, agendas, page numbers, and citations.
- Cover the material evenly from beginning to end. Don't front-load.
- Use the source's own terminology. Never invent facts that aren't in the material.
- No duplicate or near-duplicate fronts.
- Produce as many cards as the material genuinely warrants, up to ${MAX_CARDS}.`;

function normalize(raw: unknown): Card[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const cards: Card[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const term = String((item as Card).term ?? "").replace(/\s+/g, " ").trim();
    const definition = String((item as Card).definition ?? "").replace(/\s+/g, " ").trim();
    if (!term || !definition) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({ term, definition });
    if (cards.length >= MAX_CARDS) break;
  }
  return cards;
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "No ANTHROPIC_API_KEY set. Copy .env.example to .env.local and add your key." },
      { status: 500 }
    );
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    const text = String(form.get("text") ?? "").trim();

    let content: Anthropic.Messages.ContentBlockParam[];
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_BYTES) {
        return NextResponse.json(
          { error: `"${file.name}" is over the ${MAX_BYTES / 1024 / 1024}MB limit.` },
          { status: 413 }
        );
      }
      content = await fileToBlocks(file);
    } else if (text) {
      content = [{ type: "text", text: `Source material:\n\n${text}` }];
    } else {
      return NextResponse.json({ error: "Add a file or some text first." }, { status: 400 });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 8000,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "emit_flashcards" },
      messages: [{ role: "user", content: [...content, { type: "text", text: PROMPT }] }],
    });

    const toolUse = message.content.find((b) => b.type === "tool_use");
    const cards = normalize(
      toolUse && toolUse.type === "tool_use"
        ? (toolUse.input as { cards?: unknown }).cards
        : []
    );

    if (!cards.length) {
      return NextResponse.json(
        { error: "Couldn't find anything to make flashcards from in that." },
        { status: 422 }
      );
    }
    return NextResponse.json({ cards });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Something went wrong.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
