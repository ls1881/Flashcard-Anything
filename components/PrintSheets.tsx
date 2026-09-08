import { backSheetOrder, paginate, type Card, type FlipEdge } from "@/lib/duplex";

/**
 * Front sheet then back sheet, per page, so a duplex print lands each definition
 * directly behind its own term.
 */
export default function PrintSheets({
  cards,
  flip,
}: {
  cards: Card[];
  flip: FlipEdge;
}) {
  return (
    <div className="sheets" aria-hidden="true">
      {paginate(cards).map((page, i) => (
        <div key={i}>
          <div className="sheet">
            {page.map((card, j) => (
              <div key={j} className="cell cell-front">
                {card?.term ?? ""}
              </div>
            ))}
          </div>
          <div className="sheet">
            {backSheetOrder(page, flip).map((card, j) => (
              <div key={j} className="cell cell-back">
                {card?.definition ?? ""}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
