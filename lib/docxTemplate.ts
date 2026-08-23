/**
 * Filling a user's own .docx template, without ever becoming a macro host.
 *
 * Policy: docs/policy/generated-artifacts.md section 13.
 *
 * The other generators in this domain build a package from parts they write
 * themselves, and their safety argument is that there is nothing to inject
 * into. This one is the opposite: the package already exists, the user
 * uploaded it, and the whole point is to keep it -- its styles, its theme, its
 * tables, its headers and footers, its section setup, its images and its page
 * layout. Copying the parts is what preserves them; rewriting the document
 * from extracted text is what loses them, and losing them is the defect this
 * module exists to fix.
 *
 * So the safety argument has to be made a different way, in two halves:
 *
 *   * **Refuse, do not sanitise.** A template carrying a macro, an OLE object,
 *     an external relationship, an `altChunk` or a field code that fetches
 *     something is refused whole. Stripping the offending part would deliver a
 *     document that is not the one the user uploaded, under a name that says
 *     it is.
 *   * **Touch only text.** The only bytes this module changes are the
 *     characters inside `<w:t>` elements. No part is added, no relationship is
 *     created, no content type is declared. A template that was safe when it
 *     arrived is the same package afterwards with different words in it.
 *
 * ## Why placeholders are not a simple string replace
 *
 * Word splits a run whenever anything about it changes -- and "anything"
 * includes a spell-check boundary, a language tag, or the user having typed
 * the braces at a different moment from the word between them. So a
 * placeholder routinely reaches the file as
 *
 *     <w:r><w:t>{{</w:t></w:r><w:r><w:t>name</w:t></w:r><w:r><w:t>}}</w:t></w:r>
 *
 * and a replace over the raw XML finds nothing. The substitution below works
 * on the *paragraph*: it concatenates the paragraph's text runs, finds the
 * placeholders in that concatenation, and writes the result back across the
 * same runs -- so the first run of a placeholder receives the value and the
 * rest lose the characters they contributed. The formatting of the first run
 * is what the value inherits, which is the same thing Word does when you type
 * over a selection.
 */

import { unzipSync, zipSync, type Unzipped } from "fflate";

/** Fixed so two runs over the same inputs produce byte-identical packages. */
const FIXED_ENTRY_TIME = Date.UTC(2020, 0, 1);

export const DOCX_TEMPLATE_ERROR_CODES = [
  "TEMPLATE_UNREADABLE",
  "TEMPLATE_NOT_DOCX",
  "TEMPLATE_TOO_LARGE",
  "TEMPLATE_UNSAFE_ENTRY",
  "TEMPLATE_MACRO_REFUSED",
  "TEMPLATE_OLE_REFUSED",
  "TEMPLATE_EXTERNAL_REFERENCE_REFUSED",
  "TEMPLATE_ALT_CHUNK_REFUSED",
  "TEMPLATE_FIELD_CODE_REFUSED",
  "PLACEHOLDER_MISSING",
  "PLACEHOLDER_UNRESOLVED",
  "PLACEHOLDER_VALUE_TOO_LONG",
] as const;

export type DocxTemplateErrorCode = (typeof DOCX_TEMPLATE_ERROR_CODES)[number];

export class DocxTemplateError extends Error {
  constructor(
    readonly code: DocxTemplateErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DocxTemplateError";
  }
}

/* ------------------------------------------------------------------------ */
/* Limits                                                                     */
/* ------------------------------------------------------------------------ */

export const DOCX_TEMPLATE_LIMITS = {
  /** Parts in the uploaded package. A real template is well under this. */
  maxEntries: 400,
  /** Uncompressed bytes across the whole package. */
  maxUncompressedBytes: 24 * 1024 * 1024,
  /** Characters one substituted value may contribute. */
  maxValueLength: 4_000,
  /** Distinct placeholders one template may declare. */
  maxPlaceholders: 200,
} as const;

/* ------------------------------------------------------------------------ */
/* Package safety                                                             */
/* ------------------------------------------------------------------------ */

/** Parts whose presence means the package is something other than a document. */
const REFUSED_ENTRY_PATTERNS: Array<{
  pattern: RegExp;
  code: DocxTemplateErrorCode;
  what: string;
}> = [
  {
    pattern: /(^|\/)vbaProject\.bin$/i,
    code: "TEMPLATE_MACRO_REFUSED",
    what: "a macro project",
  },
  {
    pattern: /(^|\/)vbaData\.xml$/i,
    code: "TEMPLATE_MACRO_REFUSED",
    what: "macro data",
  },
  {
    pattern: /(^|\/)activeX[^/]*\//i,
    code: "TEMPLATE_OLE_REFUSED",
    what: "an ActiveX control",
  },
  {
    pattern: /(^|\/)embeddings\//i,
    code: "TEMPLATE_OLE_REFUSED",
    what: "an embedded object",
  },
  {
    pattern: /oleObject\d*\.bin$/i,
    code: "TEMPLATE_OLE_REFUSED",
    what: "an OLE object",
  },
];

/** Relationship types that reach outside the package, whatever their target. */
const REFUSED_RELATIONSHIP_TYPES = [
  "/oleObject",
  "/package",
  "/attachedTemplate",
  "/frame",
  "/subDocument",
  "/externalLink",
  "/aFChunk",
];

/** Field instructions that make opening the document fetch or run something. */
const REFUSED_FIELD_INSTRUCTIONS =
  /\b(DDE|DDEAUTO|INCLUDETEXT|INCLUDEPICTURE|LINK|RD|IMPORT|HTMLCONTROL)\b/i;

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

const isXmlPart = (name: string) =>
  name.endsWith(".xml") || name.endsWith(".rels");

/**
 * The archive-level checks, made against the entry names fflate produced.
 *
 * `assertSafeOfficeArchive` already walked the central directory of the
 * uploaded bytes and refused traversal, ZIP64, encryption and expansion bombs.
 * This is the second pass, over what actually parsed, because the two views of
 * a zip can disagree -- and a disagreement between them is itself a reason to
 * refuse.
 */
const assertSafeEntries = (parts: Unzipped) => {
  const names = Object.keys(parts);
  if (names.length === 0 || names.length > DOCX_TEMPLATE_LIMITS.maxEntries) {
    throw new DocxTemplateError(
      "TEMPLATE_UNSAFE_ENTRY",
      "The template archive has an unsupported number of entries."
    );
  }

  let totalBytes = 0;
  for (const name of names) {
    const normalized = name.replaceAll("\\", "/");
    if (
      !name ||
      name !== normalized ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.includes("\u0000") ||
      normalized
        .split("/")
        .some((segment) => segment === ".." || segment === "")
    ) {
      throw new DocxTemplateError(
        "TEMPLATE_UNSAFE_ENTRY",
        `The template archive contains an unsafe entry path: "${name.slice(0, 80)}".`
      );
    }
    for (const refused of REFUSED_ENTRY_PATTERNS) {
      if (refused.pattern.test(normalized)) {
        throw new DocxTemplateError(
          refused.code,
          `The template contains ${refused.what} (${normalized}). Remove it and upload the template again.`
        );
      }
    }
    totalBytes += parts[name].byteLength;
    if (totalBytes > DOCX_TEMPLATE_LIMITS.maxUncompressedBytes) {
      throw new DocxTemplateError(
        "TEMPLATE_TOO_LARGE",
        "The template expands beyond the supported size."
      );
    }
  }

  if (!parts["[Content_Types].xml"]) {
    throw new DocxTemplateError(
      "TEMPLATE_NOT_DOCX",
      "The template is missing its OOXML content type manifest."
    );
  }
  if (!parts["word/document.xml"]) {
    throw new DocxTemplateError(
      "TEMPLATE_NOT_DOCX",
      "The template is not a Word document package."
    );
  }
};

const assertSafeContent = (parts: Unzipped) => {
  const contentTypes = decoder.decode(parts["[Content_Types].xml"]);
  if (/macroEnabled|vbaProject/i.test(contentTypes)) {
    throw new DocxTemplateError(
      "TEMPLATE_MACRO_REFUSED",
      "The template declares macro-enabled content. Save it as .docx and upload it again."
    );
  }

  for (const [name, bytes] of Object.entries(parts)) {
    if (!isXmlPart(name)) continue;
    const xml = decoder.decode(bytes);

    if (name.endsWith(".rels")) {
      if (/TargetMode\s*=\s*"External"/i.test(xml)) {
        throw new DocxTemplateError(
          "TEMPLATE_EXTERNAL_REFERENCE_REFUSED",
          `The template references content outside the file (${name}). Embed it, or remove the link.`
        );
      }
      for (const refusedType of REFUSED_RELATIONSHIP_TYPES) {
        if (xml.includes(`${refusedType}"`)) {
          throw new DocxTemplateError(
            "TEMPLATE_OLE_REFUSED",
            `The template contains an unsupported relationship type (${refusedType.slice(1)}).`
          );
        }
      }
      continue;
    }

    if (/<w:altChunk\b/i.test(xml)) {
      throw new DocxTemplateError(
        "TEMPLATE_ALT_CHUNK_REFUSED",
        "The template embeds another document through altChunk, which is not supported."
      );
    }
    if (
      /<w:object\b/i.test(xml) ||
      /<o:OLEObject\b/i.test(xml) ||
      /<w:control\b/i.test(xml)
    ) {
      throw new DocxTemplateError(
        "TEMPLATE_OLE_REFUSED",
        "The template contains an embedded or linked object, which is not supported."
      );
    }
    for (const instruction of xml.matchAll(
      /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/gi
    )) {
      if (REFUSED_FIELD_INSTRUCTIONS.test(instruction[1])) {
        throw new DocxTemplateError(
          "TEMPLATE_FIELD_CODE_REFUSED",
          "The template contains a field code that loads external content, which is not supported."
        );
      }
    }
  }
};

/* ------------------------------------------------------------------------ */
/* XML text helpers                                                           */
/* ------------------------------------------------------------------------ */

const decodeXmlText = (value: string): string =>
  value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 10))
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const encodeXmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    // XML 1.0 cannot carry these at all, and one of them is enough to make a
    // package Word refuses to open -- the failure this whole domain exists to
    // avoid. Tab, newline and carriage return are kept.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

/**
 * One value, as the XML fragment that goes between `<w:t>` and `</w:t>`.
 *
 * A newline becomes a real line break rather than a literal character: Word
 * ignores whitespace inside `<w:t>` for layout, so a value with lines in it
 * would otherwise arrive as one run-on line.
 */
const valueFragment = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(encodeXmlText)
    .join('</w:t><w:br/><w:t xml:space="preserve">');

/* ------------------------------------------------------------------------ */
/* Placeholders                                                               */
/* ------------------------------------------------------------------------ */

/**
 * `{{name}}`, where the name is anything but a brace.
 *
 * Deliberately permissive about the name: the placeholders in a real Korean HR
 * template are written in Hangul, and restricting the character class to ASCII
 * identifiers would refuse the very files this feature is for.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]{1,120}?)\s*\}\}/g;

type TextSegment = {
  /** Index in the paragraph string where the inner text starts. */
  start: number;
  /** Index in the paragraph string where the inner text ends. */
  end: number;
  /** The decoded text this segment contributes. */
  text: string;
  /** Where the `<w:t ...>` open tag begins, so it can be reissued. */
  openTagStart: number;
  openTag: string;
};

const W_T_PATTERN = /<w:t(\s[^>]*?)?(\/)?>/g;

/** Every `<w:t>...</w:t>` in one paragraph, in document order. */
const readTextSegments = (paragraph: string): TextSegment[] => {
  const segments: TextSegment[] = [];
  const pattern = new RegExp(W_T_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(paragraph))) {
    // `<w:t/>` carries no text and has no closing tag to look for.
    if (match[2]) continue;
    const openTagEnd = match.index + match[0].length;
    const close = paragraph.indexOf("</w:t>", openTagEnd);
    if (close < 0) continue;
    segments.push({
      start: openTagEnd,
      end: close,
      text: decodeXmlText(paragraph.slice(openTagEnd, close)),
      openTagStart: match.index,
      openTag: match[0],
    });
    pattern.lastIndex = close + "</w:t>".length;
  }
  return segments;
};

const PARAGRAPH_PATTERN = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

type Substitution = {
  resolve(name: string): string | undefined;
};

/**
 * Rewrites one paragraph's text runs.
 *
 * The concatenated paragraph text is the unit of matching, so a placeholder
 * split across any number of runs is found; the write-back is per run, so
 * every run that is not part of a placeholder is returned byte-identical.
 */
const substituteParagraph = (
  paragraph: string,
  substitution: Substitution
): string => {
  const segments = readTextSegments(paragraph);
  if (segments.length === 0) return paragraph;

  const combined = segments.map((segment) => segment.text).join("");
  if (!combined.includes("{{")) return paragraph;

  const matches = Array.from(
    combined.matchAll(new RegExp(PLACEHOLDER_PATTERN.source, "g"))
  );
  if (matches.length === 0) return paragraph;

  // Where each segment's text begins in the concatenation.
  const offsets: number[] = [];
  let cursor = 0;
  for (const segment of segments) {
    offsets.push(cursor);
    cursor += segment.text.length;
  }

  type Replacement = { from: number; to: number; fragment: string };
  const replacements: Replacement[] = [];
  for (const match of matches) {
    const value = substitution.resolve(match[1]);
    if (value === undefined) continue;
    replacements.push({
      from: match.index ?? 0,
      to: (match.index ?? 0) + match[0].length,
      fragment: valueFragment(value),
    });
  }
  if (replacements.length === 0) return paragraph;

  // Rebuild each segment's inner XML from the characters it still owns, with
  // a replacement's whole value emitted by the segment its placeholder starts
  // in. That is what gives the value the formatting of the run the author
  // began the placeholder in.
  const rebuilt = segments.map((segment, index) => {
    const segmentStart = offsets[index];
    const segmentEnd = segmentStart + segment.text.length;
    let out = "";
    let position = segmentStart;
    let touched = false;
    for (const replacement of replacements) {
      if (replacement.to <= segmentStart || replacement.from >= segmentEnd) {
        continue;
      }
      touched = true;
      const keepUntil = Math.max(
        position,
        Math.min(replacement.from, segmentEnd)
      );
      if (keepUntil > position) {
        out += encodeXmlText(
          segment.text.slice(position - segmentStart, keepUntil - segmentStart)
        );
      }
      if (replacement.from >= segmentStart) out += replacement.fragment;
      position = Math.max(position, Math.min(replacement.to, segmentEnd));
    }
    if (!touched) return null;
    if (position < segmentEnd) {
      out += encodeXmlText(segment.text.slice(position - segmentStart));
    }
    return out;
  });

  // Applied back to front so earlier indices stay valid.
  let result = paragraph;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const replacement = rebuilt[index];
    if (replacement === null) continue;
    const segment = segments[index];
    // A substituted run keeps its own properties and gains xml:space, because
    // a value may legitimately begin or end with a space and Word would
    // collapse it otherwise.
    const openTag = segment.openTag.includes("xml:space")
      ? segment.openTag
      : segment.openTag.replace(/^<w:t/, '<w:t xml:space="preserve"');
    result =
      result.slice(0, segment.openTagStart) +
      openTag +
      replacement +
      result.slice(segment.end);
  }
  return result;
};

const substitutePart = (xml: string, substitution: Substitution): string =>
  xml.replace(new RegExp(PARAGRAPH_PATTERN.source, "g"), (paragraph) =>
    substituteParagraph(paragraph, substitution)
  );

/** The parts whose text a template fill may touch. Nothing else is opened. */
const isSubstitutablePart = (name: string) =>
  name === "word/document.xml" ||
  /^word\/(header|footer)\d*\.xml$/.test(name) ||
  name === "word/footnotes.xml" ||
  name === "word/endnotes.xml";

/* ------------------------------------------------------------------------ */
/* The template                                                               */
/* ------------------------------------------------------------------------ */

export type DocxTemplate = {
  /** Every part of the uploaded package, verbatim. */
  parts: Unzipped;
  /** The names of the parts substitution may rewrite. */
  substitutableParts: string[];
  /** Distinct placeholder names found in those parts, in document order. */
  placeholders: string[];
};

/**
 * Reads and vets an uploaded .docx.
 *
 * The caller is expected to have run `assertSafeOfficeArchive` on the same
 * bytes first: that walks the raw central directory, this walks what parsed.
 * Both are cheap and they refuse different things.
 */
export const loadDocxTemplate = (bytes: Uint8Array): DocxTemplate => {
  let parts: Unzipped;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new DocxTemplateError(
      "TEMPLATE_UNREADABLE",
      "The template could not be read as a Word document."
    );
  }

  assertSafeEntries(parts);
  assertSafeContent(parts);

  const substitutableParts = Object.keys(parts).filter(isSubstitutablePart);
  const placeholders: string[] = [];
  const seen = new Set<string>();
  for (const name of substitutableParts) {
    const xml = decoder.decode(parts[name]);
    for (const paragraph of xml.match(
      new RegExp(PARAGRAPH_PATTERN.source, "g")
    ) ?? []) {
      const combined = readTextSegments(paragraph)
        .map((segment) => segment.text)
        .join("");
      for (const match of combined.matchAll(
        new RegExp(PLACEHOLDER_PATTERN.source, "g")
      )) {
        if (seen.has(match[1])) continue;
        seen.add(match[1]);
        placeholders.push(match[1]);
        if (placeholders.length > DOCX_TEMPLATE_LIMITS.maxPlaceholders) {
          throw new DocxTemplateError(
            "TEMPLATE_TOO_LARGE",
            "The template declares more placeholders than are supported."
          );
        }
      }
    }
  }

  return { parts, substitutableParts, placeholders };
};

export type DocxRenderOptions = {
  /**
   * Names that must be supplied and non-empty.
   *
   * Separate from "every placeholder the template has", because a template
   * legitimately contains optional fields -- and refusing a whole batch
   * because one row has no middle name would be the wrong answer. What is
   * never allowed is a *silent* gap: an unsupplied placeholder is reported
   * below as unresolved.
   */
  requiredPlaceholders?: readonly string[];
};

/**
 * Fills a template and returns the finished .docx bytes.
 *
 * Refuses rather than delivering something incomplete, in both directions: a
 * required value that is missing stops the render, and a placeholder still
 * standing in the output after substitution stops it too. A contract with a
 * placeholder printed in it is worse than no contract, because it looks like a
 * document.
 */
export const renderDocxFromTemplate = (
  template: DocxTemplate,
  values: Record<string, string>,
  options: DocxRenderOptions = {}
): Uint8Array => {
  for (const [name, value] of Object.entries(values)) {
    if (value.length > DOCX_TEMPLATE_LIMITS.maxValueLength) {
      throw new DocxTemplateError(
        "PLACEHOLDER_VALUE_TOO_LONG",
        `The value for "${name}" is longer than ${DOCX_TEMPLATE_LIMITS.maxValueLength} characters.`
      );
    }
  }

  for (const required of options.requiredPlaceholders ?? []) {
    const value = values[required];
    if (value === undefined || value.trim() === "") {
      throw new DocxTemplateError(
        "PLACEHOLDER_MISSING",
        `No value was supplied for the required placeholder "${required}".`
      );
    }
  }

  const substitution: Substitution = {
    resolve: (name) => (name in values ? values[name] : undefined),
  };

  const filled: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(template.parts)) {
    if (!template.substitutableParts.includes(name)) {
      filled[name] = bytes;
      continue;
    }
    const rewritten = substitutePart(decoder.decode(bytes), substitution);
    // The check is made on the *output*, not on the input's placeholder list:
    // that is what catches a value which itself contained an opening brace
    // pair, as well as a placeholder nobody supplied.
    const leftover = rewritten.match(
      new RegExp(PLACEHOLDER_PATTERN.source, "g")
    );
    if (leftover) {
      throw new DocxTemplateError(
        "PLACEHOLDER_UNRESOLVED",
        `The generated document still contains unfilled placeholders: ${Array.from(
          new Set(leftover)
        )
          .slice(0, 5)
          .join(", ")}.`
      );
    }
    filled[name] = encoder.encode(rewritten);
  }

  return zipSync(filled, { level: 6, mtime: FIXED_ENTRY_TIME });
};

/** Exported for the tests that pin the cross-run behaviour directly. */
export const __testing = {
  substituteParagraph,
  readTextSegments,
  decodeXmlText,
  encodeXmlText,
};
