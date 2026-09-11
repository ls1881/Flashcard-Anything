import { NextResponse } from "next/server";
import { resolveKey, type LlmConfig } from "@/lib/llm";
import { PROVIDERS, isProviderId } from "@/lib/providers";
import { regenerateCard } from "@/lib/regenerate";
import type { Card } from "@/lib/duplex";

export const runtime = "nodejs";
export const maxDuration = 120;

/** One card, rewritten. A single model call rather than a whole rerun. */
export async function POST(req: Request) {
  let body: {
    card?: Card;
    sourceText?: string;
    otherCards?: Card[];
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const card = body.card;
  if (!card || typeof card.term !== "string" || typeof card.definition !== "string") {
    return NextResponse.json({ error: "No card to rewrite." }, { status: 400 });
  }
  const sourceText = typeof body.sourceText === "string" ? body.sourceText : "";
  if (!sourceText.trim()) {
    return NextResponse.json(
      {
        error:
          "This deck was made before source text was kept, so there's nothing to rewrite from. Edit the card by hand, or make the deck again.",
      },
      { status: 409 }
    );
  }

  const provider = String(body.provider ?? "ollama");
  if (!isProviderId(provider)) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }
  const cfg: LlmConfig = {
    provider,
    model: String(body.model ?? "").trim() || PROVIDERS[provider].defaultModel,
    apiKey: resolveKey(provider, String(body.apiKey ?? "")),
    baseUrl: String(body.baseUrl ?? "").trim() || undefined,
  };

  try {
    const result = await regenerateCard({
      cfg,
      card,
      sourceText,
      otherCards: Array.isArray(body.otherCards) ? body.otherCards : [],
    });
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 422 });
    return NextResponse.json({ card: result.card });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
