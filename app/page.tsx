"use client";

import { useEffect, useRef, useState } from "react";
import PrintSheets from "@/components/PrintSheets";
import SettingsPanel, { baseUrlFor, keyFor, modelFor } from "@/components/Settings";
import { DEFAULT_SETTINGS, PROVIDERS, type Settings } from "@/lib/providers";
import type { Card, FlipEdge } from "@/lib/duplex";

const STORAGE_KEY = "flashcard-anything:settings";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [scope, setScope] = useState("");
  const [cards, setCards] = useState<Card[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [flip, setFlip] = useState<FlipEdge>("long");
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<{
    phase: "reading" | "checking";
    done: number;
    total: number;
    cards: number;
  } | null>(null);
  const [audit, setAudit] = useState<{ dropped: number; fixed: number } | null>(null);
  const [scopeUsed, setScopeUsed] = useState<string | null>(null);
  const [usedModel, setUsedModel] = useState<{ provider: string; name: string } | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const ready = Boolean(file) || text.trim().length > 0;

  // Settings live in this browser; nothing is written to the repo.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw);
        // Settings saved before the theme was reduced to two choices may say "system".
        if (stored.theme !== "light" && stored.theme !== "dark") stored.theme = "light";
        setSettings({ ...DEFAULT_SETTINGS, ...stored });
      }
    } catch {
      // A blocked or corrupt store just means defaults.
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  function updateSettings(next: Settings) {
    setSettings(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not fatal — the choice just won't survive a reload.
    }
  }

  async function generate() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    setAudit(null);
    try {
      const body = new FormData();
      if (file) body.append("file", file);
      else body.append("text", text);
      if (scope.trim()) body.append("scope", scope.trim());
      body.append("provider", settings.provider);
      body.append("model", modelFor(settings));
      body.append("apiKey", keyFor(settings));
      const custom = baseUrlFor(settings);
      if (custom) body.append("baseUrl", custom);

      const res = await fetch("/api/generate", { method: "POST", body });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Something went wrong.");
      }
      if (!res.body) throw new Error("No response from the server.");

      // NDJSON: progress lines while the local model works, then a result or an error.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: finished } = await reader.read();
        done = finished;
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !finished });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === "progress") setProgress(msg);
          else if (msg.type === "error") throw new Error(msg.error);
          else if (msg.type === "result") {
            setCards(msg.cards as Card[]);
            setAudit({ dropped: msg.dropped ?? 0, fixed: msg.fixed ?? 0 });
            setScopeUsed(msg.scope ?? null);
            setUsedModel({ provider: settings.provider, name: modelFor(settings) });
            setFlipped(new Set());
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function reset() {
    setCards(null);
    setFile(null);
    setText("");
    setScope("");
    setError(null);
  }

  function exportJson() {
    if (!cards) return;
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: file?.name ?? "pasted text",
      scope: scopeUsed,
      model: usedModel ?? { provider: settings.provider, name: modelFor(settings) },
      count: cards.length,
      cards: cards.map(({ term, definition, evidence }) => ({ term, definition, evidence })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(file?.name ?? "flashcards").replace(/\.[^.]+$/, "")}.flashcards.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toggle(i: number) {
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  if (cards) {
    return (
      <>
        <div className="wrap screen">
          <div className="bar">
            <span className="count">
              {scopeUsed ? `${scopeUsed} · ` : ""}
              {cards.length} flashcards
              {audit && (audit.dropped > 0 || audit.fixed > 0) && (
                <span className="checked">
                  {" · "}
                  {[
                    audit.fixed > 0 && `${audit.fixed} corrected`,
                    audit.dropped > 0 && `${audit.dropped} unsupported removed`,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              )}
            </span>
            <label className="edge">
              Flip on
              <select value={flip} onChange={(e) => setFlip(e.target.value as FlipEdge)}>
                <option value="long">Long edge</option>
                <option value="short">Short edge</option>
              </select>
            </label>
            <button className="ghost" onClick={() => window.print()}>
              Print
            </button>
            <button className="ghost" onClick={exportJson}>
              Export JSON
            </button>
            <button className="ghost" onClick={reset}>
              Start over
            </button>
          </div>

          <div className="grid">
            {cards.map((card, i) => (
              <button
                key={i}
                className={`flip${flipped.has(i) ? " flipped" : ""}`}
                onClick={() => toggle(i)}
              >
                <div className="flip-inner">
                  <div className="face face-front">{card.term}</div>
                  <div className="face face-back">{card.definition}</div>
                </div>
              </button>
            ))}
          </div>

          <p className="hint">
            Click a card to flip it. Printing gives you double-sided pages — set your printer to
            two-sided and match the flip edge above.
          </p>
        </div>

        <PrintSheets cards={cards} flip={flip} />
      </>
    );
  }

  return (
    <div className="wrap screen">
      <div className="masthead">
        <h1>Flashcard Anything</h1>
        <p>Slides, PDFs, chapters, notes, screenshots — in, flashcards out.</p>
      </div>

      <div className="panel">
        {busy ? (
          <div className="loading">
            <div className="spinner" />
            {progress
              ? `${progress.phase === "checking" ? "Checking accuracy" : "Reading"}${
                  progress.total > 1
                    ? ` · section ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
                    : ""
                }${progress.cards ? ` · ${progress.cards} cards so far` : ""}`
              : "Reading your material and writing cards…"}
            <div className="sub">
              {settings.provider === "ollama"
                ? "Running on your machine — this can take a minute."
                : `Asking ${PROVIDERS[settings.provider].label}…`}
            </div>
          </div>
        ) : (
          <>
            {file ? (
              <div className="chosen">
                <b>{file.name}</b>
                <button className="linkish" onClick={() => setFile(null)}>
                  Remove
                </button>
              </div>
            ) : (
              <div
                className={`drop${over ? " over" : ""}`}
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(false);
                  const dropped = e.dataTransfer.files[0];
                  if (dropped) setFile(dropped);
                }}
              >
                <strong>Drop a file here</strong>
                <span>PDF, PowerPoint, Word, text, or an image — or click to browse</span>
              </div>
            )}

            <input
              ref={inputRef}
              type="file"
              hidden
              accept=".pdf,.pptx,.docx,.txt,.md,.csv,image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />

            {!file && (
              <>
                <div className="or">or paste text</div>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste a chapter, your notes, a transcript…"
                />
              </>
            )}

            <input
              className="scope"
              value={scope}
              spellCheck={false}
              onChange={(e) => setScope(e.target.value)}
              placeholder={'Which part? e.g. "chapter 3, section 2" — optional'}
            />

            <button className="primary" onClick={generate} disabled={!ready}>
              Make flashcards
            </button>

            {error && <div className="error">{error}</div>}
          </>
        )}
      </div>

      {!busy && (
        <div className="footer">
          {showSettings ? (
            <SettingsPanel
              settings={settings}
              onChange={updateSettings}
              onClose={() => setShowSettings(false)}
            />
          ) : (
            <p>
              Using <b>{PROVIDERS[settings.provider].label}</b> · {modelFor(settings)}{" "}
              <button className="linkish" onClick={() => setShowSettings(true)}>
                Change
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
