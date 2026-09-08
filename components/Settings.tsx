"use client";

import { useEffect, useState } from "react";
import { PROVIDERS, PROVIDER_LIST, type ProviderId, type Settings } from "@/lib/providers";

export function modelFor(settings: Settings, provider = settings.provider): string {
  return settings.models[provider]?.trim() || PROVIDERS[provider].defaultModel;
}

export function keyFor(settings: Settings, provider = settings.provider): string {
  return settings.keys[provider] ?? "";
}

export default function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}) {
  const provider = settings.provider;
  const info = PROVIDERS[provider];
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const key = keyFor(settings);

  // Suggest real model names per provider; the field stays free text either way.
  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    setNote(null);
    const params = new URLSearchParams({ provider });
    if (key) params.set("key", key);
    fetch(`/api/models?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setSuggestions(data.models ?? []);
        setNote(data.note ?? null);
      })
      .catch(() => {
        if (!cancelled) setNote("Couldn't list models — you can still type one in.");
      });
    return () => {
      cancelled = true;
    };
  }, [provider, key]);

  function pick(next: ProviderId) {
    onChange({ ...settings, provider: next });
  }

  return (
    <div className="settings">
      <div className="seg">
        {PROVIDER_LIST.map((p) => (
          <button
            key={p.id}
            className={p.id === provider ? "on" : ""}
            onClick={() => pick(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <p className="blurb">{info.blurb}</p>

      {info.needsKey && (
        <label className="field">
          <span>
            API key
            {info.keyUrl && (
              <a href={info.keyUrl} target="_blank" rel="noreferrer">
                get one
              </a>
            )}
          </span>
          <input
            type="password"
            value={key}
            placeholder={info.keyPrefix ? `${info.keyPrefix}…` : "Paste your key"}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) =>
              onChange({ ...settings, keys: { ...settings.keys, [provider]: e.target.value } })
            }
          />
        </label>
      )}

      <label className="field">
        <span>Model</span>
        <input
          list="model-suggestions"
          value={modelFor(settings)}
          spellCheck={false}
          onChange={(e) =>
            onChange({ ...settings, models: { ...settings.models, [provider]: e.target.value } })
          }
        />
        <datalist id="model-suggestions">
          {suggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      {note && <p className="note">{note}</p>}
      {info.needsKey && (
        <p className="note">
          Stored in this browser only, and sent straight to {info.label}. You can use a{" "}
          <code>.env.local</code> key instead and leave this blank.
        </p>
      )}

      <button className="ghost done" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
