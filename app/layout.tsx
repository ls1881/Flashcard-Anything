import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flashcard Anything",
  description: "Turn slides, PDFs, docs, and images into study flashcards.",
};

/**
 * Settings load after hydration, which would show a flash of the wrong theme. Read the
 * stored choice before the first paint instead.
 */
const THEME_SCRIPT = `try{var s=JSON.parse(localStorage.getItem("flashcard-anything:settings")||"{}");
document.documentElement.setAttribute("data-theme",s.theme==="dark"?"dark":"light");}catch(e){
document.documentElement.setAttribute("data-theme","light");}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /**
     * The script above stamps data-theme before React hydrates, so this element's
     * attributes deliberately differ from the server's markup — the theme lives in
     * localStorage, which the server cannot see. suppressHydrationWarning silences the
     * mismatch for this element only; it does not extend to the tree below.
     */
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
