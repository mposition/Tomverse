// Rebuilds the PDF font that lib/generatedArtifactFont.ts embeds.
//
//   node scripts/build-pdf-font-subset.mjs <NotoSansKR-Regular.ttf> [<NotoSansSC-Regular.ttf>]
//
// The output, lib/fonts/noto-sans-kr-400-subset.ttf, is checked in: a PDF
// generator that downloads a font at request time is a PDF generator that
// fails when the network does, and the bytes have to be identical for every
// build anyway. This script exists so the checked-in file is *reproducible*
// rather than a binary somebody once produced -- the difference matters the
// day the coverage has to change.
//
// It needs `fonttools` on PATH (`pip install fonttools`) and the upstream
// fonts, which are not vendored: they are 6-10 MB each, and the OFL requires
// the licence to travel with the font we ship, not with every input we ever
// read. A variable input (`NotoSansKR[wght].ttf`) is pinned to weight 400; a
// static `Regular` is used as it is.
//
//   https://github.com/notofonts/noto-cjk  (Sans/Variable/TTF)
//
// ## Which fonts, and why two
//
// The first font is Noto Sans KR 2.004: Latin, punctuation, Hangul, kana,
// symbols and the Korean hanja. It is the base because the product's
// documents are Korean first, and where both fonts draw a code point the
// Korean form of the character is the one that ships.
//
// The second, optional font is Noto Sans SC 2.004 of the same release and
// weight. Noto Sans KR carries only 56% of GB 2312 (so most Simplified Chinese
// text lost a character in two) and 88% of JIS X 0208; Noto Sans SC carries
// all of GB 2312, Big5 and JIS X 0208. Only the ideographs the first font
// lacks are taken from it, so adding it widens the repertoire without
// changing a glyph the Korean font already drew. Both are designed on the same
// 1000-unit em with the same stroke weight, which is what lets them sit in one
// line of text.
//
// The OFL permits embedding. Its Reserved Font Name is "Source" (the Source
// Han Sans these fonts descend from), which the family name "Noto Sans KR"
// does not use, so a subset needs no rename. lib/fonts/OFL.txt travels beside
// the output.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUTPUT = join("lib", "fonts", "noto-sans-kr-400-subset.ttf");

// What a Korean document actually needs, and a good deal of what a Chinese or
// Japanese one does. Latin and punctuation because every report still has
// numbers, ASCII identifiers and parentheses in it; the jamo blocks and all
// 11,172 precomposed syllables because Hangul that is missing one syllable is
// Hangul that renders a blank in the middle of a word; and the symbols a model
// reaches for without thinking -- circled numbers, units, box drawing for a
// directory tree, check marks, Greek letters for maths.
//
// A range the font does not fill is harmless: the subsetter keeps what exists.
const UNICODES = [
  "U+0020-007E", // Basic Latin
  "U+00A0-00FF", // Latin-1 supplement
  "U+0100-017F", // Latin Extended-A
  "U+0180-024F", // Latin Extended-B
  "U+0250-02FF", // IPA extensions and spacing modifier letters
  "U+0300-036F", // Combining diacritical marks
  "U+0370-03FF", // Greek
  "U+0400-04FF", // Cyrillic
  "U+1E00-1EFF", // Latin Extended Additional (Vietnamese)
  "U+2000-206F", // General punctuation
  "U+2070-209F", // Superscripts and subscripts
  "U+20A0-20BF", // Currency symbols
  "U+2100-214F", // Letterlike symbols
  "U+2150-218F", // Number forms
  "U+2190-21FF", // Arrows
  "U+2200-22FF", // Mathematical operators
  "U+2300-23FF", // Miscellaneous technical
  "U+2460-24FF", // Enclosed alphanumerics
  "U+2500-257F", // Box drawing
  "U+2580-259F", // Block elements
  "U+25A0-25FF", // Geometric shapes
  "U+2600-26FF", // Miscellaneous symbols
  "U+2700-27BF", // Dingbats
  "U+2B00-2BFF", // Miscellaneous symbols and arrows
  "U+3000-303F", // CJK symbols and punctuation
  "U+3040-309F", // Hiragana
  "U+30A0-30FF", // Katakana
  "U+3100-312F", // Bopomofo
  "U+1100-11FF", // Hangul jamo
  "U+3130-318F", // Hangul compatibility jamo
  "U+31A0-31BF", // Bopomofo extended
  "U+31F0-31FF", // Katakana phonetic extensions
  "U+3200-32FF", // Enclosed CJK letters and months (㈜ ㈱ ㉠)
  "U+3300-33FF", // CJK compatibility (㎡ ㎏ ㏄)
  "U+A960-A97F", // Hangul jamo extended-A
  "U+AC00-D7A3", // Hangul syllables
  "U+D7B0-D7FF", // Hangul jamo extended-B
  "U+FE30-FE6F", // CJK compatibility forms and small form variants
  "U+FF00-FFEF", // Halfwidth and fullwidth forms
].join(",");

// The ideographs, by the legacy national standards a document is written to
// rather than by the whole 20,992-character block: Korean hanja (KS X 1001),
// Simplified Chinese (GB 2312), Traditional Chinese (Big5 level 1) and
// Japanese kanji (JIS X 0208). About 10,800 characters, which is what text in
// those languages is made of; the ~10,000 left out are variants and rarities
// that a missing glyph reports honestly instead of costing a megabyte each
// release.
//
// Derived from the platform's own decoder tables so the list is not another
// binary somebody once typed.
const ideographsOf = (label, leadBytes, trailBytes) => {
  const decoder = new TextDecoder(label, { fatal: true });
  const found = new Set();
  for (const lead of leadBytes) {
    for (const trail of trailBytes) {
      let text;
      try {
        text = decoder.decode(Uint8Array.of(lead, trail));
      } catch {
        continue;
      }
      const [first, ...rest] = [...text];
      const code = first?.codePointAt(0) ?? 0;
      if (
        rest.length === 0 &&
        ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff))
      ) {
        found.add(code);
      }
    }
  }
  return found;
};
const span = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

const IDEOGRAPHS = new Set([
  // KS X 1001 hanja: rows 0xCA-0xFD
  ...ideographsOf("euc-kr", span(0xca, 0xfd), span(0xa1, 0xfe)),
  // GB 2312 hanzi, levels 1 and 2: rows 0xB0-0xF7
  ...ideographsOf("gbk", span(0xb0, 0xf7), span(0xa1, 0xfe)),
  // Big5 level 1 (the 5,401 frequently used characters): rows 0xA4-0xC6
  ...ideographsOf("big5", span(0xa4, 0xc6), [...span(0x40, 0x7e), ...span(0xa1, 0xfe)]),
  // JIS X 0208 kanji, levels 1 and 2, in Shift_JIS
  ...ideographsOf(
    "shift_jis",
    [...span(0x88, 0x9f), ...span(0xe0, 0xea)],
    [...span(0x40, 0x7e), ...span(0x80, 0xfc)]
  ),
]);

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

const [baseSource, supplementSource] = process.argv.slice(2);
if (!baseSource) {
  console.error(
    "Usage: node scripts/build-pdf-font-subset.mjs <NotoSansKR-Regular.ttf> [<NotoSansSC-Regular.ttf>]"
  );
  process.exit(2);
}
for (const source of [baseSource, supplementSource].filter(Boolean)) {
  try {
    statSync(source);
  } catch {
    console.error(`Cannot read ${source}.`);
    process.exit(2);
  }
}

// SOURCE_DATE_EPOCH pins the `head.modified` stamp fonttools writes, so two
// builds of the same inputs are the same bytes.
const fonttools = (...args) =>
  execFileSync("fonttools", args, {
    stdio: "inherit",
    env: { ...process.env, SOURCE_DATE_EPOCH: "1735689600" },
  });

const isVariable = (path) => {
  const data = readFileSync(path);
  const tables = data.readUInt16BE(4);
  for (let index = 0; index < tables; index += 1) {
    if (data.toString("latin1", 12 + index * 16, 16 + index * 16) === "fvar") return true;
  }
  return false;
};

const scratch = mkdtempSync(join(tmpdir(), "pdf-font-"));

// One weight, not a variable axis: a PDF has no way to select an instance,
// so an unpinned font would ship every weight and render one.
const pinned = (source, name) => {
  if (!isVariable(source)) return source;
  const instanced = join(scratch, `${name}-400.ttf`);
  fonttools("varLib.instancer", source, "wght=400", "-o", instanced);
  return instanced;
};

// Layout and rendering-hint tables nothing here consults, plus the merge's
// leftovers (`BASE`, `gasp`), so the output carries exactly KEEP_TABLES.
const SUBSET_OPTIONS = [
  "--layout-features=",
  "--no-hinting",
  "--notdef-outline",
  "--recommended-glyphs",
  `--drop-tables+=${["GSUB", "GPOS", "GDEF", "BASE", "gasp", "kern", "vhea", "vmtx", "VORG", "DSIG"].join(",")}`,
];

try {
  const ideographFile = join(scratch, "ideographs.txt");
  writeFileSync(
    ideographFile,
    [...IDEOGRAPHS]
      .sort((a, b) => a - b)
      .map((code) => `U+${code.toString(16).toUpperCase()}`)
      .join("\n")
  );

  const base = join(scratch, "base.ttf");
  fonttools(
    "subset",
    pinned(baseSource, "base"),
    `--unicodes=${UNICODES}`,
    `--unicodes-file=${ideographFile}`,
    ...SUBSET_OPTIONS,
    `--output-file=${base}`
  );

  let merged = base;
  if (supplementSource) {
    const supplement = join(scratch, "supplement.ttf");
    fonttools(
      "subset",
      pinned(supplementSource, "supplement"),
      `--unicodes-file=${ideographFile}`,
      ...SUBSET_OPTIONS,
      `--output-file=${supplement}`
    );
    // The first font wins wherever both draw a code point, so the Korean
    // form of a shared character is the one that stays.
    merged = join(scratch, "merged.ttf");
    fonttools("merge", base, supplement, `--output-file=${merged}`);
  }

  // The merge keeps the supplement's glyphs for characters the base also
  // draws, now unreachable from the cmap. Subsetting again drops them.
  fonttools(
    "subset",
    merged,
    `--unicodes=${UNICODES}`,
    `--unicodes-file=${ideographFile}`,
    ...SUBSET_OPTIONS,
    `--output-file=${OUTPUT}`
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const { size } = statSync(OUTPUT);
console.log(`Wrote ${OUTPUT} (${size} bytes, ${IDEOGRAPHS.size} ideographs requested).`);
console.log(`Expected tables: ${KEEP_TABLES.join(" ")}`);
console.log(
  "Check the result with `node --conditions=react-server --import tsx --test tests/generatedArtifactPdf.test.mjs`."
);
