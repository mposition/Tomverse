/**
 * Hangul Word Processor (HWP 5.x) and HWPX: the text a model can read.
 *
 * Policy: docs/policy/chat-attachment-formats.md section 4.6.
 *
 * HWP is the document format most Korean institutions write in, and a
 * product for Korean users that cannot read one cannot answer "summarise this
 * notice". So, like the Office 97-2003 readers beside it, this reads the text
 * itself -- no renderer, no network -- and the same budget bounds it.
 *
 * Two containers, one result:
 *
 *   * HWP 5.x is a compound file. `FileHeader` says whether the body is
 *     compressed (raw DEFLATE), password-protected or a "distribution"
 *     document (its body is encrypted for viewing only); the text lives in
 *     `BodyText/Section0..N` as a stream of tagged records, and each
 *     PARA_TEXT record is one paragraph of UTF-16LE with inline control
 *     characters.
 *   * HWPX (OWPML) is a ZIP of XML: `Contents/section0.xml` and on, the text
 *     in `<hp:t>` runs inside `<hp:p>` paragraphs.
 *
 * What is read is text only. Tables come through as their cells' paragraphs
 * in order; pictures, fields and layout are not text and are left out.
 * HWP 3.x (Hangul 97), which predates both containers, is refused.
 */

import { inflateRawBounded, visitZipEntries } from "@/lib/boundedInflate";
import { LegacyOfficeError, type LegacyParseBudget } from "@/lib/legacyOffice/budget";
import { openCompoundFile, readCompoundStream } from "@/lib/legacyOffice/cfbf";

/* ------------------------------------------------------------------------ */
/* HWP 5.x                                                                    */
/* ------------------------------------------------------------------------ */

const HWP_SIGNATURE = "HWP Document File";

/** FileHeader property bits (HWP 5.0 spec, table 3). */
const FLAG_COMPRESSED = 1 << 0;
const FLAG_PASSWORD = 1 << 1;
const FLAG_DISTRIBUTION = 1 << 2;
const FLAG_DRM = 1 << 4;

/** HWPTAG_BEGIN (0x10) + 51: the record that holds a paragraph's text. */
const HWPTAG_PARA_TEXT = 0x10 + 51;

/** The most sections a document is read for; real ones have a handful. */
const MAX_SECTIONS = 512;

/**
 * Inflates raw DEFLATE against the byte budget, a few kilobytes of input at a
 * time (lib/boundedInflate.ts), so a section that expands without end is
 * refused part-way -- after at most one step's output, never after the whole
 * of it was allocated.
 */
const inflateBounded = (data: Uint8Array, budget: LegacyParseBudget): Uint8Array => {
  try {
    return inflateRawBounded(data, (chunk) => {
      budget.tick();
      budget.claimBytes(chunk.length);
    });
  } catch (error) {
    if (error instanceof LegacyOfficeError) throw error;
    throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
  }
};

/**
 * Control characters below U+0020, by how many UTF-16 units they occupy.
 * "Char" controls are one unit; "inline" and "extended" ones are eight (the
 * code, six units of data, the code again). Getting the width wrong reads
 * the data units as text, so the table is the spec's, not a guess.
 */
const EIGHT_UNIT_CONTROLS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

/** One PARA_TEXT record's text. */
const paragraphText = (data: Uint8Array, offset: number, size: number): string => {
  const view = new DataView(data.buffer, data.byteOffset + offset, size);
  const units: number[] = [];
  for (let index = 0; index + 1 < size; ) {
    const unit = view.getUint16(index, true);
    if (unit >= 0x20) {
      units.push(unit);
      index += 2;
      continue;
    }
    if (unit === 9) units.push(0x09); // tab (an inline control)
    else if (unit === 10) units.push(0x0a); // line break
    else if (unit === 24) units.push(0x2d); // hyphen
    else if (unit === 30 || unit === 31) units.push(0x20); // non-breaking / fixed-width space
    index += EIGHT_UNIT_CONTROLS.has(unit) ? 16 : 2;
  }
  let text = "";
  for (let start = 0; start < units.length; start += 8192) {
    text += String.fromCharCode(...units.slice(start, start + 8192));
  }
  return text;
};

/** Every paragraph in one section stream, in order. */
const sectionParagraphs = (data: Uint8Array, budget: LegacyParseBudget): string[] => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const paragraphs: string[] = [];
  let offset = 0;
  while (offset + 4 <= data.byteLength) {
    budget.tick();
    const header = view.getUint32(offset, true);
    offset += 4;
    const tag = header & 0x3ff;
    let size = header >>> 20;
    if (size === 0xfff) {
      if (offset + 4 > data.byteLength) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
      size = view.getUint32(offset, true);
      offset += 4;
    }
    if (offset + size > data.byteLength) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    if (tag === HWPTAG_PARA_TEXT) {
      const text = paragraphText(data, offset, size);
      budget.claimCharacters(text.length + 1);
      paragraphs.push(text);
    }
    offset += size;
  }
  return paragraphs;
};

export function extractHwpText(bytes: Uint8Array, budget: LegacyParseBudget): string {
  const file = openCompoundFile(bytes, budget);
  const header = readCompoundStream(file, "FileHeader");
  if (!header || header.byteLength < 40) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
  const signature = String.fromCharCode(...header.subarray(0, HWP_SIGNATURE.length));
  if (signature !== HWP_SIGNATURE) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");

  const properties = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(36, true);
  // A password, a distribution copy and DRM all mean the body is encrypted:
  // nothing here decrypts, and a garbled read is worse than a refusal.
  if (properties & (FLAG_PASSWORD | FLAG_DISTRIBUTION | FLAG_DRM)) {
    throw new LegacyOfficeError("LEGACY_OFFICE_ENCRYPTED");
  }
  const compressed = (properties & FLAG_COMPRESSED) !== 0;

  const paragraphs: string[] = [];
  for (let index = 0; index < MAX_SECTIONS; index += 1) {
    const stream = readCompoundStream(file, `Section${index}`);
    if (!stream) break;
    const data = compressed ? inflateBounded(stream, budget) : stream;
    paragraphs.push(...sectionParagraphs(data, budget));
  }
  return paragraphs.join("\n");
}

/* ------------------------------------------------------------------------ */
/* HWPX                                                                       */
/* ------------------------------------------------------------------------ */

const decodeXmlText = (value: string) =>
  value
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/g, "&");

/** The section parts, in their reading order. */
const SECTION_PART = /^Contents\/section(\d+)\.xml$/i;

export function extractHwpxText(bytes: Uint8Array, budget: LegacyParseBudget): string {
  const pieces = new Map<string, Uint8Array[]>();
  let entries = 0;
  try {
    // Only section parts are inflated, and each piece of output is charged
    // to the budget as it is produced: the sizes a ZIP declares are its own
    // claims, and a section that says 1 KB may not be.
    visitZipEntries(bytes, {
      entry: () => {
        budget.tick();
        entries += 1;
        if (entries > 10_000) throw new LegacyOfficeError("LEGACY_OFFICE_TOO_LARGE");
      },
      accept: (name) => SECTION_PART.test(name),
      data: (name, chunk) => {
        budget.tick();
        budget.claimBytes(chunk.length);
        const list = pieces.get(name) ?? [];
        list.push(chunk);
        pieces.set(name, list);
      },
    });
  } catch (error) {
    if (error instanceof LegacyOfficeError) throw error;
    throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
  }
  const wanted = [...pieces.keys()];
  if (wanted.length === 0) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
  const parts: Record<string, Uint8Array> = {};
  for (const [name, list] of pieces) {
    const joined = new Uint8Array(list.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of list) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    parts[name] = joined;
  }

  const order = (name: string) => Number(SECTION_PART.exec(name)?.[1] ?? 0);
  const decoder = new TextDecoder("utf-8");
  const paragraphs: string[] = [];
  for (const name of wanted.sort((a, b) => order(a) - order(b))) {
    const xml = decoder.decode(parts[name]);
    // Runs of text and the end of each paragraph, in document order. Nested
    // paragraphs (table cells) close on their own, so each cell is its own
    // line -- the reading order a person would give it.
    let current = "";
    // A paragraph that only held a table closes right after its last cell
    // did, with nothing of its own; that close is not a blank line.
    let lastWasClose = false;
    for (const match of xml.matchAll(
      /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<\/(?:\w+:)?p>|<(?:\w+:)?(tab|lineBreak)\b[^>]*\/>/g
    )) {
      budget.tick();
      if (match[1] !== undefined) {
        current += decodeXmlText(
          match[1]
            .replace(/<(?:\w+:)?tab\b[^>]*\/>/g, "\t")
            .replace(/<(?:\w+:)?lineBreak\b[^>]*\/>/g, "\n")
        );
        lastWasClose = false;
      } else if (match[2] === "tab") {
        current += "\t";
        lastWasClose = false;
      } else if (match[2] === "lineBreak") {
        current += "\n";
        lastWasClose = false;
      } else {
        if (!(lastWasClose && current === "")) {
          budget.claimCharacters(current.length + 1);
          paragraphs.push(current);
        }
        current = "";
        lastWasClose = true;
      }
    }
    // A section that ends without closing its last paragraph still has its
    // text charged: the ceiling holds whatever the markup does.
    if (current) {
      budget.claimCharacters(current.length + 1);
      paragraphs.push(current);
    }
  }
  return paragraphs.join("\n");
}
