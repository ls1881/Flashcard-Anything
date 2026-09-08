import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flashcard Anything",
  description: "Turn slides, PDFs, docs, and images into study flashcards.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
