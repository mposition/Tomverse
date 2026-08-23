// Rebuilds the PDF font that lib/generatedArtifactFont.ts embeds.
//
//   node scripts/build-pdf-font-subset.mjs <path-to-NotoSansKR[wght].ttf>
//
// The output, lib/fonts/noto-sans-kr-400-subset.ttf, is checked in: a PDF
// generator that downloads a font at request time is a PDF generator that
// fails when the network does, and the bytes have to be identical for every
// build anyway. This script exists so the checked-in file is *reproducible*
// rather than a binary somebody once produced -- the difference matters the
// day the coverage has to change.
//
// It needs `fonttools` on PATH (`pip install fonttools`) and the upstream
// variable font, which is not vendored: it is 6 MB of weights this product
// does not use, and the OFL requires the licence to travel with the font we
// ship, not with every input we ever read.
//
//   https://github.com/notofonts/noto-cjk  (Sans/Variable/OTF/Subset)
//
// Noto carries no Reserved Font Name, so a subset needs no rename, and the
// OFL permits embedding. lib/fonts/OFL.txt travels beside the output.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUTPUT = join("lib", "fonts", "noto-sans-kr-400-subset.ttf");

// What a Korean document actually needs, and nothing else. Latin and
// punctuation because a Korean report still has numbers, ASCII identifiers and
// parentheses in it; the jamo blocks and all 11,172 precomposed syllables
// because Hangul that is missing one syllable is Hangul that renders a blank
// in the middle of a word.
const UNICODES = [
  "U+0020-007E", // Basic Latin
  "U+00A0-00FF", // Latin-1 supplement
  "U+0100-017F", // Latin Extended-A
  "U+2000-206F", // General punctuation
  "U+20A0-20BF", // Currency symbols
  "U+2190-21FF", // Arrows
  "U+2200-22FF", // Mathematical operators
  "U+25A0-25FF", // Geometric shapes
  "U+3000-303F", // CJK symbols and punctuation
  "U+1100-11FF", // Hangul jamo
  "U+3130-318F", // Hangul compatibility jamo
  "U+A960-A97F", // Hangul jamo extended-A
  "U+AC00-D7A3", // Hangul syllables
  "U+D7B0-D7FF", // Hangul jamo extended-B
  "U+FF01-FF60", // Fullwidth forms
].join(",");

// Everything the PDF writer reads, and nothing more. It parses the tables
// itself (see lib/generatedArtifactFont.ts) rather than shaping text, so
// GSUB/GPOS/kern would be a megabyte of layout nothing consults.
const KEEP_TABLES = [
  "OS/2",
  "cmap",
  "glyf",
  "head",
  "hhea",
  "hmtx",
  "loca",
  "maxp",
  "name",
  "post",
];

const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/build-pdf-font-subset.mjs <NotoSansKR[wght].ttf>");
  process.exit(2);
}
try {
  statSync(source);
} catch {
  console.error(`Cannot read ${source}.`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "pdf-font-"));
const instanced = join(scratch, "noto-sans-kr-400.ttf");

try {
  // One weight, not a variable axis: a PDF has no way to select an instance,
  // so an unpinned font would ship every weight and render one.
  execFileSync(
    "fonttools",
    ["varLib.instancer", source, "wght=400", "-o", instanced],
    { stdio: "inherit" }
  );

  execFileSync(
    "fonttools",
    [
      "subset",
      instanced,
      `--unicodes=${UNICODES}`,
      "--layout-features=",
      "--no-hinting",
      "--notdef-outline",
      "--recommended-glyphs",
      `--drop-tables+=${["GSUB", "GPOS", "GDEF", "kern", "vhea", "vmtx", "VORG", "DSIG"].join(",")}`,
      `--output-file=${OUTPUT}`,
    ],
    { stdio: "inherit" }
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const { size } = statSync(OUTPUT);
console.log(`Wrote ${OUTPUT} (${size} bytes).`);
console.log(`Expected tables: ${KEEP_TABLES.join(" ")}`);
console.log(
  "Check the result with `node --conditions=react-server --import tsx --test tests/generatedArtifactPdf.test.mjs`."
);
