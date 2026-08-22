import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createLegacyParseBudget } from "../lib/legacyOffice/budget.ts";
import { openCompoundFile, readCompoundStream } from "../lib/legacyOffice/cfbf.ts";
import { extractRtfText } from "../lib/legacyOffice/rtf.ts";
import { extractLegacyOfficeText } from "../lib/legacyOfficeText.ts";
import {
  biffRecord,
  buildCompoundFile,
  concatBytes,
} from "./support/compoundFile.mjs";

/**
 * Word 97-2003, Excel 97-2003, PowerPoint 97-2003 and RTF.
 *
 * The happy paths run against documents LibreOffice produced (see
 * `fixtures/legacyOffice/README.md`); the refusals run against containers
 * built here, because no tool that writes valid files can produce a chain
 * that loops or a workbook that is encrypted without a password to encrypt
 * it with.
 */

const fixture = (name) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./fixtures/legacyOffice/${name}`, import.meta.url)))
  );

// Matched by name rather than by `instanceof`: the module graph the test
// runner builds resolves `@/lib/...` and `../lib/...` to separate instances of
// the same file, so the class identity differs by which import chain threw.
// The bundler does not do that, and the code is the contract either way.
const refuses = (run, code) =>
  assert.throws(run, (error) => {
    assert.equal(error?.name, "LegacyOfficeError", String(error));
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });

const utf8 = (text) => new TextEncoder().encode(text);
const utf16 = (text) => {
  const out = new Uint8Array(text.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < text.length; index += 1) {
    view.setUint16(index * 2, text.charCodeAt(index), true);
  }
  return out;
};

// -- Real documents ----------------------------------------------------------

test("a Word 97 document reads in character order, across both piece encodings", () => {
  // The Korean line is a UTF-16 piece and the ASCII lines are one-byte
  // pieces, and they are not stored in that order in the stream.
  const { text, parsedAs } = extractLegacyOfficeText(fixture("sample.doc"), "doc");
  assert.equal(parsedAs, "doc");
  assert.equal(
    text,
    "Tomverse legacy fixture\n안녕하세요 세계\nThird line with digits 12345."
  );
});

test("an Excel 97 workbook reads every value encoding it uses", () => {
  const { text } = extractLegacyOfficeText(fixture("sample.xls"), "xls");
  assert.equal(
    text,
    [
      "[Sheet: Quarter]",
      "Region\t매출\tShare",
      "Seoul\t1234.5\t0.65",
      "Busan\t678\t0.35",
      // A cached SUM result, read rather than recomputed.
      "Total\t1912.5\tall regions",
      "",
      "[Sheet: Notes]",
      "Second sheet",
    ].join("\n")
  );
});

test("a PowerPoint 97 deck reads its slides and its speaker notes, once each", () => {
  const { text } = extractLegacyOfficeText(fixture("sample.ppt"), "ppt");
  assert.equal(
    text,
    [
      "Quarterly review",
      "매출이 전분기 대비 12% 늘었습니다",
      "Next steps",
      "Speaker note: mention the Busan pilot.",
    ].join("\n")
  );
  // The outline copy in SlideListWithText would repeat every line.
  assert.equal(text.split("Quarterly review").length - 1, 1);
  // And the master's placeholders are not the deck's words.
  assert.equal(text.includes("Click to edit"), false);
  assert.equal(text.includes("Outline Level"), false);
});

test("an RTF document reads its text and none of its markup", () => {
  const { text, parsedAs } = extractLegacyOfficeText(fixture("sample.rtf"), "rtf");
  assert.equal(parsedAs, "rtf");
  assert.equal(
    text,
    "Tomverse legacy fixture\n안녕하세요 세계\nThird line with digits 12345."
  );
  // The font table and style sheet are most of the file by weight.
  for (const leak of ["Liberation", "Times New Roman", "Body Text", "Caption"]) {
    assert.equal(text.includes(leak), false, leak);
  }
});

test("every fixture parses well inside the budget", () => {
  for (const [name, id] of [
    ["sample.doc", "doc"],
    ["sample.xls", "xls"],
    ["sample.ppt", "ppt"],
    ["sample.rtf", "rtf"],
  ]) {
    const started = Date.now();
    extractLegacyOfficeText(fixture(name), id);
    assert.ok(Date.now() - started < 2_000, `${name} took too long`);
  }
});

// -- Which parser runs -------------------------------------------------------

test("a .doc that is really RTF is read as RTF, because Word writes them", () => {
  const rtf = fixture("sample.rtf");
  const { text, parsedAs } = extractLegacyOfficeText(rtf, "doc");
  assert.equal(parsedAs, "rtf");
  assert.ok(text.startsWith("Tomverse legacy fixture"));
});

test("a modern Office file renamed to a legacy extension is refused", () => {
  // A .docx is a ZIP. There is a right parser for it and it is not this one.
  const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  for (const id of ["doc", "xls", "ppt"]) {
    refuses(() => extractLegacyOfficeText(zip, id), "LEGACY_OFFICE_CORRUPT");
  }
});

test("a spreadsheet or a deck that is really RTF is a mislabelled file", () => {
  const rtf = fixture("sample.rtf");
  refuses(() => extractLegacyOfficeText(rtf, "xls"), "LEGACY_OFFICE_CORRUPT");
  refuses(() => extractLegacyOfficeText(rtf, "ppt"), "LEGACY_OFFICE_CORRUPT");
});

test("something that is not a compound file at all is refused", () => {
  const text = utf8("just some words in a file named .doc");
  for (const id of ["doc", "xls", "ppt", "rtf"]) {
    refuses(() => extractLegacyOfficeText(text, id), "LEGACY_OFFICE_CORRUPT");
  }
});

test("a truncated document is refused rather than half-read", () => {
  const whole = fixture("sample.doc");
  for (const cut of [64, 600, 2_048, whole.length - 512]) {
    refuses(
      () => extractLegacyOfficeText(whole.subarray(0, cut), "doc"),
      "LEGACY_OFFICE_CORRUPT"
    );
  }
});

// -- Encryption --------------------------------------------------------------

test("a password-protected Word document is refused by name", () => {
  // Nothing here decrypts, and a partial read of ciphertext is worse than a
  // refusal the person can act on.
  const word = new Uint8Array(512);
  const view = new DataView(word.buffer);
  view.setUint16(0, 0xa5ec, true); // wIdent
  view.setUint16(2, 193, true); // nFib
  view.setUint16(10, 0x0100, true); // fEncrypted
  const container = buildCompoundFile([
    { name: "WordDocument", data: word },
    { name: "1Table", data: new Uint8Array(64) },
  ]);
  refuses(() => extractLegacyOfficeText(container, "doc"), "LEGACY_OFFICE_ENCRYPTED");
});

test("a password-protected workbook is refused before a record is interpreted", () => {
  const bof = biffRecord(0x0809, new Uint8Array(16));
  const filepass = biffRecord(0x002f, Uint8Array.from([0x01, 0x00]));
  const container = buildCompoundFile([
    { name: "Workbook", data: concatBytes([bof, filepass]) },
  ]);
  refuses(() => extractLegacyOfficeText(container, "xls"), "LEGACY_OFFICE_ENCRYPTED");
});

test("a password-protected presentation is refused from its Current User stream", () => {
  const currentUser = new Uint8Array(64);
  new DataView(currentUser.buffer).setUint32(8, 0xf3d1c4df, true);
  const container = buildCompoundFile([
    { name: "Current User", data: currentUser },
    { name: "PowerPoint Document", data: new Uint8Array(64) },
  ]);
  refuses(() => extractLegacyOfficeText(container, "ppt"), "LEGACY_OFFICE_ENCRYPTED");
});

// -- Hostile containers ------------------------------------------------------

test("a sector chain that loops is refused rather than followed", () => {
  const container = buildCompoundFile(
    [{ name: "Workbook", data: new Uint8Array(8_192) }],
    { loopFirstStreamChain: true }
  );
  // Opening the container only reads the directory; the damaged chain is
  // followed when the stream it belongs to is read, which is where a real
  // parser would meet it.
  refuses(() => {
    const budget = createLegacyParseBudget();
    readCompoundStream(openCompoundFile(container, budget), "Workbook");
  }, "LEGACY_OFFICE_CORRUPT");
});

test("a chain that points past the end of the file is refused", () => {
  const container = buildCompoundFile(
    [{ name: "Workbook", data: new Uint8Array(8_192) }],
    { streamPastEnd: true }
  );
  refuses(() => {
    const budget = createLegacyParseBudget();
    readCompoundStream(openCompoundFile(container, budget), "Workbook");
  }, "LEGACY_OFFICE_CORRUPT");
});

test("a header this reader does not understand is refused, not guessed at", () => {
  refuses(
    () =>
      openCompoundFile(
        buildCompoundFile([{ name: "a", data: utf8("x") }], { badSignature: true }),
        createLegacyParseBudget()
      ),
    "LEGACY_OFFICE_CORRUPT"
  );
  refuses(
    () =>
      openCompoundFile(
        buildCompoundFile([{ name: "a", data: utf8("x") }], { sectorShift: 10 }),
        createLegacyParseBudget()
      ),
    "LEGACY_OFFICE_CORRUPT"
  );
});

test("the byte budget refuses a container that wants more than the request has", () => {
  refuses(
    () =>
      extractLegacyOfficeText(fixture("sample.doc"), "doc", { maxBytes: 128 }),
    "LEGACY_OFFICE_TOO_LARGE"
  );
});

test("the character ceiling bounds the extracted text", () => {
  refuses(
    () => extractLegacyOfficeText(fixture("sample.xls"), "xls", { maxCharacters: 8 }),
    "LEGACY_OFFICE_TOO_LARGE"
  );
});

test("the deadline is enforced without waiting for it", () => {
  // The clock is injected, so a test can prove the guard fires rather than
  // asserting that a parse happened to be fast.
  let now = 0;
  const budget = createLegacyParseBudget({ timeoutMs: 10 }, () => now);
  for (let index = 0; index < 1_024; index += 1) budget.tick();
  now = 5_000;
  refuses(() => {
    for (let index = 0; index < 1_024; index += 1) budget.tick();
  }, "LEGACY_OFFICE_TIMEOUT");
});

// -- Excel record shapes a document generator will not produce ---------------

test("a shared string split across a CONTINUE boundary is rejoined", () => {
  // The trap this parser exists to avoid: the second half of the string is
  // stored differently from the first, and the flag saying so is the first
  // byte of the continuation.
  const sstHeader = new Uint8Array(8);
  new DataView(sstHeader.buffer).setUint32(0, 1, true);
  new DataView(sstHeader.buffer).setUint32(4, 1, true);
  const sst = biffRecord(
    0x00fc,
    concatBytes([
      sstHeader,
      Uint8Array.from([10, 0]), // cch = 10
      Uint8Array.from([0x00]), // one byte per character
      utf8("ABCD"),
    ])
  );
  const cont = biffRecord(
    0x003c,
    concatBytes([Uint8Array.from([0x01]), utf16("EFGHIJ")])
  );

  const boundSheet = biffRecord(
    0x0085,
    concatBytes([
      new Uint8Array(4),
      Uint8Array.from([0x00, 0x00, 5, 0x00]),
      utf8("Sales"),
    ])
  );
  const worksheetBof = biffRecord(
    0x0809,
    concatBytes([Uint8Array.from([0x00, 0x06, 0x10, 0x00]), new Uint8Array(12)])
  );
  const labelSst = biffRecord(0x00fd, new Uint8Array(10));
  const workbook = concatBytes([
    biffRecord(0x0809, concatBytes([Uint8Array.from([0x00, 0x06, 0x05, 0x00]), new Uint8Array(12)])),
    boundSheet,
    sst,
    cont,
    biffRecord(0x000a),
    worksheetBof,
    labelSst,
    biffRecord(0x000a),
  ]);

  const { text } = extractLegacyOfficeText(
    buildCompoundFile([{ name: "Workbook", data: workbook }]),
    "xls"
  );
  assert.equal(text, "[Sheet: Sales]\nABCDEFGHIJ");
});

test("a formula's cached string result comes from the record that follows it", () => {
  const formula = biffRecord(
    0x0006,
    concatBytes([
      Uint8Array.from([0, 0, 0, 0, 0, 0]), // row 0, column 0, xf
      Uint8Array.from([0x00, 0, 0, 0, 0, 0, 0xff, 0xff]), // string result
      new Uint8Array(8),
    ])
  );
  const string = biffRecord(
    0x0207,
    concatBytes([Uint8Array.from([2, 0, 0x00]), utf8("hi")])
  );
  const errorCell = biffRecord(
    0x0006,
    concatBytes([
      Uint8Array.from([1, 0, 0, 0, 0, 0]),
      Uint8Array.from([0x02, 0, 0x17, 0, 0, 0, 0xff, 0xff]), // #REF!
      new Uint8Array(8),
    ])
  );
  const workbook = concatBytes([
    biffRecord(0x0809, concatBytes([Uint8Array.from([0x00, 0x06, 0x05, 0x00]), new Uint8Array(12)])),
    biffRecord(0x000a),
    biffRecord(0x0809, concatBytes([Uint8Array.from([0x00, 0x06, 0x10, 0x00]), new Uint8Array(12)])),
    formula,
    string,
    errorCell,
    biffRecord(0x000a),
  ]);

  const { text } = extractLegacyOfficeText(
    buildCompoundFile([{ name: "Workbook", data: workbook }]),
    "xls"
  );
  // An error is shown the way the spreadsheet shows it, not dropped.
  assert.equal(text, "[Sheet: Sheet1]\nhi\n#REF!");
});

// -- RTF, which is where most of the ways to hide text live ------------------

const rtf = (body) =>
  extractRtfText(utf8(`{\\rtf1\\ansi\\ansicpg1252 ${body}}`), createLegacyParseBudget());

test("RTF destinations that are metadata are skipped whole, nesting included", () => {
  assert.equal(
    rtf("{\\fonttbl{\\f0 Arial;}{\\f1 Times;}}Hello"),
    "Hello"
  );
  assert.equal(rtf("{\\*\\generator Word;}Hello"), "Hello");
  assert.equal(rtf("{\\info{\\author Someone}}Hello"), "Hello");
  assert.equal(rtf("{\\stylesheet{\\s0 Normal;}{\\s1 Heading;}}Hello"), "Hello");
});

test("an embedded picture or object is never decoded", () => {
  assert.equal(rtf("{\\pict\\pngblip 89504e470d0a1a0a}After"), "After");
  assert.equal(rtf("{\\object\\objemb{\\*\\objdata 0102030405}}After"), "After");
  // A binary payload is skipped by its declared length, so its bytes cannot
  // be read back as markup.
  assert.equal(
    extractRtfText(
      concatBytes([utf8("{\\rtf1\\ansi{\\*\\bin4"), utf8("}}{}"), utf8("Tail}")]),
      createLegacyParseBudget()
    ),
    "Tail"
  );
});

test("a field keeps its result and drops its instruction", () => {
  assert.equal(
    rtf("{\\field{\\*\\fldinst HYPERLINK \"http://example.com\"}{\\fldrslt click here}}"),
    "click here"
  );
});

test("every way RTF spells a non-ASCII character is decoded", () => {
  assert.equal(rtf("caf\\'e9"), "café");
  assert.equal(rtf("\\u54620?\\u44397?"), "한국");
  // A negative parameter is the signed spelling of a high code point.
  assert.equal(rtf("\\u-10179?"), String.fromCharCode(55357));
  assert.equal(rtf("a\\emdash b"), "a—b");
  assert.equal(rtf("\\ldblquote x\\rdblquote"), "“x”");
});

test("the unicode fallback that follows \\u is swallowed, once per \\uc", () => {
  assert.equal(rtf("\\uc1\\u54620?tail"), "한tail");
  assert.equal(rtf("\\uc3\\u54620???tail"), "한tail");
  assert.equal(rtf("\\uc0\\u54620 tail"), "한tail");
});

test("escaped braces and backslashes are text, not structure", () => {
  assert.equal(rtf("a\\{b\\}c\\\\d"), "a{b}c\\d");
});

test("paragraph and tab control words become the characters they stand for", () => {
  assert.equal(rtf("one\\par two\\line three\\tab four"), "one\ntwo\nthree\tfour");
});

test("a code page other than 1252 is honoured", () => {
  const euckr = extractRtfText(
    utf8("{\\rtf1\\ansi\\ansicpg949 \\'c7\\'d1\\'b1\\'b9}"),
    createLegacyParseBudget()
  );
  assert.equal(euckr, "한국");
});

test("an RTF with no text at all is a refusal, not an empty document", () => {
  refuses(
    () =>
      extractLegacyOfficeText(
        utf8("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}}"),
        "rtf"
      ),
    "LEGACY_OFFICE_NO_TEXT"
  );
});

test("something that is not RTF is refused before the tokeniser runs", () => {
  refuses(
    () => extractLegacyOfficeText(utf8("<html><body>hi</body></html>"), "rtf"),
    "LEGACY_OFFICE_CORRUPT"
  );
});

test("nothing in an RTF is executed, however it is spelled", () => {
  // The tokeniser returns characters. There is no evaluation step for a
  // control word to reach, and an unknown one is formatting that is dropped.
  const payload = rtf(
    "{\\*\\shpinst}\\field Safe {\\*\\fldinst {\\*\\objdata 4d5a}}text"
  );
  assert.equal(payload.includes("objdata"), false);
  assert.equal(payload.includes("4d5a"), false);
  assert.ok(payload.includes("Safe"));
});
