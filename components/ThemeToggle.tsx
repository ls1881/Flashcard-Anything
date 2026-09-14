"use client";

import type { ThemeChoice } from "@/lib/providers";

/**
 * Light and dark, as one symbol in the corner.
 *
 * Appearance was buried in the panel behind "Change model", which is where you
 * go to type an API key — not where anyone looks to turn the lights off. It is
 * a two-state preference with an obvious symbol for each state, so it costs one
 * button and no explanation.
 *
 * The icon shown is the one you would be switching *to*, which is the
 * convention every OS toggle follows: a moon on a light page means "go dark".
 */
export default function ThemeToggle({
  theme,
  onChange,
}: {
  theme: ThemeChoice;
  onChange: (next: ThemeChoice) => void;
}) {
  const next: ThemeChoice = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="theme-toggle"
      onClick={() => onChange(next)}
      title={next === "dark" ? "Switch to dark" : "Switch to light"}
      aria-label={next === "dark" ? "Switch to dark" : "Switch to light"}
    >
      {next === "dark" ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

/* Drawn rather than typed: the emoji sun and moon render as flat black glyphs
   on some platforms and full-colour images on others, neither of which takes
   the page's own colour. */

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.2 8.2 0 1 0 10.2 10.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2" />
        <path d="M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
      </g>
    </svg>
  );
}
