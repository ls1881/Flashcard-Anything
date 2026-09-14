import { backSheetOrder, paginate, type Card, type FlipEdge, type Layout } from "@/lib/duplex";
import type { CardStyle } from "@/lib/style";

/** Trim floating-point noise so the CSS reads as inches, not 3.6339999999in. */
const inches = (n: number) => `${Math.round(n * 10000) / 10000}in`;

/**
 * Front sheet then back sheet, per page, so a duplex print lands each definition
 * directly behind its own term.
 *
 * The grid comes from the layout rather than the stylesheet, because paper size
 * and card size are chosen at print time. `@page` has to be a real rule — it
 * cannot be set from an inline style — so it is emitted here alongside them.
 */
export default function PrintSheets({
  cards,
  flip,
  layout,
  style = "definition",
}: {
  cards: Card[];
  flip: FlipEdge;
  layout: Layout;
  style?: CardStyle;
}) {
  const sheet = {
    width: inches(layout.paper.width),
    height: inches(layout.paper.height),
    padding: inches(layout.margin),
    gridTemplateColumns: `repeat(${layout.cols}, ${inches(layout.cellWidth)})`,
    gridTemplateRows: `repeat(${layout.rows}, ${inches(layout.cellHeight)})`,
    // A card smaller than the page leaves the remainder at the edges rather
    // than stretched across the gaps, so the cut size is the size chosen.
    justifyContent: "center" as const,
    alignContent: "center" as const,
  };

  return (
    <>
      <style>{`@page { size: ${layout.paper.cssSize} portrait; margin: 0; }`}</style>
      <div className="sheets" aria-hidden="true">
        {paginate(cards, layout.perPage).map((page, i) => (
          <div key={i}>
            <div className={`sheet sheet-${layout.cardSize.id} sheet-style-${style}`} style={sheet}>
              {page.map((card, j) => (
                <div key={j} className="cell cell-front">
                  {card?.term ?? ""}
                </div>
              ))}
            </div>
            <div className={`sheet sheet-${layout.cardSize.id} sheet-style-${style}`} style={sheet}>
              {backSheetOrder(page, flip, layout).map((card, j) => (
                <div key={j} className="cell cell-back">
                  {card?.definition ?? ""}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
