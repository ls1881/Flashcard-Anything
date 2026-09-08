export type Card = { term: string; definition: string };

/** Letter portrait, 0.5in margins, cards tile edge-to-edge at 3.75in x 3.3333in. */
export const COLS = 2;
export const ROWS = 3;
export const PER_PAGE = COLS * ROWS;

export type FlipEdge = "long" | "short";

/** Split into fixed-size pages, padding the last page so every sheet has the same grid. */
export function paginate(cards: Card[]): (Card | null)[][] {
  const pages: (Card | null)[][] = [];
  for (let i = 0; i < cards.length; i += PER_PAGE) {
    const page: (Card | null)[] = cards.slice(i, i + PER_PAGE);
    while (page.length < PER_PAGE) page.push(null);
    pages.push(page);
  }
  return pages;
}

/**
 * Reorder a page's cards for the reverse sheet so each back lands behind its own front.
 *
 * The printer lays both sides down in the same coordinate system, so the mirroring
 * depends on which edge the paper is flipped over:
 *
 *   long edge  (rotates about the vertical axis)   -> back(r, c) sits behind front(r, COLS-1-c)
 *   short edge (rotates about the horizontal axis) -> back(r, c) sits behind front(ROWS-1-r, c)
 */
export function backSheetOrder(
  page: (Card | null)[],
  flip: FlipEdge
): (Card | null)[] {
  const out: (Card | null)[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const sr = flip === "short" ? ROWS - 1 - r : r;
      const sc = flip === "long" ? COLS - 1 - c : c;
      out.push(page[sr * COLS + sc]);
    }
  }
  return out;
}
