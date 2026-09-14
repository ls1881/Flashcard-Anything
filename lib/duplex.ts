export type Card = {
  term: string;
  definition: string;
  /** Verbatim span from the source that supports the definition. */
  evidence?: string;
};

export type FlipEdge = "long" | "short";

/**
 * Print geometry. Everything is inches, because the print CSS is inches and
 * converting once here beats converting at every use.
 *
 * The layout used to be six cards on US Letter and nothing else, which made the
 * whole print feature unusable outside North America. Paper and card size are
 * now two separate choices, and the grid is whatever falls out of fitting one
 * into the other.
 */

const MM = 1 / 25.4;

export type PaperId = "letter" | "a4";

export type Paper = {
  id: PaperId;
  label: string;
  width: number;
  height: number;
  /** What `@page size` has to say to get this sheet. */
  cssSize: string;
};

export const PAPERS: Record<PaperId, Paper> = {
  letter: { id: "letter", label: "US Letter", width: 8.5, height: 11, cssSize: "letter" },
  a4: { id: "a4", label: "A4", width: 210 * MM, height: 297 * MM, cssSize: "A4" },
};

export const PAPER_LIST: Paper[] = [PAPERS.letter, PAPERS.a4];

/** Every printer refuses to print to the very edge; this clears the usual limit. */
export const MARGIN = 0.5;

export type CardSizeId = "fit" | "index" | "business";

export type CardSize =
  | { id: CardSizeId; label: string; kind: "fit"; cols: number; rows: number }
  | { id: CardSizeId; label: string; kind: "fixed"; width: number; height: number };

export const CARD_SIZES: Record<CardSizeId, CardSize> = {
  // No fixed size: the cards are whatever divides the page six ways, which is
  // what this printed before any of this was configurable.
  fit: { id: "fit", label: "6 per sheet", kind: "fit", cols: 2, rows: 3 },
  index: { id: "index", label: "Index card (5 × 3 in)", kind: "fixed", width: 5, height: 3 },
  business: {
    id: "business",
    label: "Business card (3.5 × 2 in)",
    kind: "fixed",
    width: 3.5,
    height: 2,
  },
};

export const CARD_SIZE_LIST: CardSize[] = [
  CARD_SIZES.fit,
  CARD_SIZES.index,
  CARD_SIZES.business,
];

export type Layout = {
  paper: Paper;
  cardSize: CardSize;
  cols: number;
  rows: number;
  perPage: number;
  /** The grid cell, which is also the cut size of a card. */
  cellWidth: number;
  cellHeight: number;
  margin: number;
};

export function isPaperId(id: string): id is PaperId {
  return id in PAPERS;
}

export function isCardSizeId(id: string): id is CardSizeId {
  return id in CARD_SIZES;
}

/**
 * How many cards of a given size fit on a given sheet, and how big each cell is.
 *
 * A fixed-size card is tried both ways up and the orientation that fits more
 * cards wins: a 5×3 index card laid landscape on Letter wastes half the page at
 * one per row, where the same card turned portrait gives four per sheet. Ties
 * keep the size as written, so a business card stays landscape.
 */
export function layoutFor(paperId: PaperId, cardSizeId: CardSizeId): Layout {
  // Unknown ids fall back rather than throwing. The selects only offer valid
  // ones, but this is read from stored settings, and a value written by a newer
  // version — or edited by hand — should cost you your paper choice, not the
  // whole page.
  const paper = PAPERS[paperId] ?? PAPERS.letter;
  const cardSize = CARD_SIZES[cardSizeId] ?? CARD_SIZES.fit;
  const usableWidth = paper.width - MARGIN * 2;
  const usableHeight = paper.height - MARGIN * 2;

  if (cardSize.kind === "fit") {
    const { cols, rows } = cardSize;
    return {
      paper,
      cardSize,
      cols,
      rows,
      perPage: cols * rows,
      cellWidth: usableWidth / cols,
      cellHeight: usableHeight / rows,
      margin: MARGIN,
    };
  }

  const fit = (w: number, h: number) => {
    const cols = Math.floor(usableWidth / w);
    const rows = Math.floor(usableHeight / h);
    return { cols, rows, count: cols * rows, width: w, height: h };
  };
  const asWritten = fit(cardSize.width, cardSize.height);
  const turned = fit(cardSize.height, cardSize.width);
  const best = turned.count > asWritten.count ? turned : asWritten;

  // A card too big for the paper still has to produce a printable sheet rather
  // than a zero-column grid, so fall back to one card per page.
  const cols = Math.max(1, best.cols);
  const rows = Math.max(1, best.rows);

  return {
    paper,
    cardSize,
    cols,
    rows,
    perPage: cols * rows,
    cellWidth: Math.min(best.width, usableWidth),
    cellHeight: Math.min(best.height, usableHeight),
    margin: MARGIN,
  };
}

/** Split into fixed-size pages, padding the last page so every sheet has the same grid. */
export function paginate(cards: Card[], perPage: number): (Card | null)[][] {
  const pages: (Card | null)[][] = [];
  const size = Math.max(1, Math.floor(perPage));
  for (let i = 0; i < cards.length; i += size) {
    const page: (Card | null)[] = cards.slice(i, i + size);
    while (page.length < size) page.push(null);
    pages.push(page);
  }
  return pages;
}

/**
 * Reorder a page's cards for the reverse sheet so each back lands behind its own term.
 *
 * The printer lays both sides down in the same coordinate system, so the mirroring
 * depends on which edge the paper is flipped over:
 *
 *   long edge  (rotates about the vertical axis)   -> back(r, c) sits behind front(r, cols-1-c)
 *   short edge (rotates about the horizontal axis) -> back(r, c) sits behind front(rows-1-r, c)
 *
 * Those are the *sheet's* long and short edges. On screen the same two words are
 * read against the card, which is the other way up — see the note in PLAN.md.
 */
export function backSheetOrder(
  page: (Card | null)[],
  flip: FlipEdge,
  layout: Pick<Layout, "cols" | "rows">
): (Card | null)[] {
  const { cols, rows } = layout;
  const out: (Card | null)[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sr = flip === "short" ? rows - 1 - r : r;
      const sc = flip === "long" ? cols - 1 - c : c;
      out.push(page[sr * cols + sc] ?? null);
    }
  }
  return out;
}
