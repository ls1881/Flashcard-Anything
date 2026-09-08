"use client";

import { useEffect, useState } from "react";
import {
  PROVIDERS,
  PROVIDER_LIST,
  type ProviderId,
  type Settings,
  type ThemeChoice,
} from "@/lib/providers";

export function modelFor(settings: Settings, provider = settings.provider): string {
  return settings.models[provider]?.trim() || PROVIDERS[provider].defaultModel;
}

export function keyFor(settings: Settings, provider = settings.provider): string {
  return settings.keys[provider] ?? "";
}

export function baseUrlFor(settings: Settings, provider = settings.provider): string {
  return settings.baseUrls[provider]?.trim() || "";
}

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

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
  const baseUrl = baseUrlFor(settings);

  // Suggest real model names per provider; the field stays free text either way.
  // Debounced because the key and URL are typed: firing per keystroke would send a
  // hundred rejected requests to the provider and risk rate limiting.
  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    setNote(null);

    const timer = setTimeout(() => {
      const params = new URLSearchParams({ provider });
      if (key) params.set("key", key);
      if (baseUrl) params.set("baseUrl", baseUrl);
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
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [provider, key, baseUrl]);

  return (
    <div className="settings">
      <label className="field">
        <span>Provider</span>
        <select
          value={provider}
          onChange={(e) => onChange({ ...settings, provider: e.target.value as ProviderId })}
        >
          {PROVIDER_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <p className="blurb">{info.blurb}</p>

      {info.editableBaseUrl && (
        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            spellCheck={false}
            placeholder="https://my-endpoint/v1"
            onChange={(e) =>
              onChange({
                ...settings,
                baseUrls: { ...settings.baseUrls, [provider]: e.target.value },
              })
            }
          />
        </label>
      )}

      {(info.needsKey || info.editableBaseUrl) && (
        <label className="field">
          <span>
            API key{info.editableBaseUrl && !info.needsKey ? " (if required)" : ""}
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
          placeholder={info.defaultModel || "Choose after adding your key"}
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

      <div className="field">
        <span>Appearance</span>
        <div className="seg">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={settings.theme === t.id ? "on" : ""}
              onClick={() => onChange({ ...settings, theme: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <button className="ghost done" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
