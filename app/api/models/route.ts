import { NextResponse } from "next/server";
import { PROVIDERS, isProviderId } from "@/lib/providers";
import { baseUrlFor, resolveKey } from "@/lib/llm";

export const runtime = "nodejs";

/**
 * Suggests model names for the settings panel. Best-effort: if a provider can't be
 * reached the panel just falls back to free text.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const provider = params.get("provider");
  if (!isProviderId(provider)) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 400 });
  }

  const info = PROVIDERS[provider];
  const key = resolveKey(provider, params.get("key") ?? undefined);
  const baseUrl = baseUrlFor(provider, params.get("baseUrl") ?? undefined);

  try {
    if (info.style === "ollama") {
      const res = await fetch(`${baseUrl.replace(/\/v1$/, "")}/api/tags`);
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

    if (info.style === "anthropic") {
      if (!key) return NextResponse.json({ models: [], note: "Add a key to list models." });
      const res = await fetch(`${baseUrl}/v1/models?limit=50`, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!res.ok) throw new Error("list failed");
      const data = await res.json();
      return NextResponse.json({
        models: (data?.data ?? []).map((m: { id: string }) => m.id),
      });
    }

    // Everything else exposes OpenAI's GET /models.
    if (!baseUrl) {
      return NextResponse.json({ models: [], note: "Set a base URL to list models." });
    }
    // Try even without a key — some catalogues (OpenRouter's) are public.
    const res = await fetch(`${baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) {
      if (!key && info.needsKey) {
        return NextResponse.json({ models: [], note: "Add a key to list models." });
      }
      throw new Error("list failed");
    }
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : (data?.models ?? []);
    const models = list
      .map((m: { id?: string; name?: string }) => m.id ?? m.name)
      .filter(Boolean)
      .sort();
    return NextResponse.json({ models });
  } catch {
    const note =
      info.style === "ollama"
        ? "Ollama isn't running. Start it with `ollama serve`."
        : "Couldn't list models — you can still type one in.";
    return NextResponse.json({ models: [], note });
  }
}
