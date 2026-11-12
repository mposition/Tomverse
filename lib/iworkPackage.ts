/**
 * Apple iWork packages (Pages, Numbers): the structural check.
 *
 * Policy: docs/policy/chat-attachment-formats.md (iWork) and
 * docs/policy/generated-artifacts.md section 15.
 *
 * An iWork file is a ZIP of Apple's own binary records. This application does
 * not read those records -- nothing here could, and the renderer service lays
 * the file out instead -- so the check is what keeps a ZIP from being a weapon
 * on its way there: a bounded entry count, no path that leaves the package,
 * the index part every iWork document has, and a ceiling on what it really
 * expands to.
 *
 * "Really" is the point. A ZIP's sizes are the file's own claims, so every
 * entry is inflated here a few kilobytes of input at a time
 * (lib/boundedInflate.ts) and the output -- counted, then dropped -- is what
 * is measured. A package that expands past the ceiling is refused part-way,
 * before it is stored or handed to the renderer.
 */

import { BoundedInflateError, visitZipEntries } from "@/lib/boundedInflate";

export const IWORK_PACKAGE_LIMITS = {
  maxEntries: 5_000,
  /** Bytes every entry together actually inflates to. */
  maxExpandedBytes: 200 * 1024 * 1024,
} as const;

export class IworkPackageError extends Error {
  constructor(message: string) {
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
  let expanded = 0;
  let indexed = false;
  try {
    visitZipEntries(bytes, {
      entry: (name) => {
        entries += 1;
        if (entries > IWORK_PACKAGE_LIMITS.maxEntries) {
          throw new IworkPackageError("Too many entries.");
        }
        if (
          name.startsWith("/") ||
          name.includes("\\") ||
          name.split("/").some((segment) => segment === "..")
        ) {
          throw new IworkPackageError("An entry leaves the package.");
        }
        if (INDEX_PARTS.test(name)) indexed = true;
      },
      accept: () => true,
      data: (_name, chunk) => {
        expanded += chunk.length;
        if (expanded > IWORK_PACKAGE_LIMITS.maxExpandedBytes) {
          throw new IworkPackageError("Expands too far.");
        }
      },
    });
  } catch (error) {
    if (error instanceof IworkPackageError) throw error;
    if (error instanceof BoundedInflateError) {
      throw new IworkPackageError("Not a readable ZIP package.");
    }
    throw error;
  }
  if (!indexed) throw new IworkPackageError("Not an iWork document.");
};
