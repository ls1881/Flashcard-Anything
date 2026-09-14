#!/usr/bin/env node --experimental-strip-types
// Run: npm test
import { readFileSync } from "node:fs";
import {
  MARGIN, PAPERS, PAPER_LIST, CARD_SIZES, CARD_SIZE_LIST,
  isPaperId, isCardSizeId, layoutFor, paginate, backSheetOrder,
} from "../lib/duplex.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
/** Inches carry floating-point noise; a ten-thousandth of an inch is nothing. */
const near = (a, b) => Math.abs(a - b) < 0.0001;

const card = (t) => (t === null ? null : { term: t, definition: `def:${t}` });
const deck = (...terms) => terms.map(card);
const names = (page) => page.map((c) => (c ? c.term : ".")).join(" ");

console.log("the papers are the real sizes:");
check("US Letter is 8.5 x 11in", [PAPERS.letter.width, PAPERS.letter.height], [8.5, 11]);
check("A4 is 210mm wide", near(PAPERS.a4.width, 210 / 25.4), true);
check("A4 is 297mm tall", near(PAPERS.a4.height, 297 / 25.4), true);
check("A4 is narrower than Letter", PAPERS.a4.width < PAPERS.letter.width, true);
check("and taller", PAPERS.a4.height > PAPERS.letter.height, true);
check("@page can name both", PAPER_LIST.map((p) => p.cssSize), ["letter", "A4"]);
check("ids are recognised", [isPaperId("a4"), isPaperId("foolscap")], [true, false]);
check("card sizes too", [isCardSizeId("business"), isCardSizeId("huge")], [true, false]);

console.log("\nsix per sheet still divides the page, whatever the paper:");
const letterFit = layoutFor("letter", "fit");
check("2 columns, 3 rows", [letterFit.cols, letterFit.rows], [2, 3]);
check("6 per page", letterFit.perPage, 6);
check("cells are the old 3.75in wide", near(letterFit.cellWidth, 3.75), true);
check("and 3.3333in tall", near(letterFit.cellHeight, 10 / 3), true);

const a4Fit = layoutFor("a4", "fit");
check("A4 keeps the 2x3 grid", [a4Fit.cols, a4Fit.rows], [2, 3]);
check("with narrower cells", a4Fit.cellWidth < letterFit.cellWidth, true);
check("and taller ones", a4Fit.cellHeight > letterFit.cellHeight, true);
check("cells still fill the printable width",
  near(a4Fit.cellWidth * 2, PAPERS.a4.width - MARGIN * 2), true);

console.log("\na fixed card size is turned whichever way fits more on the sheet:");
const letterIndex = layoutFor("letter", "index");
check("a 5x3in index card goes portrait to fit 2 across",
  [letterIndex.cols, letterIndex.rows], [2, 2]);
check("4 per sheet, where landscape would give 3", letterIndex.perPage, 4);
check("the cut size is still 3 x 5in",
  [letterIndex.cellWidth, letterIndex.cellHeight], [3, 5]);

const letterBusiness = layoutFor("letter", "business");
check("a 3.5x2in business card stays landscape",
  [letterBusiness.cols, letterBusiness.rows], [2, 5]);
check("10 per sheet, the standard business-card sheet", letterBusiness.perPage, 10);
check("at its real size", [letterBusiness.cellWidth, letterBusiness.cellHeight], [3.5, 2]);

console.log("\nA4 fits the same fixed cards, since they are physical sizes:");
check("index cards", layoutFor("a4", "index").perPage, 4);
check("at the same cut size",
  [layoutFor("a4", "index").cellWidth, layoutFor("a4", "index").cellHeight], [3, 5]);
check("business cards", layoutFor("a4", "business").perPage, 10);
check("at the same cut size",
  [layoutFor("a4", "business").cellWidth, layoutFor("a4", "business").cellHeight], [3.5, 2]);

console.log("\nnothing ever overflows the paper:");
for (const paper of PAPER_LIST) {
  for (const size of CARD_SIZE_LIST) {
    const l = layoutFor(paper.id, size.id);
    const fitsWide = l.cols * l.cellWidth <= paper.width - MARGIN * 2 + 0.0001;
    const fitsTall = l.rows * l.cellHeight <= paper.height - MARGIN * 2 + 0.0001;
    check(`${paper.label} / ${size.label}: ${l.cols}x${l.rows} = ${l.perPage} per sheet`,
      fitsWide && fitsTall && l.cols >= 1 && l.rows >= 1 && l.perPage >= 1, true);
  }
}

console.log("\npagination follows the layout's own page size:");
check("6 per sheet fills one page with 6", paginate(deck(..."ABCDEF".split("")), 6).length, 1);
check("and needs two for 7", paginate(deck(..."ABCDEFG".split("")), 6).length, 2);
check("10 per sheet takes one page for 10",
  paginate(deck(...Array.from({ length: 10 }, (_, i) => `c${i}`)), 10).length, 1);
check("the last page is padded to the page size",
  paginate(deck("A", "B"), 10)[0].length, 10);
check("padding is null, not a blank card", paginate(deck("A"), 6)[0][5], null);
check("no card is lost",
  paginate(deck(..."ABCDEFG".split("")), 4).flat().filter(Boolean).map((c) => c.term).join(""),
  "ABCDEFG");
check("a nonsense page size still produces pages", paginate(deck("A", "B"), 0).length, 2);

// A full 2x3 sheet, laid out as it prints:  A B / C D / E F
const full = paginate(deck("A", "B", "C", "D", "E", "F"), 6)[0];
const grid23 = { cols: 2, rows: 3 };

console.log("\nlong edge mirrors each row's columns:");
check("A B / C D / E F  ->  B A / D C / F E",
  names(backSheetOrder(full, "long", grid23)), "B A D C F E");

console.log("\nshort edge reverses the row order:");
check("A B / C D / E F  ->  E F / C D / A B",
  names(backSheetOrder(full, "short", grid23)), "E F C D A B");

console.log("\nthe same arithmetic holds on a taller grid (10 business cards):");
const ten = paginate(deck(..."ABCDEFGHIJ".split("")), 10)[0];
const grid25 = { cols: 2, rows: 5 };
check("long edge swaps the pairs",
  names(backSheetOrder(ten, "long", grid25)), "B A D C F E H G J I");
check("short edge reverses the five rows",
  names(backSheetOrder(ten, "short", grid25)), "I J G H E F C D A B");

console.log("\nand on a single-column grid, where one edge changes nothing:");
const column = paginate(deck("A", "B", "C"), 3)[0];
const grid13 = { cols: 1, rows: 3 };
check("long edge has no columns to mirror",
  names(backSheetOrder(column, "long", grid13)), "A B C");
check("short edge still reverses the rows",
  names(backSheetOrder(column, "short", grid13)), "C B A");

console.log("\na half-empty last sheet keeps its blanks aligned:");
const partial = paginate(deck("A", "B", "C", "D"), 6)[0];
check("long: A B / C D / . .  ->  B A / D C / . .",
  names(backSheetOrder(partial, "long", grid23)), "B A D C . .");
check("short: A B / C D / . .  ->  . . / C D / A B",
  names(backSheetOrder(partial, "short", grid23)), ". . C D A B");

console.log("\nreordering is its own inverse, on every layout:");
for (const paper of PAPER_LIST) {
  for (const size of CARD_SIZE_LIST) {
    const l = layoutFor(paper.id, size.id);
    const page = paginate(
      deck(...Array.from({ length: l.perPage }, (_, i) => `c${i}`)), l.perPage)[0];
    for (const edge of ["long", "short"]) {
      const twice = backSheetOrder(backSheetOrder(page, edge, l), edge, l);
      if (names(twice) !== names(page)) failures++;
    }
  }
}
check("applied twice, every layout restores the front order", true, true);

// The contract that matters: after the sheet is turned on the chosen edge, every
// definition sits behind its own term. Derived from the physical motion rather
// than from backSheetOrder's own arithmetic.
console.log("\nevery definition lands behind its own term, on every layout:");
const behind = (r, c, edge, l) =>
  edge === "long" ? [r, l.cols - 1 - c] : [l.rows - 1 - r, c];

for (const paper of PAPER_LIST) {
  for (const size of CARD_SIZE_LIST) {
    const l = layoutFor(paper.id, size.id);
    // A full sheet and one left half empty, since padding must line up too.
    for (const count of [l.perPage, Math.max(1, l.perPage - 3)]) {
      const page = paginate(
        deck(...Array.from({ length: count }, (_, i) => `c${i}`)), l.perPage)[0];
      for (const edge of ["long", "short"]) {
        const back = backSheetOrder(page, edge, l);
        let aligned = true;
        for (let r = 0; r < l.rows; r++) {
          for (let c = 0; c < l.cols; c++) {
            const [fr, fc] = behind(r, c, edge, l);
            const front = page[fr * l.cols + fc];
            const under = back[r * l.cols + c];
            if (front === null || under === null) {
              if (front !== under) aligned = false;
            } else if (under.definition !== `def:${front.term}`) {
              aligned = false;
            }
          }
        }
        check(`${paper.label} / ${size.label} / ${edge} edge, ${count} cards`, aligned, true);
      }
    }
  }
}

console.log("\nthe print sheet is built from the layout, not the stylesheet:");
const sheets = readFileSync(new URL("../components/PrintSheets.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
check("the paper size reaches @page", /@page \{ size: \$\{layout\.paper\.cssSize\}/.test(sheets), true);
check("the grid comes from the layout",
  /gridTemplateColumns: `repeat\(\$\{layout\.cols\}/.test(sheets), true);
check("so does the row count", /gridTemplateRows: `repeat\(\$\{layout\.rows\}/.test(sheets), true);
check("pagination uses the layout's page size",
  /paginate\(cards, layout\.perPage\)/.test(sheets), true);
check("the back sheet is reordered for the same grid",
  /backSheetOrder\(page, flip, layout\)/.test(sheets), true);
check("the stylesheet no longer hardcodes Letter", /size: letter portrait/.test(css), false);
check("nor the old cell size", /3\.3333in/.test(css), false);
check("smaller cards get smaller type", /\.sheet-business \.cell-front/.test(css), true);

console.log("\nthe on-screen flip is wired to the same setting:");
const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
check("the card carries its edge as a class",
  /className=\{`flip flip-\$\{flip\}/.test(page), true);
// A card is wider than it is tall, so its long edges are the top and bottom and
// "long edge" turns it about the horizontal axis. The paper is portrait, so the
// same words name the opposite axis there — hence the print arithmetic above
// mirroring columns where the card turns about X.
check("long edge turns the card about its long (horizontal) edge",
  /\.flip-long\.flipped \.flip-inner \{\s*transform: rotateX\(180deg\);/.test(css), true);
check("short edge turns the card about its short (vertical) edge",
  /\.flip-short\.flipped \.flip-inner \{\s*transform: rotateY\(180deg\);/.test(css), true);
check("the back face is pre-turned on the long-edge axis",
  /\.flip-long \.face-back \{\s*transform: rotateX\(180deg\);/.test(css), true);
check("the back face is pre-turned on the short-edge axis",
  /\.flip-short \.face-back \{\s*transform: rotateY\(180deg\);/.test(css), true);
check("the two axes are never the same, whichever way round they are",
  /\.flip-long\.flipped[^}]*rotateX/.test(css) !== /\.flip-short\.flipped[^}]*rotateX/.test(css),
  true);

console.log("\nthe print setup is remembered, not asked every time:");
const providers = readFileSync(new URL("../lib/providers.ts", import.meta.url), "utf8");
check("paper is part of the stored settings", /paper: PaperId;/.test(providers), true);
check("so is card size", /cardSize: CardSizeId;/.test(providers), true);
check("so is the flip edge", /flip: FlipEdge;/.test(providers), true);
check("Letter and 6-per-sheet stay the defaults",
  /paper: "letter",\s*cardSize: "fit",\s*flip: "long",/.test(providers), true);

console.log(failures === 0 ? "\nall duplex checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
