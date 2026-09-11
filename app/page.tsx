"use client";

import { useEffect, useRef, useState } from "react";
import PrintSheets from "@/components/PrintSheets";
import SettingsPanel, { baseUrlFor, keyFor, modelFor } from "@/components/Settings";
import { DEFAULT_SETTINGS, PROVIDERS, type Settings } from "@/lib/providers";
import type { Card, FlipEdge } from "@/lib/duplex";
import {
  PASTED,
  available,
  deleteDeck,
  exportFileName,
  formatWhen,
  getDeck,
  listDecks,
  newDeck,
  putDeck,
  renameDeck,
  replaceCard,
  type Deck,
  type DeckMeta,
} from "@/lib/decks";

const STORAGE_KEY = "flashcard-anything:settings";
/** Which deck to reopen on a refresh, so a reload doesn't dump you on the form. */
const LAST_DECK_KEY = "flashcard-anything:last-deck";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [scope, setScope] = useState("");
  const [deck, setDeck] = useState<Deck | null>(null);
  /** Cards that have arrived from the current run but aren't a saved deck yet. */
  const [streamed, setStreamed] = useState<Card[]>([]);
  /** Set when a run died partway but had already written real cards. */
  const [partial, setPartial] = useState<string | null>(null);
  /** Index of the card open for editing, and the draft being typed into it. */
  const [editing, setEditing] = useState<number | null>(null);
  const [draftTerm, setDraftTerm] = useState("");
  const [draftDefinition, setDraftDefinition] = useState("");
  /** Index of the card currently being rewritten by the model. */
  const [rewriting, setRewriting] = useState<number | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [decks, setDecks] = useState<DeckMeta[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [unsaved, setUnsaved] = useState(false);
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

  // Decks live in IndexedDB in this browser. A refusal to open it (private
  // window, storage disabled) is not fatal — you just lose the list.
  useEffect(() => {
    if (!available()) {
      setUnsaved(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const saved = await listDecks();
        if (cancelled) return;
        setDecks(saved);

        const last = localStorage.getItem(LAST_DECK_KEY);
        if (!last) return;
        const reopened = await getDeck(last);
        if (cancelled) return;
        if (reopened) setDeck(reopened);
        else localStorage.removeItem(LAST_DECK_KEY);
      } catch {
        if (!cancelled) setUnsaved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  async function refreshDecks() {
    try {
      setDecks(await listDecks());
    } catch {
      setUnsaved(true);
    }
  }

  function rememberOpen(id: string | null) {
    try {
      if (id) localStorage.setItem(LAST_DECK_KEY, id);
      else localStorage.removeItem(LAST_DECK_KEY);
    } catch {
      // Losing the pointer only costs you the reopen, not the deck.
    }
  }

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
    setStreamed([]);
    setPartial(null);
    setCardError(null);
    setEditing(null);
    setFlipped(new Set());
    // Kept alongside the state so the catch below can still see what arrived:
    // a setState value would be stale by the time an error is thrown.
    const collected: Card[] = [];
    let sourceText = "";
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
          else if (msg.type === "source") sourceText = String(msg.sourceText ?? "");
          else if (msg.type === "cards") {
            // A section finished. Show its cards now rather than making the
            // reader wait for the sections still to come.
            collected.push(...(msg.cards as Card[]));
            setStreamed([...collected]);
          } else if (msg.type === "result") {
            const made = newDeck({
              cards: msg.cards as Card[],
              source: file?.name ?? PASTED,
              scope: msg.scope ?? null,
              model: { provider: settings.provider, name: modelFor(settings) },
              sourceText,
            });
            setDeck(made);
            setStreamed([]);
            void save(made);
          }
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Something went wrong.";
      if (collected.length > 0) {
        // The run died, but sections that already finished wrote real cards.
        // Throwing away ten minutes of work over a failed last chunk would be
        // worse than handing over a short deck and saying what happened.
        const made = newDeck({
          cards: collected,
          source: file?.name ?? PASTED,
          scope: null,
          model: { provider: settings.provider, name: modelFor(settings) },
          sourceText,
        });
        setDeck(made);
        setStreamed([]);
        setPartial(message);
        void save(made);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /** Write a finished deck to disk. Failing here loses the deck on reload, so say so. */
  async function save(made: Deck) {
    try {
      await putDeck(made);
      rememberOpen(made.id);
      setUnsaved(false);
      await refreshDecks();
    } catch {
      setUnsaved(true);
    }
  }

  async function openDeck(id: string) {
    try {
      const saved = await getDeck(id);
      if (!saved) {
        // Deleted in another tab; resync rather than showing a ghost.
        await refreshDecks();
        return;
      }
      setDeck(saved);
      setFlipped(new Set());
      setError(null);
      setPartial(null);
      rememberOpen(id);
    } catch {
      setUnsaved(true);
    }
  }

  function startRename(target: { id: string; name: string }) {
    setRenamingId(target.id);
    setDraftName(target.name);
  }

  async function commitRename() {
    const id = renamingId;
    if (!id) return;
    const name = draftName.trim();
    setRenamingId(null);
    if (!name) return;
    // In memory first, so a deck that never reached disk still renames.
    setDeck((current) => (current && current.id === id ? { ...current, name } : current));
    setDecks((current) => current.map((d) => (d.id === id ? { ...d, name } : d)));
    try {
      await renameDeck(id, name);
      await refreshDecks();
    } catch {
      setUnsaved(true);
    }
  }

  async function removeDeck(target: DeckMeta) {
    const count = `${target.count} card${target.count === 1 ? "" : "s"}`;
    if (!window.confirm(`Delete "${target.name}" (${count})? This cannot be undone.`)) return;
    try {
      await deleteDeck(target.id);
      if (deck?.id === target.id) {
        setDeck(null);
        setPartial(null);
        rememberOpen(null);
      }
      await refreshDecks();
    } catch {
      setUnsaved(true);
    }
  }

  /** Back to the form. The open deck stays on disk; this only closes it. */
  function reset() {
    setDeck(null);
    setStreamed([]);
    setPartial(null);
    setFile(null);
    setText("");
    setScope("");
    setError(null);
    setFlipped(new Set());
    setRenamingId(null);
    rememberOpen(null);
    void refreshDecks();
  }

  function exportJson() {
    if (!deck) return;
    const payload = {
      version: 1,
      generatedAt: new Date(deck.createdAt).toISOString(),
      source: deck.source,
      scope: deck.scope,
      model: deck.model,
      count: deck.cards.length,
      cards: deck.cards.map(({ term, definition, evidence }) => ({ term, definition, evidence })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName(deck.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Persist a card change and keep the deck list's count and timestamp honest. */
  async function commit(next: Deck) {
    setDeck(next);
    try {
      await putDeck(next);
      await refreshDecks();
    } catch {
      setUnsaved(true);
    }
  }

  function startEdit(index: number, card: Card) {
    setEditing(index);
    setDraftTerm(card.term);
    setDraftDefinition(card.definition);
    setCardError(null);
  }

  async function commitEdit() {
    const index = editing;
    if (index === null || !deck) return;
    setEditing(null);
    const next = replaceCard(deck, index, {
      term: draftTerm,
      definition: draftDefinition,
      evidence: deck.cards[index]?.evidence,
    });
    // replaceCard returns the same deck when nothing usable changed.
    if (next !== deck) await commit(next);
  }

  /** One model call against the slice of the source this card came from. */
  async function rewrite(index: number) {
    if (!deck || rewriting !== null) return;
    const card = deck.cards[index];
    if (!card) return;
    setRewriting(index);
    setCardError(null);
    try {
      const res = await fetch("/api/card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          card,
          sourceText: deck.sourceText ?? "",
          otherCards: deck.cards.filter((_, i) => i !== index),
          provider: settings.provider,
          model: modelFor(settings),
          apiKey: keyFor(settings),
          baseUrl: baseUrlFor(settings) || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't rewrite that card.");
      const next = replaceCard(deck, index, data.card as Card);
      if (next !== deck) await commit(next);
    } catch (e) {
      setCardError(e instanceof Error ? e.message : "Couldn't rewrite that card.");
    } finally {
      setRewriting(null);
    }
  }

  function toggle(i: number) {
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  // Shared by the full-page loading panel and the live bar above streamed cards.
  const phaseLabel = progress
    ? `${progress.phase === "checking" ? "Checking accuracy" : "Reading"}${
        progress.total > 1
          ? ` · section ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`
          : ""
      }`
    : "Reading your material and writing cards…";

  // One control, used from the bar and from the deck list.
  const nameField = (
    <input
      className="rename"
      value={draftName}
      autoFocus
      aria-label="Deck name"
      onChange={(e) => setDraftName(e.target.value)}
      onBlur={commitRename}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitRename();
        else if (e.key === "Escape") setRenamingId(null);
      }}
    />
  );

  // The deck view doubles as the live view: cards land in this grid as each
  // section is written, then the finished deck takes over the same grid.
  const showing = deck ? deck.cards : streamed;

  if (showing.length > 0) {
    return (
      <>
        <div className="wrap screen">
          <div className="bar">
            {deck ? (
              <>
                {renamingId === deck.id ? (
                  nameField
                ) : (
                  <button
                    className="deck-title"
                    title="Click to rename"
                    onClick={() => startRename(deck)}
                  >
                    {deck.name}
                  </button>
                )}
                <span className="count">
                  {deck.scope ? `${deck.scope} · ` : ""}
                  {showing.length} flashcards
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
                  All decks
                </button>
              </>
            ) : (
              <span className="count live">
                <span className="spinner" />
                {phaseLabel} · {showing.length} card{showing.length === 1 ? "" : "s"} so far
              </span>
            )}
          </div>

          {partial && (
            <div className="notice">
              This run stopped before it finished — {partial} The {showing.length} card
              {showing.length === 1 ? "" : "s"} written before that are saved.
            </div>
          )}

          {cardError && <div className="notice">{cardError}</div>}

          <div className="grid">
            {showing.map((card, i) => (
              <div className="card" key={i}>
                {editing === i ? (
                  <div className="card-edit">
                    <input
                      className="edit-term"
                      value={draftTerm}
                      aria-label="Term"
                      autoFocus
                      onChange={(e) => setDraftTerm(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        else if (e.key === "Escape") setEditing(null);
                      }}
                    />
                    <textarea
                      className="edit-definition"
                      value={draftDefinition}
                      aria-label="Definition"
                      onChange={(e) => setDraftDefinition(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                    <div className="card-edit-actions">
                      <button className="ghost" onClick={commitEdit}>
                        Save
                      </button>
                      <button className="linkish" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      className={`flip flip-${flip}${flipped.has(i) ? " flipped" : ""}${
                        rewriting === i ? " busy" : ""
                      }`}
                      onClick={() => toggle(i)}
                    >
                      <div className="flip-inner">
                        <div className="face face-front">{card.term}</div>
                        <div className="face face-back">{card.definition}</div>
                      </div>
                    </button>
                    {/* Only on a saved deck: a card still streaming has nowhere
                        to save an edit to yet. */}
                    {deck && (
                      <div className="card-actions">
                        <button className="linkish" onClick={() => startEdit(i, card)}>
                          Edit
                        </button>
                        <button
                          className="linkish"
                          disabled={rewriting !== null}
                          onClick={() => rewrite(i)}
                        >
                          {rewriting === i ? "Rewriting…" : "Rewrite"}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          <p className="hint">
            {deck ? (
              <>
                Click a card to flip it. Printing gives you double-sided pages — set your
                printer to two-sided and match the flip edge above.
                {unsaved
                  ? " This browser won't save decks, so export the JSON if you need to keep this one."
                  : " This deck is saved in this browser and will still be here after a reload."}
              </>
            ) : (
              "Cards appear as each section is written. The rest are still coming — you can start reading these now."
            )}
          </p>
        </div>

        {deck && <PrintSheets cards={deck.cards} flip={flip} />}
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
            {phaseLabel}
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

      {!busy && decks.length > 0 && (
        <div className="decks">
          <div className="decks-head">
            <h2>Saved decks</h2>
            <span>kept in this browser</span>
          </div>
          <ul>
            {decks.map((d) => (
              <li key={d.id}>
                {renamingId === d.id ? (
                  nameField
                ) : (
                  <button className="deck-open" onClick={() => openDeck(d.id)}>
                    <b>{d.name}</b>
                    <span>
                      {d.count} card{d.count === 1 ? "" : "s"} · {formatWhen(d.updatedAt)}
                    </span>
                  </button>
                )}
                <button className="linkish" onClick={() => startRename(d)}>
                  Rename
                </button>
                <button className="linkish danger" onClick={() => removeDeck(d)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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
