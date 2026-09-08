"use client";

import { useRef, useState } from "react";
import PrintSheets from "@/components/PrintSheets";
import type { Card, FlipEdge } from "@/lib/duplex";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [cards, setCards] = useState<Card[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [flip, setFlip] = useState<FlipEdge>("long");
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const ready = Boolean(file) || text.trim().length > 0;

  async function generate() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      if (file) body.append("file", file);
      else body.append("text", text);
      const res = await fetch("/api/generate", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setCards(data.cards as Card[]);
      setFlipped(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setCards(null);
    setFile(null);
    setText("");
    setError(null);
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
            <span className="count">{cards.length} flashcards</span>
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
            Reading your material and writing cards…
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

            <button className="primary" onClick={generate} disabled={!ready}>
              Make flashcards
            </button>

            {error && <div className="error">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
