import { NextResponse } from "next/server";
import { buildApkg } from "@/lib/anki";
import type { Card } from "@/lib/duplex";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * A deck as an Anki package. Built here rather than in the page because the
 * file is a SQLite database, and `node:sqlite` only exists on the server.
 */
export async function POST(req: Request) {
  let body: { name?: string; cards?: Card[]; deckKey?: string; source?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const cards = Array.isArray(body.cards)
    ? body.cards.filter(
        (c) =>
          c && typeof c.term === "string" && typeof c.definition === "string" &&
          c.term.trim() && c.definition.trim()
      )
    : [];
  if (!cards.length) {
    return NextResponse.json({ error: "There are no cards to export." }, { status: 400 });
  }

  try {
    const bytes = await buildApkg({
      name: String(body.name ?? "").trim() || "Flashcard Anything",
      cards,
      // Falls back to the name so a deck with no id still round-trips: the key
      // only has to be stable for this deck, not globally unique.
      deckKey: String(body.deckKey ?? "").trim() || String(body.name ?? "deck"),
      source: typeof body.source === "string" ? body.source : null,
    });
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Couldn't build the Anki package.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
