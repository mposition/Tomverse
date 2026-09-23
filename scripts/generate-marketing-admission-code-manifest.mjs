// Writes `config/marketing-admission-code-manifest.json`.
//
// Read the diff it produces. A file appearing in that list is a file whose
// bytes now decide whether a post goes out by itself, and a file leaving it is
// a claim that a decision no longer depends on them.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MARKETING_ADMISSION_CODE_MANIFEST_PATH,
  MARKETING_ADMISSION_CODE_ROOTS,
  MARKETING_ADMISSION_CODE_SCHEMA_VERSION,
  marketingAdmissionCodeClosure,
  marketingAdmissionCodeDigest,
} from "./marketing-admission-code-core.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const { files, unresolved } = marketingAdmissionCodeClosure(repositoryRoot);

if (unresolved.length > 0) {
  for (const entry of unresolved) {
    console.error(
      `generate:marketing-admission-code — ${entry.from} imports ` +
        `${entry.specifier}, which resolves to no file here.`
    );
  }
  console.error(
    "Refusing to write a manifest that is already incomplete. Fix the import " +
      "or say why it is not local."
  );
  process.exitCode = 1;
} else {
  const target = fileURLToPath(
    new URL(`../${MARKETING_ADMISSION_CODE_MANIFEST_PATH}`, import.meta.url)
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify(
      {
        schemaVersion: MARKETING_ADMISSION_CODE_SCHEMA_VERSION,
        roots: [...MARKETING_ADMISSION_CODE_ROOTS],
        digest: marketingAdmissionCodeDigest(files),
        totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
        files,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  console.log(
    `generate:marketing-admission-code — wrote ${files.length} file(s) to ` +
      MARKETING_ADMISSION_CODE_MANIFEST_PATH
  );
}
