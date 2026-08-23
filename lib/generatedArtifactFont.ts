/**
 * The font the PDF writer embeds, and the subsetting that keeps it small.
 *
 * Policy: docs/policy/generated-artifacts.md section 4.
 *
 * ## Why a font is vendored at all
 *
 * A `.docx` is opened by Word and a `.pptx` by PowerPoint, both of which have
 * their own font book -- so those writers name a font and stop. A PDF has no
 * such reader. A PDF that names a Korean font without embedding it renders as
 * blank boxes on any machine that happens not to have it, which for a
 * Korean-first product is the whole file failing quietly. So the bytes travel
 * with the document.
 *
 * `lib/fonts/noto-sans-kr-400-subset.ttf` is Noto Sans KR at weight 400,
 * instanced from the upstream variable font and cut to Latin, punctuation,
 * currency, CJK punctuation, the Hangul jamo blocks and all 11,172 precomposed
 * syllables. It is licensed under the SIL Open Font License 1.1 (`OFL.txt`
 * beside it), which permits embedding; Noto carries no Reserved Font Name, so
 * a subset needs no rename. `scripts/build-pdf-font-subset.mjs` reproduces it.
 *
 * ## Why the subsetting looks like this
 *
 * The vendored font is 2.4 MB and a document uses a few hundred glyphs of it,
 * so something has to shrink before the bytes go into every PDF. The usual way
 * is to renumber glyphs into a dense range -- and renumbering is where a
 * subsetter goes subtly wrong, because every composite glyph's component index
 * and every `cmap` entry has to move with it.
 *
 * This one does not renumber. Glyph ids stay exactly as they are in the
 * vendored font; the subset writes a `glyf` table containing only the glyphs
 * the document uses, and a `loca` table whose unused entries are zero-length
 * -- which is the format's own way of spelling an empty glyph. Composite
 * component indices stay valid because nothing moved, `cmap` stays valid for
 * the same reason, and `CIDToGIDMap` can be `/Identity`.
 *
 * The trade is that `loca` and `hmtx` stay full length: about 100 KB of the
 * ~140 KB a subset weighs, before the PDF's own Flate compression takes it to
 * roughly half that. A renumbering subsetter would reach ~40 KB. That is the
 * price of not having a class of bug whose symptom is a file the reader opens
 * and then draws wrong.
 */

import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PDF_FONT_PATH = join(
  "lib",
  "fonts",
  "noto-sans-kr-400-subset.ttf"
);

/** The PostScript name written into the PDF's font descriptor. */
export const PDF_FONT_NAME = "NotoSansKR-Regular";

type TableRecord = { offset: number; length: number };

export type LoadedFont = {
  data: Buffer;
  tables: Map<string, TableRecord>;
  unitsPerEm: number;
  numGlyphs: number;
  /** Long-format loca, one entry per glyph plus a terminator. */
  loca: number[];
  glyfOffset: number;
  /** Advance width per glyph, in font units. */
  advances: number[];
  /** Unicode code point to glyph id. */
  cmap: Map<number, number>;
  /** Font bounding box and metrics the descriptor has to state. */
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
};

const tag = (data: Buffer, offset: number) =>
  data.toString("latin1", offset, offset + 4);

const readTableDirectory = (data: Buffer): Map<string, TableRecord> => {
  const numTables = data.readUInt16BE(4);
  const tables = new Map<string, TableRecord>();
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    tables.set(tag(data, record), {
      offset: data.readUInt32BE(record + 8),
      length: data.readUInt32BE(record + 12),
    });
  }
  return tables;
};

const requireTable = (
  tables: Map<string, TableRecord>,
  name: string
): TableRecord => {
  const table = tables.get(name);
  if (!table) throw new Error(`The embedded font has no "${name}" table.`);
  return table;
};

/**
 * Unicode to glyph id, from whichever `cmap` subtable the font provides.
 *
 * Format 12 is preferred where it exists because it is the one that can carry
 * anything above the BMP; format 4 is the fallback and is all a Hangul-plus-
 * Latin font needs. Any other format is a font this writer was not built for,
 * and saying so is better than mapping every character to `.notdef`.
 */
const readCmap = (data: Buffer, offset: number): Map<number, number> => {
  const numTables = data.readUInt16BE(offset + 2);
  let best: { format: number; subtable: number } | null = null;

  for (let index = 0; index < numTables; index += 1) {
    const record = offset + 4 + index * 8;
    const platform = data.readUInt16BE(record);
    const encoding = data.readUInt16BE(record + 2);
    const subtable = offset + data.readUInt32BE(record + 4);
    const format = data.readUInt16BE(subtable);
    const unicode =
      platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format !== 4 && format !== 12) continue;
    if (!best || format > best.format) best = { format, subtable };
  }

  if (!best) throw new Error("The embedded font has no usable cmap subtable.");
  const map = new Map<number, number>();

  if (best.format === 12) {
    const groups = data.readUInt32BE(best.subtable + 12);
    for (let index = 0; index < groups; index += 1) {
      const group = best.subtable + 16 + index * 12;
      const start = data.readUInt32BE(group);
      const end = data.readUInt32BE(group + 4);
      const startGlyph = data.readUInt32BE(group + 8);
      for (let code = start; code <= end; code += 1) {
        map.set(code, startGlyph + (code - start));
      }
    }
    return map;
  }

  const segCountX2 = data.readUInt16BE(best.subtable + 6);
  const segCount = segCountX2 / 2;
  const endCodes = best.subtable + 14;
  const startCodes = endCodes + segCountX2 + 2;
  const idDeltas = startCodes + segCountX2;
  const idRangeOffsets = idDeltas + segCountX2;

  for (let segment = 0; segment < segCount; segment += 1) {
    const end = data.readUInt16BE(endCodes + segment * 2);
    const start = data.readUInt16BE(startCodes + segment * 2);
    const delta = data.readInt16BE(idDeltas + segment * 2);
    const rangeOffset = data.readUInt16BE(idRangeOffsets + segment * 2);
    if (start === 0xffff) continue;
    for (let code = start; code <= end && code !== 0x10000; code += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const glyphIndexAddress =
          idRangeOffsets + segment * 2 + rangeOffset + (code - start) * 2;
        if (glyphIndexAddress + 1 >= data.length) continue;
        const raw = data.readUInt16BE(glyphIndexAddress);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(code, glyph);
    }
  }
  return map;
};

let cached: LoadedFont | null = null;

/**
 * Reads and parses the vendored font once per process.
 *
 * From `process.cwd()` rather than `import.meta.url`, which is the convention
 * this repository already uses for files the server reads at runtime (see
 * `lib/buildInfo.ts`): the bundler rewrites module paths and does not move
 * data files, so the working directory is the thing that stays true.
 */
export const loadPdfFont = (): LoadedFont => {
  if (cached) return cached;

  const data = readFileSync(join(process.cwd(), PDF_FONT_PATH));
  const tables = readTableDirectory(data);

  const head = requireTable(tables, "head");
  const unitsPerEm = data.readUInt16BE(head.offset + 18);
  const indexToLocFormat = data.readInt16BE(head.offset + 50);
  const bbox: [number, number, number, number] = [
    data.readInt16BE(head.offset + 36),
    data.readInt16BE(head.offset + 38),
    data.readInt16BE(head.offset + 40),
    data.readInt16BE(head.offset + 42),
  ];

  const maxp = requireTable(tables, "maxp");
  const numGlyphs = data.readUInt16BE(maxp.offset + 4);

  const hhea = requireTable(tables, "hhea");
  const ascent = data.readInt16BE(hhea.offset + 4);
  const descent = data.readInt16BE(hhea.offset + 6);
  const numberOfHMetrics = data.readUInt16BE(hhea.offset + 34);

  const hmtx = requireTable(tables, "hmtx");
  const advances: number[] = new Array(numGlyphs);
  let lastAdvance = 0;
  for (let glyph = 0; glyph < numGlyphs; glyph += 1) {
    if (glyph < numberOfHMetrics) {
      lastAdvance = data.readUInt16BE(hmtx.offset + glyph * 4);
    }
    advances[glyph] = lastAdvance;
  }

  const locaTable = requireTable(tables, "loca");
  const loca: number[] = new Array(numGlyphs + 1);
  for (let index = 0; index <= numGlyphs; index += 1) {
    loca[index] =
      indexToLocFormat === 0
        ? data.readUInt16BE(locaTable.offset + index * 2) * 2
        : data.readUInt32BE(locaTable.offset + index * 4);
  }

  cached = {
    data,
    tables,
    unitsPerEm,
    numGlyphs,
    loca,
    glyfOffset: requireTable(tables, "glyf").offset,
    advances,
    cmap: readCmap(data, requireTable(tables, "cmap").offset),
    bbox,
    ascent,
    descent,
  };
  return cached;
};

/**
 * The glyphs a composite glyph is built from, transitively.
 *
 * A subset that keeps a composite but drops one of its components draws a
 * character with a piece missing -- an "e" with no accent, a syllable with no
 * final consonant. Nothing about the file is invalid, which is what makes it
 * worth closing over explicitly.
 */
const addComponents = (
  font: LoadedFont,
  glyph: number,
  into: Set<number>
): void => {
  const start = font.glyfOffset + font.loca[glyph]!;
  const end = font.glyfOffset + font.loca[glyph + 1]!;
  if (end <= start) return;
  const contours = font.data.readInt16BE(start);
  if (contours >= 0) return;

  let cursor = start + 10;
  for (;;) {
    if (cursor + 4 > end) return;
    const flags = font.data.readUInt16BE(cursor);
    const component = font.data.readUInt16BE(cursor + 2);
    cursor += 4;

    if (!into.has(component)) {
      into.add(component);
      addComponents(font, component, into);
    }

    cursor += flags & 0x0001 ? 4 : 2;
    if (flags & 0x0008) cursor += 2;
    else if (flags & 0x0040) cursor += 4;
    else if (flags & 0x0080) cursor += 8;

    if (!(flags & 0x0020)) return;
  }
};

const TABLE_ORDER = [
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

const padTo4 = (length: number) => (4 - (length % 4)) % 4;

/**
 * The vendored font reduced to the glyphs a document actually uses.
 *
 * Glyph ids are unchanged; see this file's header for why. `glyf` carries only
 * the used glyphs, `loca` gives every other glyph a zero-length entry, and
 * `head.indexToLocFormat` is forced to long so the rebuilt offsets always fit.
 * Everything else is copied byte for byte.
 */
export const subsetPdfFont = (
  font: LoadedFont,
  usedGlyphs: Iterable<number>
): Uint8Array => {
  const keep = new Set<number>([0]);
  for (const glyph of usedGlyphs) {
    if (glyph >= 0 && glyph < font.numGlyphs) keep.add(glyph);
  }
  for (const glyph of [...keep]) addComponents(font, glyph, keep);

  // --- glyf and loca ------------------------------------------------------
  const pieces: Buffer[] = [];
  const newLoca = new Array<number>(font.numGlyphs + 1);
  let cursor = 0;
  for (let glyph = 0; glyph < font.numGlyphs; glyph += 1) {
    newLoca[glyph] = cursor;
    if (!keep.has(glyph)) continue;
    const start = font.glyfOffset + font.loca[glyph]!;
    const end = font.glyfOffset + font.loca[glyph + 1]!;
    if (end <= start) continue;
    const bytes = font.data.subarray(start, end);
    pieces.push(Buffer.from(bytes));
    const padding = padTo4(bytes.length);
    if (padding) pieces.push(Buffer.alloc(padding));
    cursor += bytes.length + padding;
  }
  newLoca[font.numGlyphs] = cursor;

  const glyf = Buffer.concat(pieces, cursor);
  const loca = Buffer.alloc((font.numGlyphs + 1) * 4);
  newLoca.forEach((offset, index) => loca.writeUInt32BE(offset, index * 4));

  const head = Buffer.from(
    font.data.subarray(
      requireTable(font.tables, "head").offset,
      requireTable(font.tables, "head").offset +
        requireTable(font.tables, "head").length
    )
  );
  head.writeInt16BE(1, 50); // indexToLocFormat: long

  const built = new Map<string, Buffer>([
    ["glyf", glyf],
    ["loca", loca],
    ["head", head],
  ]);

  // --- assemble -----------------------------------------------------------
  const names = TABLE_ORDER.filter((name) => font.tables.has(name));
  const bodies = names.map((name) => {
    const override = built.get(name);
    if (override) return override;
    const record = requireTable(font.tables, name);
    return Buffer.from(
      font.data.subarray(record.offset, record.offset + record.length)
    );
  });

  const headerLength = 12 + names.length * 16;
  let offset = headerLength;
  const offsets = bodies.map((body) => {
    const at = offset;
    offset += body.length + padTo4(body.length);
    return at;
  });

  const output = Buffer.alloc(offset);
  output.writeUInt32BE(0x00010000, 0);
  output.writeUInt16BE(names.length, 4);
  // searchRange / entrySelector / rangeShift: derived, and readers that check
  // them reject a font whose values disagree with the table count.
  const power = Math.floor(Math.log2(names.length));
  output.writeUInt16BE(2 ** power * 16, 6);
  output.writeUInt16BE(power, 8);
  output.writeUInt16BE(names.length * 16 - 2 ** power * 16, 10);

  names.forEach((name, index) => {
    const record = 12 + index * 16;
    output.write(name.padEnd(4, " "), record, 4, "latin1");
    // Checksums are zeroed rather than computed. `head.checkSumAdjustment` is
    // the only one any reader validates in practice and it is left as the
    // original font's, which is already wrong for a subset -- writing
    // per-table checksums would make the file look verified without being it.
    output.writeUInt32BE(0, record + 4);
    output.writeUInt32BE(offsets[index]!, record + 8);
    output.writeUInt32BE(bodies[index]!.length, record + 12);
  });

  bodies.forEach((body, index) => body.copy(output, offsets[index]!));
  return new Uint8Array(output);
};

/**
 * The glyph a code point draws as, or null when the font cannot draw it.
 *
 * Null rather than `.notdef`: a PDF full of empty boxes is a PDF that looks
 * broken without saying so, and the caller turns this into a named refusal
 * instead (policy section 4).
 */
export const glyphFor = (font: LoadedFont, codePoint: number): number | null =>
  font.cmap.get(codePoint) ?? null;
