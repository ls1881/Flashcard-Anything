#!/usr/bin/env node --experimental-strip-types
// Run: npm test
import { readFileSync } from "node:fs";
import { COLS, ROWS, PER_PAGE, paginate, backSheetOrder } from "../lib/duplex.ts";

let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${got}, want ${want})`}`);
};

const card = (t) => (t === null ? null : { term: t, definition: `def:${t}` });
const deck = (...terms) => terms.map(card);
const names = (page) => page.map((c) => (c ? c.term : ".")).join(" ");

console.log(`grid is ${COLS}x${ROWS}, ${PER_PAGE} per page:`);
check("PER_PAGE == COLS * ROWS", PER_PAGE === COLS * ROWS, true);

console.log("\npagination fills every sheet with the same grid:");
const short = paginate(deck("A", "B", "C", "D"));
check("4 cards make 1 page", short.length, 1);
check("the page is padded to PER_PAGE", short[0].length, PER_PAGE);
check("padding is null, not a blank card", short[0][4], null);
const long = paginate(deck("A", "B", "C", "D", "E", "F", "G"));
check("7 cards make 2 pages", long.length, 2);
check("no card is dropped or duplicated",
  long.flat().filter(Boolean).map((c) => c.term).join(""), "ABCDEFG");

// A full page, laid out as it prints:  A B / C D / E F
const full = paginate(deck("A", "B", "C", "D", "E", "F"))[0];

console.log("\nlong edge mirrors each row's columns:");
check("A B / C D / E F  ->  B A / D C / F E",
  names(backSheetOrder(full, "long")), "B A D C F E");

console.log("\nshort edge reverses the row order:");
check("A B / C D / E F  ->  E F / C D / A B",
  names(backSheetOrder(full, "short")), "E F C D A B");

console.log("\nthe two edges are not interchangeable:");
check("long and short give different sheets",
  names(backSheetOrder(full, "long")) !== names(backSheetOrder(full, "short")), true);

console.log("\na half-empty last sheet keeps its blanks aligned:");
const partial = paginate(deck("A", "B", "C", "D"))[0];
check("long: A B / C D / . .  ->  B A / D C / . .",
  names(backSheetOrder(partial, "long")), "B A D C . .");
check("short: A B / C D / . .  ->  . . / C D / A B",
  names(backSheetOrder(partial, "short")), ". . C D A B");

console.log("\nreordering is its own inverse (the paper flips back):");
for (const edge of ["long", "short"]) {
  check(`${edge}: applied twice restores the front order`,
    names(backSheetOrder(backSheetOrder(full, edge), edge)), names(full));
}

// The contract that matters: after the sheet is turned over on the chosen edge,
// every definition sits behind its own term. Derived from the physical motion
// rather than from backSheetOrder's own arithmetic.
console.log("\nevery definition lands behind its own term:");
const behind = (r, c, edge) =>
  edge === "long" ? [r, COLS - 1 - c] : [ROWS - 1 - r, c];

for (const edge of ["long", "short"]) {
  for (const [label, page] of [["full sheet", full], ["padded sheet", partial]]) {
    const back = backSheetOrder(page, edge);
    let aligned = true;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const [fr, fc] = behind(r, c, edge);
        const front = page[fr * COLS + fc];
        const under = back[r * COLS + c];
        // Both blank, or the definition belongs to the term it is printed under.
        if (front === null || under === null) {
          if (front !== under) aligned = false;
        } else if (under.definition !== `def:${front.term}`) {
          aligned = false;
        }
      }
    }
    check(`${edge} edge, ${label}`, aligned, true);
  }
}

// The screen preview and the print sheets read the same FlipEdge, so the card
// must turn about the axis the paper turns about: long -> Y, short -> X.
console.log("\nthe on-screen flip is wired to the same setting:");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
check("the card carries its edge as a class",
  /className=\{`flip flip-\$\{flip\}/.test(page), true);
check("long edge turns about the vertical axis",
  /\.flip-long\.flipped \.flip-inner \{\s*transform: rotateY\(180deg\);/.test(css), true);
check("short edge turns about the horizontal axis",
  /\.flip-short\.flipped \.flip-inner \{\s*transform: rotateX\(180deg\);/.test(css), true);
check("the back face is pre-turned on the long-edge axis",
  /\.flip-long \.face-back \{\s*transform: rotateY\(180deg\);/.test(css), true);
check("the back face is pre-turned on the short-edge axis",
  /\.flip-short \.face-back \{\s*transform: rotateX\(180deg\);/.test(css), true);

console.log(failures === 0 ? "\nall duplex checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
