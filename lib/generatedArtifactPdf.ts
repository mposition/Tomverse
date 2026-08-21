/**
 * The trusted PDF writer.
 *
 * Policy: docs/policy/generated-artifacts.md sections 3, 4 and 6.
 *
 * A PDF is written rather than converted: the same document specification the
 * DOCX and Markdown writers read is laid out onto pages here. There is no
 * headless browser, no HTML intermediate and no template -- which is what
 * keeps the output free of anything the specification did not say.
 *
 * What the file deliberately does not contain, because nothing here writes it:
 * `/OpenAction` and `/AA` (a PDF that runs something when it opens),
 * `/JavaScript`, `/EmbeddedFile`, `/Launch`, `/URI` and `/GoToR` actions,
 * and AcroForm fields. A document produced from a specification has no links
 * and no scripts, because the specification has neither.
 *
 * ## Text is drawn, not typeset
 *
 * Line breaking measures every glyph against the embedded font's own advance
 * widths, so a line fits because it was measured rather than because a
 * character count guessed. Korean breaks between any two syllables, which is
 * how Korean actually wraps; Latin breaks at spaces and falls back to
 * mid-word only when a single word is wider than the column.
 */

import "server-only";

// zlib, not raw deflate: PDF's `/FlateDecode` is RFC 1950, and fflate's
// `deflateSync` emits RFC 1951 without the two-byte header. The difference is
// invisible until a reader opens the file and finds an "unknown compression
// method" where the page content should be.
import { zlibSync } from "fflate";

import type { ArtifactDocumentBlock, DocumentSpec } from "@/lib/generatedArtifactCore";
import {
  PDF_FONT_NAME,
  glyphFor,
  loadPdfFont,
  subsetPdfFont,
  type LoadedFont,
} from "@/lib/generatedArtifactFont";

export class PdfGenerationError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_CHARACTERS" | "GENERATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "PdfGenerationError";
  }
}

/** A4 in PDF points, with a 56pt (~2cm) margin. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_TOP = PAGE_HEIGHT - MARGIN;
const CONTENT_BOTTOM = MARGIN;

type Style = {
  size: number;
  leading: number;
  spaceBefore: number;
  spaceAfter: number;
  indent: number;
  grey?: number;
};

const STYLES = {
  title: { size: 26, leading: 32, spaceBefore: 0, spaceAfter: 14, indent: 0 },
  subtitle: { size: 13, leading: 18, spaceBefore: 0, spaceAfter: 20, indent: 0, grey: 0.35 },
  h1: { size: 19, leading: 25, spaceBefore: 18, spaceAfter: 8, indent: 0 },
  h2: { size: 16, leading: 22, spaceBefore: 15, spaceAfter: 7, indent: 0 },
  h3: { size: 14, leading: 19, spaceBefore: 12, spaceAfter: 6, indent: 0 },
  h4: { size: 12, leading: 17, spaceBefore: 10, spaceAfter: 5, indent: 0 },
  body: { size: 10.5, leading: 15.5, spaceBefore: 0, spaceAfter: 9, indent: 0 },
  listItem: { size: 10.5, leading: 15.5, spaceBefore: 0, spaceAfter: 3, indent: 18 },
  quote: { size: 10.5, leading: 15.5, spaceBefore: 6, spaceAfter: 9, indent: 18, grey: 0.3 },
  code: { size: 9.5, leading: 13.5, spaceBefore: 6, spaceAfter: 9, indent: 10 },
  tableCell: { size: 9.5, leading: 13, spaceBefore: 0, spaceAfter: 0, indent: 0 },
} as const satisfies Record<string, Style>;

/* ------------------------------------------------------------------------ */
/* Measuring and breaking                                                     */
/* ------------------------------------------------------------------------ */

type Glyph = { id: number; width: number };

/**
 * A string as glyphs, or the character that stopped it.
 *
 * A tab becomes four spaces because the PDF text operator has no tab stop, and
 * silently dropping it would close up indentation the author wrote.
 */
const toGlyphs = (font: LoadedFont, value: string): Glyph[] => {
  const glyphs: Glyph[] = [];
  for (const character of value.replace(/\t/g, "    ")) {
    const codePoint = character.codePointAt(0)!;
    const id = glyphFor(font, codePoint);
    if (id === null) {
      throw new PdfGenerationError(
        "UNSUPPORTED_CHARACTERS",
        `The PDF font cannot draw "${character}" (U+${codePoint
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")}).`
      );
    }
    glyphs.push({ id, width: font.advances[id] ?? 0 });
  }
  return glyphs;
};

const glyphsWidth = (glyphs: readonly Glyph[], size: number, unitsPerEm: number) =>
  glyphs.reduce((total, glyph) => total + glyph.width, 0) * (size / unitsPerEm);

/** Whether a line may break *before* this character. */
const breaksBefore = (codePoint: number): boolean =>
  // Hangul syllables and jamo, CJK punctuation and ideographs: Korean wraps
  // between syllables rather than at spaces.
  (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
  (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
  (codePoint >= 0x3130 && codePoint <= 0x318f) ||
  (codePoint >= 0x4e00 && codePoint <= 0x9fff);

const wrap = (
  font: LoadedFont,
  value: string,
  size: number,
  width: number
): Glyph[][] => {
  const lines: Glyph[][] = [];
  for (const paragraph of value.split(/\r\n|\r|\n/)) {
    if (paragraph === "") {
      lines.push([]);
      continue;
    }
    const characters = [...paragraph];
    const glyphs = toGlyphs(font, paragraph);
    let line: Glyph[] = [];
    let lineWidth = 0;
    let lastBreak = -1;
    let widthAtBreak = 0;

    for (let index = 0; index < glyphs.length; index += 1) {
      const glyph = glyphs[index]!;
      const advance = glyph.width * (size / font.unitsPerEm);
      const character = characters[index] ?? " ";
      const codePoint = character.codePointAt(0)!;

      if (lineWidth + advance > width && line.length > 0) {
        if (lastBreak >= 0) {
          // Break at the remembered opportunity and re-run the tail.
          const kept = line.slice(0, lastBreak);
          lines.push(kept);
          const carried = line.slice(lastBreak);
          line = carried;
          lineWidth = lineWidth - widthAtBreak;
          lastBreak = -1;
        } else {
          lines.push(line);
          line = [];
          lineWidth = 0;
        }
      }

      line.push(glyph);
      lineWidth += advance;

      // A space is an opportunity *after* it; a Korean syllable is one before
      // the next character, which is the same index once this one is pushed.
      if (character === " " || breaksBefore(codePoint)) {
        lastBreak = line.length;
        widthAtBreak = lineWidth;
      }
    }
    lines.push(line);
  }
  return lines;
};

/* ------------------------------------------------------------------------ */
/* Content stream                                                             */
/* ------------------------------------------------------------------------ */

const hex = (glyphs: readonly Glyph[]) =>
  glyphs.map((glyph) => glyph.id.toString(16).padStart(4, "0")).join("");

class PageBuilder {
  readonly pages: string[] = [];
  private operations: string[] = [];
  private y = CONTENT_TOP;

  constructor(private readonly font: LoadedFont) {}

  /** How much room is left on this page, in points. */
  get remaining(): number {
    return this.y - CONTENT_BOTTOM;
  }

  /** The current baseline cursor, for a block that positions cells itself. */
  get cursorY(): number {
    return this.y;
  }

  advance(amount: number) {
    this.y -= amount;
  }

  break() {
    this.pages.push(this.operations.join("\n"));
    this.operations = [];
    this.y = CONTENT_TOP;
  }

  ensure(height: number) {
    if (this.y - height < CONTENT_BOTTOM) this.break();
  }

  /** One line of text at the current position, then move down by `leading`. */
  text(glyphs: readonly Glyph[], style: Style, indent = 0) {
    this.ensure(style.leading);
    if (glyphs.length > 0) {
      const grey = style.grey ?? 0;
      this.operations.push(
        `BT`,
        `${grey} ${grey} ${grey} rg`,
        `/F1 ${style.size} Tf`,
        `1 0 0 1 ${(MARGIN + style.indent + indent).toFixed(2)} ${(
          this.y - style.size
        ).toFixed(2)} Tm`,
        `<${hex(glyphs)}> Tj`,
        `ET`
      );
    }
    this.y -= style.leading;
  }

  /**
   * One line at an absolute position, leaving the cursor where it was.
   *
   * A table lays its own cells out -- several columns share one row's vertical
   * span -- so it needs to draw without the cursor moving under it.
   */
  textAt(glyphs: readonly Glyph[], style: Style, x: number, y: number) {
    if (glyphs.length === 0) return;
    const grey = style.grey ?? 0;
    this.operations.push(
      `BT`,
      `${grey} ${grey} ${grey} rg`,
      `/F1 ${style.size} Tf`,
      `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
      `<${hex(glyphs)}> Tj`,
      `ET`
    );
  }

  rule(grey = 0.75) {
    this.ensure(12);
    this.y -= 6;
    this.operations.push(
      `${grey} ${grey} ${grey} RG`,
      `0.75 w`,
      `${MARGIN} ${this.y.toFixed(2)} m ${(PAGE_WIDTH - MARGIN).toFixed(2)} ${this.y.toFixed(2)} l S`
    );
    this.y -= 6;
  }

  fill(x: number, width: number, height: number, grey: number) {
    this.operations.push(
      `${grey} ${grey} ${grey} rg`,
      `${x.toFixed(2)} ${(this.y - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`
    );
  }

  finish(): string[] {
    if (this.operations.length > 0 || this.pages.length === 0) this.break();
    return this.pages;
  }
}

/* ------------------------------------------------------------------------ */
/* Layout                                                                     */
/* ------------------------------------------------------------------------ */

const HEADING_STYLES: Record<number, Style> = {
  1: STYLES.h1,
  2: STYLES.h2,
  3: STYLES.h3,
  4: STYLES.h4,
};

const paragraph = (
  builder: PageBuilder,
  font: LoadedFont,
  value: string,
  style: Style,
  extraIndent = 0
) => {
  builder.advance(style.spaceBefore);
  const width = CONTENT_WIDTH - style.indent - extraIndent;
  for (const line of wrap(font, value, style.size, width)) {
    builder.text(line, style, extraIndent);
  }
  builder.advance(style.spaceAfter);
};

const listBlock = (
  builder: PageBuilder,
  font: LoadedFont,
  items: readonly string[],
  marker: (index: number) => string
) => {
  const style = STYLES.listItem;
  builder.advance(6);
  items.forEach((item, index) => {
    const label = toGlyphs(font, marker(index));
    const labelWidth = glyphsWidth(label, style.size, font.unitsPerEm);
    const lines = wrap(
      font,
      item,
      style.size,
      CONTENT_WIDTH - style.indent - labelWidth - 4
    );
    lines.forEach((line, lineIndex) => {
      builder.ensure(style.leading);
      if (lineIndex === 0) builder.text(label, { ...style, leading: 0 });
      builder.text(line, style, labelWidth + 4);
    });
  });
  builder.advance(style.spaceAfter);
};

const cellText = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

const tableBlock = (
  builder: PageBuilder,
  font: LoadedFont,
  block: Extract<ArtifactDocumentBlock, { type: "table" }>
) => {
  const style = STYLES.tableCell;
  const columnCount = block.columns.length;
  const columnWidth = CONTENT_WIDTH / columnCount;
  const padding = 4;

  const rowFor = (values: readonly string[]) =>
    values.map((value) =>
      wrap(font, value, style.size, columnWidth - padding * 2)
    );

  const drawRow = (cells: Glyph[][][], header: boolean) => {
    const height = Math.max(...cells.map((lines) => lines.length)) * style.leading + padding * 2;
    builder.ensure(height);
    if (header) builder.fill(MARGIN, CONTENT_WIDTH, height, 0.94);
    const top = builder.cursorY;
    cells.forEach((lines, column) => {
      lines.forEach((line, lineIndex) => {
        builder.textAt(
          line,
          { ...style, grey: header ? 0 : 0.1 },
          MARGIN + column * columnWidth + padding,
          top - padding - (lineIndex + 1) * style.leading + 3
        );
      });
    });
    builder.advance(height);
    builder.rule(0.85);
  };

  builder.advance(8);
  drawRow(rowFor(block.columns), true);
  for (const row of block.rows) {
    drawRow(
      rowFor(block.columns.map((_, index) => cellText(row[index] ?? null))),
      false
    );
  }
  builder.advance(8);
};

/* ------------------------------------------------------------------------ */
/* PDF object graph                                                           */
/* ------------------------------------------------------------------------ */

const latin1 = (value: string) => Buffer.from(value, "latin1");

/**
 * A PDF string, escaped.
 *
 * Only used for the `ToUnicode` CMap's literals, which are already hexadecimal
 * -- but the escaping is here rather than assumed, because a writer that
 * assumes its inputs are safe is the writer that stops being true later.
 */
const pdfString = (value: string) =>
  `(${value.replace(/[\\()]/g, (match) => `\\${match}`)})`;

/**
 * The `ToUnicode` CMap, so the text can be selected and copied.
 *
 * Without it a reader has glyph ids and no idea what they mean: the PDF looks
 * right and every copy out of it produces mojibake. Written from the same
 * glyph-to-code-point pairs the content stream used, so the two cannot drift.
 */
const toUnicodeCMap = (mapping: ReadonlyMap<number, number>): string => {
  const entries = [...mapping.entries()].sort((a, b) => a[0] - b[0]);
  const chunks: string[] = [];
  for (let index = 0; index < entries.length; index += 100) {
    const slice = entries.slice(index, index + 100);
    chunks.push(
      `${slice.length} beginbfchar\n` +
        slice
          .map(([glyph, codePoint]) => {
            const source = glyph.toString(16).padStart(4, "0");
            const target =
              codePoint > 0xffff
                ? // Above the BMP the destination is a surrogate pair, which is
                  // what a UTF-16BE CMap destination has to be.
                  (() => {
                    const value = codePoint - 0x10000;
                    const high = 0xd800 + (value >> 10);
                    const low = 0xdc00 + (value & 0x3ff);
                    return (
                      high.toString(16).padStart(4, "0") +
                      low.toString(16).padStart(4, "0")
                    );
                  })()
                : codePoint.toString(16).padStart(4, "0");
            return `<${source}> <${target}>`;
          })
          .join("\n") +
        `\nendbfchar`
    );
  }

  return (
    `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n` +
    `/CIDSystemInfo << /Registry ${pdfString("Adobe")} /Ordering ${pdfString(
      "UCS"
    )} /Supplement 0 >> def\n` +
    `/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n` +
    `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n` +
    `${chunks.join("\n")}\n` +
    `endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`
  );
};

type PdfObject = { body: string; stream?: Uint8Array };

const buildPdf = (objects: PdfObject[]): Uint8Array => {
  const chunks: Buffer[] = [latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(offset);
    const header = latin1(`${index + 1} 0 obj\n${object.body}\n`);
    chunks.push(header);
    offset += header.length;
    if (object.stream) {
      const open = latin1("stream\n");
      const close = latin1("\nendstream\n");
      chunks.push(open, Buffer.from(object.stream), close);
      offset += open.length + object.stream.length + close.length;
    }
    const end = latin1("endobj\n");
    chunks.push(end);
    offset += end.length;
  });

  const xrefOffset = offset;
  const xref = [
    `xref`,
    `0 ${objects.length + 1}`,
    `0000000000 65535 f `,
    ...offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n `),
    ``,
  ].join("\n");
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root ${objects.length} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  chunks.push(latin1(xref), latin1(trailer));
  return new Uint8Array(Buffer.concat(chunks));
};

/* ------------------------------------------------------------------------ */
/* Entry point                                                                */
/* ------------------------------------------------------------------------ */

/** The PDF for an admitted document specification. */
export const renderDocumentPdf = (spec: DocumentSpec): Uint8Array => {
  const font = loadPdfFont();
  const builder = new PageBuilder(font);
  const used = new Map<number, number>();

  // Every glyph the document draws, recorded as it is measured so the subset
  // and the content stream cannot disagree about what was used.
  const record = (value: string) => {
    for (const character of value.replace(/\t/g, "    ")) {
      const codePoint = character.codePointAt(0)!;
      const glyph = glyphFor(font, codePoint);
      if (glyph !== null) used.set(glyph, codePoint);
    }
  };

  record(spec.title ?? "");
  record(spec.subtitle ?? "");
  for (const block of spec.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
      case "quote":
      case "code":
        record(block.text);
        break;
      case "bullets":
      case "numbers":
        block.items.forEach(record);
        record("•0123456789. ");
        break;
      case "table":
        block.columns.forEach(record);
        block.rows.forEach((row) => row.forEach((value) => record(cellText(value))));
        break;
      default:
        break;
    }
  }

  if (spec.title) paragraph(builder, font, spec.title, STYLES.title);
  if (spec.subtitle) paragraph(builder, font, spec.subtitle, STYLES.subtitle);

  for (const block of spec.blocks) {
    switch (block.type) {
      case "heading":
        paragraph(
          builder,
          font,
          block.text,
          HEADING_STYLES[block.level] ?? STYLES.h4
        );
        break;
      case "paragraph":
        paragraph(builder, font, block.text, STYLES.body);
        break;
      case "bullets":
        listBlock(builder, font, block.items, () => "•");
        break;
      case "numbers":
        listBlock(builder, font, block.items, (index) => `${index + 1}.`);
        break;
      case "quote":
        paragraph(builder, font, block.text, STYLES.quote);
        break;
      case "code":
        paragraph(builder, font, block.text, STYLES.code);
        break;
      case "table":
        tableBlock(builder, font, block);
        break;
      case "divider":
        builder.rule();
        break;
      case "pageBreak":
        builder.break();
        break;
    }
  }

  const pages = builder.finish();
  const fontProgram = subsetPdfFont(font, used.keys());
  const scale = 1000 / font.unitsPerEm;

  // --- objects ------------------------------------------------------------
  const objects: PdfObject[] = [];
  const add = (body: string, stream?: Uint8Array) => {
    objects.push({ body, stream });
    return objects.length;
  };

  const fontFile = add(
    `<< /Length ${fontProgram.length} /Length1 ${fontProgram.length} >>`,
    fontProgram
  );
  const descriptor = add(
    `<< /Type /FontDescriptor /FontName /${PDF_FONT_NAME} /Flags 4 ` +
      `/FontBBox [${font.bbox.map((value) => Math.round(value * scale)).join(" ")}] ` +
      `/ItalicAngle 0 /Ascent ${Math.round(font.ascent * scale)} ` +
      `/Descent ${Math.round(font.descent * scale)} /CapHeight ${Math.round(
        font.ascent * scale * 0.7
      )} /StemV 80 /FontFile2 ${fontFile} 0 R >>`
  );

  const widths = [...used.keys()]
    .sort((a, b) => a - b)
    .map((glyph) => `${glyph} [${Math.round((font.advances[glyph] ?? 0) * scale)}]`)
    .join(" ");
  const descendant = add(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${PDF_FONT_NAME} ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${descriptor} 0 R /DW 1000 /W [${widths}] ` +
      `/CIDToGIDMap /Identity >>`
  );

  const toUnicodeStream = zlibSync(
    new TextEncoder().encode(toUnicodeCMap(used)),
    { level: 6 }
  );
  const toUnicode = add(
    `<< /Length ${toUnicodeStream.length} /Filter /FlateDecode >>`,
    toUnicodeStream
  );

  const fontObject = add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /${PDF_FONT_NAME} ` +
      `/Encoding /Identity-H /DescendantFonts [${descendant} 0 R] ` +
      `/ToUnicode ${toUnicode} 0 R >>`
  );

  const contentObjects = pages.map((content) => {
    const compressed = zlibSync(new TextEncoder().encode(content), {
      level: 6,
    });
    return add(
      `<< /Length ${compressed.length} /Filter /FlateDecode >>`,
      compressed
    );
  });

  // The page tree's own object number is only known after its children, and
  // the children have to name it -- so it is reserved by writing a placeholder
  // and patching the body once every page exists.
  const pagesObjectNumber = objects.length + pages.length + 1;
  const pageObjects = contentObjects.map((content) =>
    add(
      `<< /Type /Page /Parent ${pagesObjectNumber} 0 R ` +
        `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 ${fontObject} 0 R >> >> ` +
        `/Contents ${content} 0 R >>`
    )
  );

  const pagesObject = add(
    `<< /Type /Pages /Count ${pageObjects.length} ` +
      `/Kids [${pageObjects.map((number) => `${number} 0 R`).join(" ")}] >>`
  );
  if (pagesObject !== pagesObjectNumber) {
    throw new PdfGenerationError(
      "GENERATION_FAILED",
      "The page tree object number was mispredicted."
    );
  }

  add(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);

  return buildPdf(objects);
};
