/**
 * One .docx per spreadsheet row, delivered as a single archive.
 *
 * Policy: docs/policy/generated-artifacts.md section 13.
 *
 * This is the module that answers "make me ten contracts from this template
 * and this list". It exists because the three obvious ways of doing it are all
 * wrong:
 *
 *   * **Ten top-level artifacts.** The per-answer ceiling is three, and it is
 *     three for a reason that has nothing to do with this request: it bounds
 *     how much work one turn can ask for. Raising it to satisfy a batch would
 *     raise it for everything.
 *   * **Ten documents written from a specification.** That produces ten files
 *     which are not the user's template. The letterhead, the table borders,
 *     the header, the footer, the section setup and the fonts are the document
 *     as far as the person receiving it is concerned.
 *   * **The model retyping the values.** The spreadsheet reaches the model as
 *     extracted text. Asking it to copy dates out of that blob is asking for a
 *     birth date to land on the wrong row, silently, in a signed document.
 *
 * So: one archive artifact (the existing ceiling is untouched), the template
 * copied part for part (`lib/docxTemplate.ts`), and the values read from the
 * spreadsheet by the server (`lib/spreadsheetDataRows.ts`). The model supplies
 * two opaque attachment handles and a naming rule, and never touches a byte.
 */

import "server-only";

import {
  ARTIFACT_LIMITS,
  isSafeArchivePath,
  sanitizeArtifactFilename,
} from "@/lib/generatedArtifactCore";
import {
  DocxTemplateError,
  loadDocxTemplate,
  renderDocxFromTemplate,
} from "@/lib/docxTemplate";
import {
  SpreadsheetDataError,
  readSpreadsheetDataRows,
} from "@/lib/spreadsheetDataRows";

export class DocxBatchError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DocxBatchError";
  }
}

export type DocxBatchEntry = { path: string; bytes: Uint8Array };

export type DocxBatchResult = {
  entries: DocxBatchEntry[];
  /** The sheet the records came from, so the reply can name it. */
  sheetName: string;
  /** The header cells, so a naming mistake can be reported usefully. */
  columns: string[];
};

/**
 * The date folder every generated document goes into.
 *
 * UTC, and injectable, because "which day is it" must not be a source of
 * non-determinism in a test that asserts a path.
 */
export const batchDateFolder = (now: Date): string =>
  `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(
    now.getUTCDate()
  ).padStart(2, "0")}`;

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]{1,120}?)\s*\}\}/g;

/**
 * The file name for one row.
 *
 * The naming rule is a template over the same column names as the document, so
 * `{{이름}}_근로계약서` is a name a person can predict. A column the rule names
 * and the row has no value for leaves an empty span rather than the literal
 * placeholder -- and the sanitiser below turns whatever is left into a name,
 * because a row with a blank name is a row that still has to be delivered.
 */
const nameForRow = (
  filenameTemplate: string,
  record: Record<string, string>
): string =>
  filenameTemplate.replace(
    new RegExp(PLACEHOLDER_PATTERN.source, "g"),
    (_, column: string) => record[column] ?? ""
  );

/**
 * Makes each name unique, in row order.
 *
 * Deterministic on purpose: two people with the same name in the same
 * spreadsheet must produce the same two files on every run, in the same order,
 * so a re-run is comparable to the last one. The suffix counts from 2 because
 * the first occurrence keeps the plain name -- which is what the person
 * scanning the archive expects to see.
 */
const deduplicate = (names: string[]): string[] => {
  const used = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const seen = used.get(key) ?? 0;
    used.set(key, seen + 1);
    if (seen === 0) return name;
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    return `${base}-${seen + 1}${extension}`;
  });
};

export type DocxBatchInput = {
  templateBytes: Uint8Array;
  dataBytes: Uint8Array;
  dataMediaType: string;
  sheet?: string;
  filenameTemplate: string;
  requiredPlaceholders?: readonly string[];
  /** Hard ceiling on generated entries. Never above the archive limit. */
  maxEntries?: number;
  now?: Date;
};

/**
 * Builds the entries for the archive.
 *
 * Refuses the whole batch rather than delivering part of it. A partially
 * filled set is the failure mode this feature must not have: the archive would
 * arrive, the person would send the contracts, and the one that was missing a
 * start date would be found by whoever received it.
 */
export const buildDocxBatchEntries = (
  input: DocxBatchInput
): DocxBatchResult => {
  const maxEntries = Math.min(
    input.maxEntries ?? ARTIFACT_LIMITS.maxArchiveEntries,
    ARTIFACT_LIMITS.maxArchiveEntries
  );

  let template;
  try {
    template = loadDocxTemplate(input.templateBytes);
  } catch (error) {
    if (error instanceof DocxTemplateError) {
      throw new DocxBatchError(error.code, error.message);
    }
    throw error;
  }
  if (template.placeholders.length === 0) {
    throw new DocxBatchError(
      "TEMPLATE_HAS_NO_PLACEHOLDERS",
      "The template contains no {{placeholder}} fields, so there is nothing to fill in per row."
    );
  }

  let data;
  try {
    data = readSpreadsheetDataRows(input.dataBytes, {
      mediaType: input.dataMediaType,
      sheet: input.sheet,
    });
  } catch (error) {
    if (error instanceof SpreadsheetDataError) {
      throw new DocxBatchError(error.code, error.message);
    }
    throw error;
  }

  if (data.rows.length > maxEntries) {
    throw new DocxBatchError(
      "ARCHIVE_ENTRY_LIMIT",
      `The data has ${data.rows.length} rows, over the ${maxEntries} file limit for one archive. ` +
        "Split the data and ask again."
    );
  }

  // Named before anything is rendered, so a naming rule that resolves to
  // nothing is reported once rather than after ten documents have been built.
  const folder = batchDateFolder(input.now ?? new Date());
  const names = deduplicate(
    data.rows.map((record) =>
      sanitizeArtifactFilename(nameForRow(input.filenameTemplate, record), "docx")
    )
  );

  const entries: DocxBatchEntry[] = [];
  data.rows.forEach((record, index) => {
    const path = `${folder}/${names[index]}`;
    if (!isSafeArchivePath(path)) {
      throw new DocxBatchError(
        "UNSAFE_PATH",
        `Row ${index + 1} produced an unusable file name.`
      );
    }
    try {
      entries.push({
        path,
        bytes: renderDocxFromTemplate(template, record, {
          requiredPlaceholders: input.requiredPlaceholders,
        }),
      });
    } catch (error) {
      if (error instanceof DocxTemplateError) {
        throw new DocxBatchError(
          error.code,
          `Row ${index + 1} (${names[index]}): ${error.message}`
        );
      }
      throw error;
    }
  });

  return { entries, sheetName: data.sheetName, columns: data.columns };
};
