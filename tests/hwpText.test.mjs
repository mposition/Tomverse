import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deflateSync, zipSync } from "fflate";

import { resolveChatAttachmentFormat } from "../lib/chatAttachmentFormats.ts";
import { validateChatAttachmentUpload } from "../lib/chatAttachmentValidation.ts";
import { OFFICE_RENDERABLE_EXTENSIONS } from "../lib/fileConversionCore.ts";
import { createLegacyParseBudget } from "../lib/legacyOffice/budget.ts";
import { openCompoundFile, readCompoundStream } from "../lib/legacyOffice/cfbf.ts";
import { extractLegacyOfficeText } from "../lib/legacyOfficeText.ts";
import { measureRenderInput } from "../lib/officeRenderInput.ts";
import { buildCompoundFile } from "./support/compoundFile.mjs";

// docs/policy/chat-attachment-formats.md section 4.6.
//
// HWP 5.x and HWPX, read for their text. The hostile and edge cases are
// built field by field from the HWP 5.0 specification with the repository's
// test compound-file writer; the happy path is also checked against a document
// Hancom Office saved (fixtures/legacyOffice/sample-hancom.hwp, at the end).

const encoder = new TextEncoder();

/** One HWP record: a 32-bit header (tag, level, size), then the data. */
const record = (tag, data, level = 0) => {
  const large = data.length >= 0xfff;
  const header = new Uint8Array(large ? 8 : 4);
  const view = new DataView(header.buffer);
  view.setUint32(0, (tag & 0x3ff) | ((level & 0x3ff) << 10) | ((large ? 0xfff : data.length) << 20), true);
  if (large) view.setUint32(4, data.length, true);
  const out = new Uint8Array(header.length + data.length);
  out.set(header);
  out.set(data, header.length);
  return out;
};

const utf16 = (units) => {
  const out = new Uint8Array(units.length * 2);
  const view = new DataView(out.buffer);
  units.forEach((unit, index) => view.setUint16(index * 2, unit, true));
  return out;
};

const unitsOf = (text) =>
  [...text].flatMap((character) => {
    const code = character.codePointAt(0);
    return code > 0xffff
      ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)]
      : [code];
  });

const PARA_TEXT = 0x10 + 51;
const PARA_HEADER = 0x10 + 50;

/** A paragraph's text record: the words, then the paragraph-end control. */
const paragraph = (units) => record(PARA_TEXT, utf16([...units, 13]));

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const fileHeader = (properties) => {
  const header = new Uint8Array(256);
  header.set(encoder.encode("HWP Document File"));
  const view = new DataView(header.buffer);
  view.setUint32(32, 0x05010100, true);
  view.setUint32(36, properties, true);
  return header;
};

const hwp = ({ properties = 1, sections }) =>
  buildCompoundFile([
    { name: "FileHeader", data: fileHeader(properties) },
    { name: "DocInfo", data: new Uint8Array(16) },
    ...sections.map((data, index) => ({
      name: `Section${index}`,
      data: properties & 1 ? deflateSync(data) : data,
    })),
  ]);

const readText = (bytes, format) => extractLegacyOfficeText(bytes, format).text;

test("an HWP 5 document's paragraphs are read in order, across sections", () => {
  const bytes = hwp({
    sections: [
      concat([
        record(PARA_HEADER, new Uint8Array(22)),
        paragraph(unitsOf("공문: 2026년 예산 안내")),
        paragraph(unitsOf("첫째 줄")),
      ]),
      concat([paragraph(unitsOf("둘째 구역 🙂"))]),
    ],
  });
  assert.equal(readText(bytes, "hwp"), "공문: 2026년 예산 안내\n첫째 줄\n둘째 구역 🙂");
});

test("control characters are read at their real width, so their data is never text", () => {
  // A table control (11, eight units), a tab (9, eight units), a line break
  // (10, one unit) and a non-breaking space (30, one unit).
  const table = [11, 0x6274, 0x6c62, 0, 0, 0, 0, 11];
  const tab = [9, 0, 0, 0, 0, 0, 0, 9];
  const bytes = hwp({
    sections: [
      paragraph([
        ...table,
        ...unitsOf("항목"),
        ...tab,
        ...unitsOf("값"),
        10,
        ...unitsOf("다음"),
        30,
        ...unitsOf("끝"),
      ]),
    ],
  });
  assert.equal(readText(bytes, "hwp"), "항목\t값\n다음 끝");
});

test("an uncompressed document and a record longer than 4,094 bytes read the same way", () => {
  const long = "가".repeat(3000);
  const bytes = hwp({ properties: 0, sections: [paragraph(unitsOf(long))] });
  assert.equal(readText(bytes, "hwp"), long);
});

test("a password-protected, distribution or DRM document is refused, never read as noise", () => {
  for (const flag of [1 << 1, 1 << 2, 1 << 4, 1 << 8, 1 << 10]) {
    assert.throws(
      () => readText(hwp({ properties: 1 | flag, sections: [paragraph(unitsOf("비밀"))] }), "hwp"),
      (error) => error.code === "LEGACY_OFFICE_ENCRYPTED"
    );
  }
});

test("a compound file that is not HWP, and a truncated record, are refused", () => {
  const notHwp = buildCompoundFile([{ name: "FileHeader", data: new Uint8Array(256) }]);
  assert.throws(() => readText(notHwp, "hwp"), (error) => error.code === "LEGACY_OFFICE_CORRUPT");
  const truncated = hwp({ properties: 0, sections: [paragraph(unitsOf("abc")).subarray(0, 6)] });
  assert.throws(() => readText(truncated, "hwp"), (error) => error.code === "LEGACY_OFFICE_CORRUPT");
});

/* ------------------------------------------------------------------------ */
/* HWPX                                                                       */
/* ------------------------------------------------------------------------ */

const hwpx = (sections) =>
  zipSync({
    mimetype: encoder.encode("application/hwp+zip"),
    "Contents/content.hpf": encoder.encode("<opf:package/>"),
    ...Object.fromEntries(
      sections.map((xml, index) => [`Contents/section${index}.xml`, encoder.encode(xml)])
    ),
  });

const section = (body) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">' +
  body +
  "</hs:sec>";

test("an HWPX document's runs are joined into paragraphs, table cells each on their own line", () => {
  const bytes = hwpx([
    section(
      "<hp:p><hp:run><hp:t>안내 &amp; 공지</hp:t></hp:run><hp:run><hp:t>(요약)</hp:t></hp:run></hp:p>" +
        "<hp:p><hp:run><hp:tbl><hp:tr>" +
        "<hp:tc><hp:subList><hp:p><hp:run><hp:t>이름</hp:t></hp:run></hp:p></hp:subList></hp:tc>" +
        "<hp:tc><hp:subList><hp:p><hp:run><hp:t>값<hp:tab/>2</hp:t></hp:run></hp:p></hp:subList></hp:tc>" +
        "</hp:tr></hp:tbl></hp:run></hp:p>"
    ),
    section("<hp:p><hp:run><hp:t>둘째<hp:lineBreak/>줄</hp:t></hp:run></hp:p>"),
  ]);
  assert.equal(readText(bytes, "hwpx"), "안내 & 공지(요약)\n이름\n값\t2\n둘째\n줄");
});

test("ninth review: a section of text tags that never close is read in one pass", () => {
  const bytes = hwpx([section("<hp:p><hp:run>" + "<hp:t>x".repeat(40_000) + "</hp:p>")]);
  const started = performance.now();
  assert.equal(readText(bytes, "hwpx"), "x".repeat(40_000));
  // A pattern that looks ahead for each closing tag rescans the rest of the
  // section once per opening tag: seconds here, minutes at upload size.
  assert.ok(performance.now() - started < 1000, "linear in the section");
});

test("tenth review: CDATA is text, comments are not, and a `>` in an attribute does not end its tag", () => {
  const bytes = hwpx([
    section(
      '<hp:p><hp:run charPrIDRef="a>b"><hp:t>앞 <![CDATA[<그대로> & 둔다]]><!-- 메모 --> 뒤</hp:t></hp:run></hp:p>' +
        "<hp:p><hp:run><hp:t>둘째</hp:t></hp:run></hp:p>"
    ),
  ]);
  assert.equal(readText(bytes, "hwpx"), "앞 <그대로> & 둔다 뒤\n둘째");
});

test("a ZIP with no HWPX section, or a compound file named .hwpx, is refused", () => {
  assert.throws(
    () => readText(zipSync({ "readme.txt": encoder.encode("x") }), "hwpx"),
    (error) => error.code === "LEGACY_OFFICE_CORRUPT"
  );
  assert.throws(
    () => readText(hwp({ sections: [paragraph(unitsOf("x"))] }), "hwpx"),
    (error) => error.code === "LEGACY_OFFICE_CORRUPT"
  );
});

/* ------------------------------------------------------------------------ */
/* As attachments                                                             */
/* ------------------------------------------------------------------------ */

test("HWP and HWPX attach like the other legacy formats, guests included, and the renderer can lay them out", async () => {
  for (const [name, type, id] of [
    ["공문.hwp", "application/x-hwp", "hwp"],
    ["공문.hwp", "application/haansofthwp", "hwp"],
    ["공문.hwpx", "", "hwpx"],
  ]) {
    const format = resolveChatAttachmentFormat({ filename: name, declaredMediaType: type });
    assert.equal(format?.id, id, `${name} ${type}`);
    assert.equal(format.category, "legacy-office");
    assert.equal(format.guestAllowed, true);
    assert.ok(OFFICE_RENDERABLE_EXTENSIONS[format.mediaType]);
  }

  const format = resolveChatAttachmentFormat({ filename: "a.hwp", declaredMediaType: "application/x-hwp" });
  const valid = await validateChatAttachmentUpload({
    buffer: Buffer.from(hwp({ sections: [paragraph(unitsOf("본문"))] })),
    format,
    scope: "guest",
    maxExtractedCharacters: 1000,
  });
  assert.equal(valid.mediaType, "application/x-hwp");
  await assert.rejects(
    validateChatAttachmentUpload({
      buffer: Buffer.from(hwp({ properties: 3, sections: [paragraph(unitsOf("비밀"))] })),
      format,
      scope: "account",
    }),
    (error) => error.code === "ATTACHMENT_ENCRYPTED"
  );
});

/* ------------------------------------------------------------------------ */
/* Found by the independent review: what a hostile file can make us do       */
/* ------------------------------------------------------------------------ */

test("a compressed HWP section that expands without end is stopped part-way", () => {
  // 64 MB of zeros, about 64 KB compressed: past the 20 MB byte budget.
  const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024), { level: 9 });
  const bytes = buildCompoundFile([
    { name: "FileHeader", data: fileHeader(1) },
    { name: "Section0", data: bomb },
  ]);
  const started = Date.now();
  assert.throws(() => readText(bytes, "hwp"), (error) => error.code === "LEGACY_OFFICE_TOO_LARGE");
  assert.ok(Date.now() - started < 10_000);
});

test("an HWPX section that expands without end is stopped part-way, whatever it declares", () => {
  const bytes = zipSync({
    mimetype: encoder.encode("application/hwp+zip"),
    "Contents/section0.xml": new Uint8Array(64 * 1024 * 1024),
  });
  assert.throws(() => readText(bytes, "hwpx"), (error) => error.code === "LEGACY_OFFICE_TOO_LARGE");
});

test("text after the last closed paragraph still counts against the character ceiling", () => {
  const bytes = hwpx([section(`<hp:p><hp:run><hp:t>${"가".repeat(500)}</hp:t></hp:run>`)]);
  assert.throws(
    () => extractLegacyOfficeText(bytes, "hwpx", { maxCharacters: 100 }),
    (error) => error.code === "LEGACY_OFFICE_TOO_LARGE"
  );
});

/* ------------------------------------------------------------------------ */
/* A document Hancom Office saved                                             */
/* ------------------------------------------------------------------------ */

test("a real Hancom HWP reads in full: its own preview text is the answer key", async () => {
  const bytes = new Uint8Array(
    readFileSync(fileURLToPath(new URL("./fixtures/legacyOffice/sample-hancom.hwp", import.meta.url)))
  );
  const file = openCompoundFile(bytes, createLegacyParseBudget());
  const header = readCompoundStream(file, "FileHeader");
  // A compressed body, as Hancom writes by default: the inflating path is the one tested.
  assert.equal(new DataView(header.buffer, header.byteOffset).getUint32(36, true) & 1, 1);

  const text = readText(bytes, "hwp");
  const lines = text.split("\n");
  assert.equal(lines[0], "교정기관 사서함 주소(e-그린우편 작성 시)");
  assert.deepEqual(lines.slice(1, 8), ["", "기관명", "우편번호", "사서함주소", "서울구", "15829", "경기도 군포우체국 사서함 20호"]);
  // The preview below stops at about 1 KB; the last row and the line count
  // hold the rest of the document.
  assert.equal(lines.length, 170);
  assert.deepEqual(lines.slice(-3), ["거창구", "50132", "경상남도 거창군 거창우체국 사서함 1호"]);
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f�-]/, "no control characters or replacement glyphs");

  // PrvText is the plain text Hancom stores for its own file preview (UTF-16,
  // cells set off with < >, cut short at about 1 KB). Every whole word in it
  // is in what the parser read, in the same order.
  const preview = new TextDecoder("utf-16le").decode(readCompoundStream(file, "PrvText"));
  const words = preview.split(/[<>\s]+/).filter(Boolean).slice(0, -1);
  assert.ok(words.length > 50, `preview words: ${words.length}`);
  let from = 0;
  for (const word of words) {
    const at = text.indexOf(word, from);
    assert.ok(at >= 0, `missing or out of order: ${word}`);
    from = at + word.length;
  }

  assert.deepEqual(measureRenderInput("application/x-hwp", bytes), { ok: true });
  const format = resolveChatAttachmentFormat({ filename: "주소.hwp", declaredMediaType: "application/x-hwp" });
  const valid = await validateChatAttachmentUpload({
    buffer: Buffer.from(bytes),
    format,
    scope: "guest",
    maxExtractedCharacters: 100_000,
  });
  assert.equal(valid.mediaType, "application/x-hwp");
});
