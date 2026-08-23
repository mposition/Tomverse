/**
 * The XML and packaging primitives every OOXML writer here shares.
 *
 * Policy: docs/policy/generated-artifacts.md section 6.
 *
 * Three writers produce OOXML packages -- xlsx, docx and pptx -- and all three
 * face the same two problems: caller text must never become markup, and the
 * zip must be byte-identical for identical input. Solving either of those
 * three times is how two of the three end up subtly different.
 */

import { zipSync, type Zippable } from "fflate";

export const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/**
 * A fixed timestamp for every zip entry.
 *
 * Byte-identical output for identical input is what makes the idempotency key
 * in lib/generatedArtifactTool.ts meaningful: the same specification
 * generated twice must be recognisably the same file, and a wall-clock mtime
 * would make every regeneration a new one. 2020-01-01 rather than the epoch
 * because DOS timestamps cannot represent anything before 1980.
 */
export const FIXED_ENTRY_TIME = Date.UTC(2020, 0, 1);

/**
 * XML text escaping, plus removal of the code points XML 1.0 cannot carry.
 *
 * The strip is not cosmetic. A lone control character inside a text element
 * produces a package Word or Excel refuses to open, and the caller of these
 * writers is a language model -- the one caller most likely to hand over a
 * stray U+0001 lifted out of a user's pasted data.
 */
export const escapeXml = (value: string): string =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** The same strip, without the escaping, for text that is not going into XML. */
export const stripUnwritableCharacters = (value: string): string =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");

const encoder = new TextEncoder();

export type OoxmlPart = { path: string; xml: string };

/** Zips a set of XML parts into a deterministic OOXML package. */
export const zipOoxmlPackage = (parts: readonly OoxmlPart[]): Uint8Array => {
  const files: Zippable = {};
  for (const part of parts) files[part.path] = encoder.encode(part.xml);
  return zipSync(files, { level: 6, mtime: FIXED_ENTRY_TIME });
};

/** The relationship element every OOXML package is stitched together with. */
export const relationship = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"/>`;

export const RELATIONSHIPS_OPEN =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';

/**
 * `docProps/core.xml`, identical for every package this application writes.
 *
 * Fixed metadata, so the package carries no clock and no identity. The creator
 * names the product rather than the model: the file is this application's
 * output, produced from a specification, and attributing it to a provider
 * would be a claim about authorship nobody checked.
 */
export const CORE_PROPERTIES_PART: OoxmlPart = {
  path: "docProps/core.xml",
  xml:
    `${XML_DECLARATION}` +
    `<cp:coreProperties ` +
    `xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:creator>Tomverse Review</dc:creator>` +
    `<cp:lastModifiedBy>Tomverse Review</cp:lastModifiedBy>` +
    `</cp:coreProperties>`,
};

export const CORE_PROPERTIES_OVERRIDE =
  `<Override PartName="/docProps/core.xml" ` +
  `ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`;

export const CORE_PROPERTIES_RELATIONSHIP = relationship(
  // `rId2`, not a name: the package root already carries `rId1` for the main
  // document, and `Id` is an xsd:ID so a word like `rIdCore` is legal -- but
  // nothing else in the ecosystem writes one, so nothing else is tested
  // against one.
  "rId2",
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  "docProps/core.xml",
);
