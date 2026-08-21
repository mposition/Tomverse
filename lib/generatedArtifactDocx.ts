/**
 * The trusted DOCX writer.
 *
 * Policy: docs/policy/generated-artifacts.md sections 3 and 6.
 *
 * Same construction as the XLSX writer and for the same reason: the package is
 * assembled from a fixed set of parts this file writes, and every string the
 * caller supplies reaches it through `escapeXml`. There is no template to
 * inject into and no passthrough of caller-supplied markup.
 *
 * What the package deliberately does not contain, and cannot be made to
 * contain, because nothing here writes the part:
 *
 *   * `word/vbaProject.bin` -- the package is `.docx`, never `.docm`;
 *   * `word/settings.xml` field codes -- no DDE, no INCLUDETEXT, no auto-open
 *     macro name;
 *   * hyperlink relationships or `w:fldSimple` -- a document produced from a
 *     specification has no links, because the specification has no link block;
 *   * external images or `w:altChunk`, which would embed content this
 *     application never checked.
 *
 * ## Word is stricter than Excel
 *
 * Excel opens a package with a missing optional part; Word refuses one whose
 * `styles.xml` does not define the style a paragraph names. So every style a
 * paragraph can reference is defined here, in one place, and the block writer
 * can only name a style from that set.
 */

import {
  ARTIFACT_LIMITS,
  type ArtifactDocumentBlock,
  type DocumentSpec,
} from "@/lib/generatedArtifactCore";
import {
  CORE_PROPERTIES_OVERRIDE,
  CORE_PROPERTIES_PART,
  CORE_PROPERTIES_RELATIONSHIP,
  RELATIONSHIPS_OPEN,
  XML_DECLARATION,
  escapeXml,
  relationship,
  zipOoxmlPackage,
  type OoxmlPart,
} from "@/lib/generatedArtifactXml";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** Twips: Word's unit, 1/1440 inch. A4 with 1-inch margins. */
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/**
 * Every paragraph style the block writer may name.
 *
 * A closed set, because Word refuses a document that references a style
 * `styles.xml` does not define -- and "the file downloads and will not open"
 * is the failure this whole domain exists to prevent.
 */
const PARAGRAPH_STYLES = [
  "Title",
  "Subtitle",
  "Heading1",
  "Heading2",
  "Heading3",
  "Heading4",
  "BodyText",
  "Quote",
  "CodeBlock",
  "ListParagraph",
  "TableHeader",
] as const;

type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

/**
 * The document's fonts.
 *
 * `Malgun Gothic` as the East Asian face and `Calibri` as the Latin one, with
 * `w:cs` matching the Latin. Word picks per run by script, so a Korean
 * paragraph is not left to whatever the reader's default happens to be. This
 * names fonts rather than embedding them: a `.docx` is opened by Word, which
 * has its own font book, and embedding would multiply every file by a megabyte
 * to solve a problem Word does not have. The PDF writer, whose reader has no
 * font book, embeds instead.
 */
const FONTS = `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Malgun Gothic"/>`;

const styleDefinition = (
  id: ParagraphStyle,
  name: string,
  properties: string,
  runProperties: string
) =>
  `<w:style w:type="paragraph" w:styleId="${id}">` +
  `<w:name w:val="${escapeXml(name)}"/>` +
  `<w:qFormat/>` +
  `<w:pPr>${properties}</w:pPr>` +
  `<w:rPr>${FONTS}${runProperties}</w:rPr>` +
  `</w:style>`;

const spacing = (before: number, after: number) =>
  `<w:spacing w:before="${before}" w:after="${after}"/>`;

const STYLES_XML =
  `${XML_DECLARATION}` +
  `<w:styles ${W_NS}>` +
  `<w:docDefaults><w:rPrDefault><w:rPr>${FONTS}<w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  styleDefinition("Title", "Title", spacing(0, 240), `<w:b/><w:sz w:val="52"/>`) +
  styleDefinition(
    "Subtitle",
    "Subtitle",
    spacing(0, 360),
    `<w:sz w:val="28"/><w:color w:val="595959"/>`
  ) +
  styleDefinition("Heading1", "heading 1", spacing(360, 160), `<w:b/><w:sz w:val="36"/>`) +
  styleDefinition("Heading2", "heading 2", spacing(280, 140), `<w:b/><w:sz w:val="30"/>`) +
  styleDefinition("Heading3", "heading 3", spacing(240, 120), `<w:b/><w:sz w:val="26"/>`) +
  styleDefinition("Heading4", "heading 4", spacing(200, 100), `<w:b/><w:sz w:val="24"/>`) +
  styleDefinition("BodyText", "Body Text", spacing(0, 160), "") +
  styleDefinition(
    "Quote",
    "Quote",
    `${spacing(120, 160)}<w:ind w:left="480"/>` +
      `<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BFBFBF"/></w:pBdr>`,
    `<w:i/><w:color w:val="404040"/>`
  ) +
  styleDefinition(
    "CodeBlock",
    "Code Block",
    `${spacing(120, 160)}<w:shd w:val="clear" w:fill="F2F2F2"/>`,
    `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas" w:eastAsia="Malgun Gothic"/><w:sz w:val="19"/>`
  ) +
  styleDefinition("ListParagraph", "List Paragraph", spacing(0, 60), "") +
  styleDefinition("TableHeader", "Table Header", spacing(40, 40), `<w:b/>`) +
  `</w:styles>`;

/**
 * Two numbering definitions: a bullet list and a decimal list.
 *
 * Word needs a `numbering.xml` for any list at all -- there is no "just make
 * it a bullet" paragraph property. Both are single-level, because the
 * specification has no nested list block and inventing one from indentation
 * would be guessing at structure the model did not state.
 */
const NUMBERING_XML =
  `${XML_DECLARATION}` +
  `<w:numbering ${W_NS}>` +
  `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>` +
  `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>` +
  `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:hint="default"/></w:rPr></w:lvl>` +
  `</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>` +
  `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>` +
  `</w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
  `</w:numbering>`;

/**
 * One run of text, with hard line breaks preserved.
 *
 * `xml:space="preserve"` because a paragraph that begins with a space is a
 * paragraph the author indented, and Word collapses it otherwise.
 */
const run = (textValue: string, extraProperties = ""): string => {
  const lines = textValue.split(/\r\n|\r|\n/);
  const properties = `<w:rPr>${FONTS}${extraProperties}</w:rPr>`;
  return lines
    .map(
      (line, index) =>
        `<w:r>${properties}` +
        (index > 0 ? `<w:br/>` : "") +
        `<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
    )
    .join("");
};

const paragraph = (
  style: ParagraphStyle,
  textValue: string,
  numberingId?: 1 | 2
): string =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/>` +
  (numberingId
    ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numberingId}"/></w:numPr>`
    : "") +
  `</w:pPr>${run(textValue)}</w:p>`;

const cellText = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

const tableBlock = (block: Extract<ArtifactDocumentBlock, { type: "table" }>) => {
  const columnCount = block.columns.length;
  const columnWidth = Math.floor(CONTENT_WIDTH / columnCount);
  const border = (edge: string) =>
    `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
  const borders =
    `<w:tblBorders>${border("top")}${border("left")}${border("bottom")}` +
    `${border("right")}${border("insideH")}${border("insideV")}</w:tblBorders>`;

  const cell = (value: string, header: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/>` +
    (header ? `<w:shd w:val="clear" w:fill="EFEFEF"/>` : "") +
    `</w:tcPr>${paragraph(header ? "TableHeader" : "BodyText", value)}</w:tc>`;

  const headerRow =
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>` +
    block.columns.map((column) => cell(column, true)).join("") +
    `</w:tr>`;

  const bodyRows = block.rows
    .map(
      (row) =>
        `<w:tr>` +
        Array.from({ length: columnCount }, (_, index) =>
          cell(cellText(row[index]), false)
        ).join("") +
        `</w:tr>`
    )
    .join("");

  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${CONTENT_WIDTH}" w:type="dxa"/>${borders}</w:tblPr>` +
    `<w:tblGrid>${block.columns
      .map(() => `<w:gridCol w:w="${columnWidth}"/>`)
      .join("")}</w:tblGrid>` +
    headerRow +
    bodyRows +
    `</w:tbl>` +
    // Word needs a paragraph after a table, or the next table merges into it.
    `<w:p/>`
  );
};

const HEADING_STYLES: Record<number, ParagraphStyle> = {
  1: "Heading1",
  2: "Heading2",
  3: "Heading3",
  4: "Heading4",
};

const renderBlock = (block: ArtifactDocumentBlock): string => {
  switch (block.type) {
    case "heading":
      return paragraph(HEADING_STYLES[block.level] ?? "Heading4", block.text);
    case "paragraph":
      return paragraph("BodyText", block.text);
    case "bullets":
      return block.items
        .map((item) => paragraph("ListParagraph", item, 1))
        .join("");
    case "numbers":
      return block.items
        .map((item) => paragraph("ListParagraph", item, 2))
        .join("");
    case "quote":
      return paragraph("Quote", block.text);
    case "code":
      // One paragraph, not one per line: `run` turns the newlines into
      // `<w:br/>`, which keeps the block shaded as a single unit.
      return paragraph("CodeBlock", block.text);
    case "table":
      return tableBlock(block);
    case "divider":
      return (
        `<w:p><w:pPr><w:pBdr>` +
        `<w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/>` +
        `</w:pBdr></w:pPr></w:p>`
      );
    case "pageBreak":
      return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  }
};

const CONTENT_TYPES_XML =
  `${XML_DECLARATION}` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ` +
  `ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `<Override PartName="/word/styles.xml" ` +
  `ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
  `<Override PartName="/word/numbering.xml" ` +
  `ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
  CORE_PROPERTIES_OVERRIDE +
  `</Types>`;

const ROOT_RELS_XML =
  `${XML_DECLARATION}${RELATIONSHIPS_OPEN}` +
  relationship(
    "rId1",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
    "word/document.xml"
  ) +
  CORE_PROPERTIES_RELATIONSHIP +
  `</Relationships>`;

const DOCUMENT_RELS_XML =
  `${XML_DECLARATION}${RELATIONSHIPS_OPEN}` +
  relationship(
    "rId1",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
    "styles.xml"
  ) +
  relationship(
    "rId2",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
    "numbering.xml"
  ) +
  `</Relationships>`;

/** The WordprocessingML package for an admitted document specification. */
export const renderDocumentDocx = (spec: DocumentSpec): Uint8Array => {
  const body =
    (spec.title ? paragraph("Title", spec.title) : "") +
    (spec.subtitle ? paragraph("Subtitle", spec.subtitle) : "") +
    spec.blocks.map(renderBlock).join("");

  const sectionProperties =
    `<w:sectPr>` +
    `<w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>` +
    `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" ` +
    `w:header="720" w:footer="720" w:gutter="0"/>` +
    `</w:sectPr>`;

  const documentXml =
    `${XML_DECLARATION}` +
    `<w:document ${W_NS}><w:body>${body}${sectionProperties}</w:body></w:document>`;

  const parts: OoxmlPart[] = [
    { path: "[Content_Types].xml", xml: CONTENT_TYPES_XML },
    { path: "_rels/.rels", xml: ROOT_RELS_XML },
    CORE_PROPERTIES_PART,
    { path: "word/document.xml", xml: documentXml },
    { path: "word/_rels/document.xml.rels", xml: DOCUMENT_RELS_XML },
    { path: "word/styles.xml", xml: STYLES_XML },
    { path: "word/numbering.xml", xml: NUMBERING_XML },
  ];

  return zipOoxmlPackage(parts);
};

/** Exported for the test that asserts the closed style set stays closed. */
export const DOCX_PARAGRAPH_STYLES = PARAGRAPH_STYLES;

/** The block ceiling, restated where the writer can be checked against it. */
export const DOCX_MAX_BLOCKS = ARTIFACT_LIMITS.maxDocumentBlocks;
