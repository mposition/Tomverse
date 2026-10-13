// The improvement scout's renderer probes: fixed specifications and the
// structural judgement of what the renderers made, with no IO of its own.
//
// docs/policy/product-research-agent.md §12: each format has a specification
// written here -- mixed Korean and English titles, a long table, a long word,
// several pages -- and an expected range. The specification goes through the
// same admission the chat tool uses before it is rendered, and the files and
// rasters stay in memory. The S0 probe uses this module so that what S0 shows
// working is the probe the walker will run.

import { unzipSync } from "fflate";

const LONG_WORD = "Supercalifragilisticexpialidocious".repeat(3);

const tableRows = (count) =>
  Array.from({ length: count }, (_, index) => [
    `행 ${index + 1} row`,
    index * 1250,
    index % 3 === 0 ? `긴 설명 ${LONG_WORD}` : "짧은 설명",
  ]);

const documentBlocks = [
  { type: "heading", level: 1, text: "개선 탐색 probe 문서 Scout probe document" },
  {
    type: "paragraph",
    text: "이 문서는 렌더러가 한글과 English를 함께 담는지 확인하는 고정 명세입니다. " +
      `It also carries one very long word: ${LONG_WORD}.`,
  },
  { type: "bullets", items: ["첫째 항목 first item", "둘째 항목 second item", "셋째 항목 third item"] },
  { type: "table", columns: ["항목 Item", "금액 Amount", "설명 Note"], rows: tableRows(60) },
  { type: "pageBreak" },
  { type: "heading", level: 2, text: "두 번째 쪽 Second page" },
  { type: "paragraph", text: "마지막 문단입니다. The last paragraph." },
];

/**
 * The probes, in the order the walker runs them. Each names the admission and
 * renderer it goes through, so a probe cannot reach a renderer by a path the
 * chat tool would not take.
 */
export const RENDERER_PROBES = Object.freeze([
  Object.freeze({
    id: "pdf.document",
    kind: "document",
    format: "pdf",
    spec: { filename: "scout-probe.pdf", format: "pdf", title: "개선 탐색 probe", blocks: documentBlocks },
    expect: { minBytes: 5_000, maxBytes: 3_000_000, minPages: 2, maxPages: 20 },
  }),
  Object.freeze({
    id: "docx.document",
    kind: "document",
    format: "docx",
    spec: { filename: "scout-probe.docx", format: "docx", title: "개선 탐색 probe", blocks: documentBlocks },
    expect: { minBytes: 3_000, maxBytes: 3_000_000, parts: ["[Content_Types].xml", "word/document.xml"] },
  }),
  Object.freeze({
    id: "xlsx.workbook",
    kind: "spreadsheet",
    format: "xlsx",
    spec: {
      filename: "scout-probe.xlsx",
      format: "xlsx",
      worksheets: [
        {
          name: "요약 Summary",
          columns: [
            { header: "항목 Item" },
            { header: "금액 Amount", type: "number" },
            { header: "설명 Note" },
          ],
          rows: tableRows(200),
        },
        { name: "두번째 Second", columns: [{ header: "값 Value" }], rows: [["하나"], ["two"]] },
      ],
    },
    expect: {
      minBytes: 3_000,
      maxBytes: 3_000_000,
      parts: ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"],
    },
  }),
  Object.freeze({
    id: "pptx.presentation",
    kind: "presentation",
    format: "pptx",
    spec: {
      filename: "scout-probe.pptx",
      format: "pptx",
      slides: [
        { layout: "title", title: "개선 탐색 probe 발표", subtitle: "Scout probe deck" },
        { title: "두 번째 슬라이드 Second", bullets: ["첫째 first", "둘째 second", `긴 단어 ${LONG_WORD}`] },
        { layout: "sectionHeader", title: "마지막 Last" },
      ],
    },
    expect: {
      minBytes: 5_000,
      maxBytes: 3_000_000,
      parts: ["[Content_Types].xml", "ppt/presentation.xml", "ppt/slides/slide1.xml", "ppt/slides/slide3.xml"],
    },
  }),
]);

/** Hangul syllables, the only Korean the probe specifications contain. */
const HANGUL = /[가-힣]/;

/** Whether text contains Korean. */
export const containsHangul = (text) => HANGUL.test(String(text));

/**
 * The part names of an OOXML (zip) file, or null when it is not a zip that
 * opens. RND-02 can only ever say "broken": a package with every part can
 * still be one Office refuses (docs/policy/generated-artifacts.md §4).
 *
 * @param {Uint8Array} bytes
 * @returns {string[] | null}
 */
export function zipPartNames(bytes) {
  try {
    return Object.keys(unzipSync(bytes, { filter: () => true })).sort();
  } catch {
    return null;
  }
}

/**
 * Whether a PDF embeds a font program -- the precondition for RND-03, since a
 * PDF that only names a font leaves Korean to whatever the reader has.
 *
 * @param {Uint8Array} bytes
 */
export function pdfEmbedsFontProgram(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  return /\/FontFile[23]?\b/.test(text);
}

/**
 * Text items that sit outside their page (RND-04). Coordinates are PDF user
 * space from pdf.js: `x`, `y` the item's origin and `width` its advance.
 *
 * @param {{ x: number, y: number, width: number }[]} items
 * @param {{ width: number, height: number }} page
 * @param {number} [tolerance] points of slack for glyph overhang
 * @returns {number}
 */
export function textItemsOutsidePage(items, page, tolerance = 1) {
  return items.filter(
    ({ x, y, width }) =>
      x < -tolerance || y < -tolerance || x + width > page.width + tolerance || y > page.height + tolerance,
  ).length;
}

/**
 * The structural verdict for one rendered probe, as the RND rules read it.
 *
 * @param {{ expect: { minBytes: number, maxBytes: number, parts?: string[], minPages?: number, maxPages?: number } }} probe
 * @param {{ byteLength: number, parts?: string[] | null, pages?: number, hangulInText?: boolean, embedsFont?: boolean, outsidePage?: number }} observed
 * @returns {string[]} the rule ids that would fire; empty means nothing to report
 */
export function rendererProbeFindings(probe, observed) {
  const findings = [];
  const { expect } = probe;
  if (observed.parts !== undefined) {
    if (observed.parts === null || (expect.parts ?? []).some((part) => !observed.parts.includes(part))) findings.push("RND-02");
  }
  if (observed.embedsFont === false || observed.hangulInText === false) findings.push("RND-03");
  if ((observed.outsidePage ?? 0) > 0) findings.push("RND-04");
  const sizeOut = observed.byteLength < expect.minBytes || observed.byteLength > expect.maxBytes;
  const pagesOut =
    observed.pages !== undefined &&
    ((expect.minPages !== undefined && observed.pages < expect.minPages) ||
      (expect.maxPages !== undefined && observed.pages > expect.maxPages));
  if (sizeOut || pagesOut) findings.push("RND-05");
  return findings;
}
