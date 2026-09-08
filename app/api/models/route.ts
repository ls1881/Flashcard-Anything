import { NextResponse } from "next/server";
import { PROVIDERS, isProviderId } from "@/lib/providers";
import { resolveKey } from "@/lib/llm";

export const runtime = "nodejs";

/**
 * Suggests model names for the settings panel. Best-effort: if a provider can't be
 * reached the panel just falls back to free text.
 */
export async function GET(req: Request) {
  const provider = new URL(req.url).searchParams.get("provider");
  if (!isProviderId(provider)) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }

  const key = resolveKey(provider, new URL(req.url).searchParams.get("key") ?? undefined);

  try {
    if (provider === "ollama") {
      const res = await fetch("http://localhost:11434/api/tags");
      if (!res.ok) throw new Error("no tags");
      const data = await res.json();
      const models = (data?.models ?? []).map((m: { name: string }) => m.name).sort();
      return NextResponse.json({
        models,
        note: models.length
          ? undefined
          : "No models pulled yet. Run `ollama pull qwen3:8b` in a terminal.",
      });
    }

    if (provider === "openrouter") {
      const res = await fetch(`${PROVIDERS.openrouter.baseUrl}/models`);
      if (!res.ok) throw new Error("list failed");
      const data = await res.json();
      const models = (data?.data ?? []).map((m: { id: string }) => m.id).sort();
      return NextResponse.json({ models });
    }

    if (!key) return NextResponse.json({ models: [], note: "Add a key to list models." });
    const res = await fetch(`${PROVIDERS.anthropic.baseUrl}/v1/models?limit=50`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error("list failed");
    const data = await res.json();
    const models = (data?.data ?? []).map((m: { id: string }) => m.id);
    return NextResponse.json({ models });
  } catch {
    const note =
      provider === "ollama"
        ? "Ollama isn't running. Start it with `ollama serve`."
        : "Couldn't list models — you can still type one in.";
    return NextResponse.json({ models: [], note });
  }
}
