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
if(s.theme==="dark"||s.theme==="light")document.documentElement.setAttribute("data-theme",s.theme);}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
