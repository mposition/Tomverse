/**
 * Apple iWork packages (Pages, Numbers): the structural check.
 *
 * Policy: docs/policy/chat-attachment-formats.md (iWork) and
 * docs/policy/generated-artifacts.md section 15.
 *
 * An iWork file is a ZIP of Apple's own binary records. This application does
 * not read those records -- nothing here could, and the renderer service lays
 * the file out instead -- so the check is only what keeps a ZIP from being a
 * weapon on its way there: a bounded entry count and expanded size, no path
 * that leaves the package, and the index part every iWork document has.
 * Nothing is decompressed: the central directory says all of it.
 */

import { unzipSync } from "fflate";

export const IWORK_PACKAGE_LIMITS = {
  maxEntries: 5_000,
  /** The expanded size of every entry together, as the directory states it. */
  maxExpandedBytes: 512 * 1024 * 1024,
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
    unzipSync(bytes, {
      filter: (file) => {
        entries += 1;
        expanded += file.originalSize;
        if (entries > IWORK_PACKAGE_LIMITS.maxEntries) {
          throw new IworkPackageError("Too many entries.");
        }
        if (expanded > IWORK_PACKAGE_LIMITS.maxExpandedBytes) {
          throw new IworkPackageError("Expands too far.");
        }
        const name = file.name;
        if (
          name.startsWith("/") ||
          name.includes("\\") ||
          name.split("/").some((segment) => segment === "..")
        ) {
          throw new IworkPackageError("An entry leaves the package.");
        }
        if (INDEX_PARTS.test(name)) indexed = true;
        // Read nothing: the directory has already said what is needed.
        return false;
      },
    });
  } catch (error) {
    if (error instanceof IworkPackageError) throw error;
    throw new IworkPackageError("Not a readable ZIP package.");
  }
  if (!indexed) throw new IworkPackageError("Not an iWork document.");
};
