import { zipSync } from "fflate";

/**
 * Hand-built Office packages for the template-batch tests.
 *
 * Built rather than checked in as binaries, for two reasons. A committed
 * .docx is opaque to review -- nobody can see from the diff that the
 * placeholder in it is split across three runs, which is the entire property
 * the test is about. And a malicious fixture (a macro project, an external
 * relationship, a traversal entry) has to be *constructible* here, because
 * committing one is committing the thing the code is supposed to refuse.
 *
 * The packages are minimal but real: content types, relationships, styles, a
 * theme, a header, a footer, a table, section properties and an image part,
 * so "the template was preserved" is a claim with something to preserve.
 */

const encoder = new TextEncoder();

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A one-pixel PNG, so the package has a real binary media part to keep. */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/**
 * One paragraph whose text is deliberately chopped into several runs.
 *
 * `runs` is a list of strings; each becomes its own `<w:r><w:t>`. Word does
 * this on its own whenever a spell-check boundary or a language tag falls in
 * the middle of a word, which is why a placeholder in a real template is
 * almost never contiguous in the XML.
 */
export const splitParagraph = (runs, { style } = {}) =>
  `<w:p>${
    style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""
  }${runs
    .map(
      (run) =>
        `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${run}</w:t></w:r>`
    )
    .join("")}</w:p>`;

const CONTENT_TYPES = `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

const STYLES = `${XML_DECLARATION}<w:styles ${W_NS}>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:sz w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TomverseGrid"><w:name w:val="Tomverse Grid"/></w:style>
</w:styles>`;

const THEME = `${XML_DECLARATION}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="TomverseTheme">
<a:themeElements><a:clrScheme name="Tomverse"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1></a:clrScheme></a:themeElements>
</a:theme>`;

const HEADER = `${XML_DECLARATION}<w:hdr ${W_NS}>${splitParagraph([
  "주식회사 ",
  "톰버스 — ",
  "{{소속",
  "팀}}",
])}</w:hdr>`;

const FOOTER = `${XML_DECLARATION}<w:ftr ${W_NS}>${splitParagraph([
  "발행일 ",
  "{{입사",
  "일}}",
])}</w:ftr>`;

const CORE_PROPERTIES = `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>근로계약서</dc:title></cp:coreProperties>`;

/**
 * The document body: a title, a split-run greeting, a table whose cells carry
 * placeholders, an image, and section properties naming the header and footer.
 */
const documentXml = (body) =>
  `${XML_DECLARATION}<w:document ${W_NS}><w:body>${body}</w:body></w:document>`;

const DEFAULT_BODY = [
  splitParagraph(["근로", "계약서"], { style: "Title" }),
  // The property this whole module exists for: one placeholder, four runs.
  splitParagraph(["안녕하세요 ", "{{", "이름", "}}", " 님."], {
    style: "BodyText",
  }),
  `<w:tbl><w:tblPr><w:tblStyle w:val="TomverseGrid"/></w:tblPr>` +
    `<w:tr><w:tc>${splitParagraph(["생년월일"])}</w:tc><w:tc>${splitParagraph([
      "{{생년",
      "월일}}",
    ])}</w:tc></w:tr>` +
    `<w:tr><w:tc>${splitParagraph(["입사일"])}</w:tc><w:tc>${splitParagraph([
      "{{입사일}}",
    ])}</w:tc></w:tr>` +
    `<w:tr><w:tc>${splitParagraph(["소속팀"])}</w:tc><w:tc>${splitParagraph([
      "{{소속팀}}",
    ])}</w:tc></w:tr></w:tbl>`,
  `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
  `<w:sectPr><w:headerReference w:type="default" r:id="rId3"/><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`,
].join("");

/**
 * A .docx template.
 *
 * `overrides` replaces or adds parts by name; `body` replaces the document
 * body. Both exist so a test can build the *one* difference it is about
 * without restating a package.
 */
export const buildDocxTemplate = ({ body, overrides = {} } = {}) => {
  const parts = {
    "[Content_Types].xml": encoder.encode(CONTENT_TYPES),
    "_rels/.rels": encoder.encode(ROOT_RELS),
    "word/document.xml": encoder.encode(documentXml(body ?? DEFAULT_BODY)),
    "word/_rels/document.xml.rels": encoder.encode(DOCUMENT_RELS),
    "word/styles.xml": encoder.encode(STYLES),
    "word/theme/theme1.xml": encoder.encode(THEME),
    "word/header1.xml": encoder.encode(HEADER),
    "word/footer1.xml": encoder.encode(FOOTER),
    "word/media/image1.png": PNG_BYTES,
    "docProps/core.xml": encoder.encode(CORE_PROPERTIES),
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) {
      delete parts[name];
      continue;
    }
    parts[name] = typeof value === "string" ? encoder.encode(value) : value;
  }
  return zipSync(parts, { level: 6, mtime: Date.UTC(2020, 0, 1) });
};

export const DOCX_TEMPLATE_PARTS = {
  contentTypes: CONTENT_TYPES,
  documentRels: DOCUMENT_RELS,
  styles: STYLES,
  theme: THEME,
  header: HEADER,
  footer: FOOTER,
};

/* -------------------------------------------------------------------------- */
/* Workbooks                                                                    */
/* -------------------------------------------------------------------------- */

const columnLetter = (index) => {
  let letters = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
};

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * An .xlsx whose cells are given as `{ text }`, `{ number }` or `{ date }`.
 *
 * Dates are written the way Excel writes them -- a serial number carrying a
 * date number format -- because that is the shape the reader has to get right
 * and a fixture that wrote them as strings would test nothing.
 */
export const buildXlsx = ({ sheetName = "Sheet1", rows }) => {
  const shared = [];
  const sharedIndex = new Map();
  const internSharedString = (value) => {
    if (sharedIndex.has(value)) return sharedIndex.get(value);
    const index = shared.length;
    shared.push(value);
    sharedIndex.set(value, index);
    return index;
  };

  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, columnIndex) => {
          if (cell === null || cell === undefined) return "";
          const reference = `${columnLetter(columnIndex)}${rowIndex + 1}`;
          if (typeof cell === "object" && "date" in cell) {
            // 1899-12-30 is Excel's epoch: it reproduces the Lotus 1-2-3 bug
            // in which 1900 is treated as a leap year.
            const serial =
              (Date.parse(`${cell.date}T00:00:00Z`) - Date.UTC(1899, 11, 30)) /
              86_400_000;
            return `<c r="${reference}" s="1"><v>${serial}</v></c>`;
          }
          if (typeof cell === "object" && "number" in cell) {
            return `<c r="${reference}"><v>${cell.number}</v></c>`;
          }
          const text = typeof cell === "object" ? cell.text : cell;
          return `<c r="${reference}" t="s"><v>${internSharedString(
            String(text)
          )}</v></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  const parts = {
    "[Content_Types].xml": encoder.encode(`${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    "_rels/.rels": encoder.encode(`${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    "xl/workbook.xml": encoder.encode(`${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    "xl/_rels/workbook.xml.rels": encoder.encode(`${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    "xl/worksheets/sheet1.xml": encoder.encode(`${XML_DECLARATION}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
    // Style index 1 is the date format (built-in 14, `m/d/yyyy`); index 0 is
    // General. The reader decides "this number is a date" from exactly this.
    "xl/styles.xml": encoder.encode(`${XML_DECLARATION}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>
</styleSheet>`),
    "xl/sharedStrings.xml": encoder.encode(`${XML_DECLARATION}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
      .map((value) => `<si><t>${escapeXml(value)}</t></si>`)
      .join("")}</sst>`),
  };

  return zipSync(parts, { level: 6, mtime: Date.UTC(2020, 0, 1) });
};
