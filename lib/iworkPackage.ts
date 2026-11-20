/**
 * Apple iWork packages (Pages, Numbers): the structural check.
 *
 * Policy: docs/policy/chat-attachment-formats.md (iWork) and
 * docs/policy/generated-artifacts.md section 15.
 *
 * An iWork file is a ZIP of Apple's own records. This application does not
 * read those records -- the renderer service lays the file out instead -- so
 * the check is what keeps the package from being a weapon on its way there: a
 * bounded entry count, no path that leaves the package, the index part every
 * iWork document has, and a ceiling on what it *really* expands to.
 *
 * "Really" includes what is compressed inside: the Snappy-compressed `.iwa`
 * records LibreOffice decodes, and the `index.xml.gz` / `Index.zip` older
 * versions wrote. lib/packageExpansion.ts measures all of it against one
 * running total, inflating a step at a time, so a package that would expand
 * past the ceiling is refused part-way, before it is stored or rendered.
 */

import { BoundedInflateError } from "@/lib/boundedInflate";
import {
  ExpansionLimitError,
  createExpansionCounter,
  measurePackage,
} from "@/lib/packageExpansion";

export const IWORK_PACKAGE_LIMITS = {
  maxEntries: 5_000,
  /** Bytes the package and everything compressed inside it expand to. */
  maxExpandedBytes: 200 * 1024 * 1024,
} as const;

export type IworkRefusal = "TOO_LARGE" | "MALFORMED";

export class IworkPackageError extends Error {
  constructor(
    message: string,
    /** Too large is something the user can fix by sending less. */
    readonly refusal: IworkRefusal = "MALFORMED"
  ) {
    super(message);
    this.name = "IworkPackageError";
  }
}

/**
 * The part that makes a ZIP an iWork document: the 2013+ binary index, or the
 * XML index older versions wrote.
 */
const INDEX_PARTS = /^(?:Index\/Document\.iwa|Index\.zip|index\.xml(?:\.gz)?|index\.apxl(?:\.gz)?)$/;

export const assertSafeIworkPackage = (bytes: Uint8Array): void => {
  let entries = 0;
  let indexed = false;
  const counter = createExpansionCounter(IWORK_PACKAGE_LIMITS.maxExpandedBytes);
  try {
    measurePackage(bytes, counter, {
      entry: (name, depth) => {
        entries += 1;
        if (entries > IWORK_PACKAGE_LIMITS.maxEntries) {
          throw new IworkPackageError("Too many entries.", "TOO_LARGE");
        }
        if (
          name.startsWith("/") ||
          name.includes("\\") ||
          name.split("/").some((segment) => segment === "..")
        ) {
          throw new IworkPackageError("An entry leaves the package.");
        }
        if (depth === 0 && INDEX_PARTS.test(name)) indexed = true;
      },
    });
  } catch (error) {
    if (error instanceof IworkPackageError) throw error;
    if (error instanceof ExpansionLimitError) {
      throw new IworkPackageError("Expands too far.", "TOO_LARGE");
    }
    if (error instanceof BoundedInflateError) {
      throw new IworkPackageError("Not a readable ZIP package.");
    }
    throw error;
  }
  if (!indexed) throw new IworkPackageError("Not an iWork document.");
};
