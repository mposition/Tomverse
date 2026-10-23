#!/usr/bin/env node
/**
 * Writes tools/auto-rec-agent/lib/agentAuthorityFiles.generated.mjs: the
 * ownership manifest lib/agentAuthorityFiles.ts with its types stripped.
 *
 * The Ubuntu auto-rec runner and gateway run on the host's /usr/bin/node,
 * and Ubuntu's nodejs package is built without TypeScript support (2026-10-23:
 * ERR_NO_TYPESCRIPT on 22.22.1+dfsg), so they cannot import the .ts file.
 * The manifest stays the single source; this file is its plain-JS copy, and
 * tests/agentAutoRecAuthorityCopy.test.mjs fails whenever the two differ.
 *
 *   npm run generate:auto-rec-authority          write the copy
 *   npm run generate:auto-rec-authority -- --check   exit 1 if it is stale
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { transformSync } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const AUTHORITY_SOURCE = "lib/agentAuthorityFiles.ts";
export const AUTHORITY_COPY = "tools/auto-rec-agent/lib/agentAuthorityFiles.generated.mjs";

const HEADER = `// GENERATED from ${AUTHORITY_SOURCE} by \`npm run generate:auto-rec-authority\`. Do not edit.
// The auto-rec runner's host node cannot import TypeScript; see scripts/generate-auto-rec-authority.mjs.
`;

/** The copy for a given manifest source: types stripped, nothing else changed. */
export function renderAuthorityCopy(source) {
  const { code } = transformSync(source, { loader: "ts", format: "esm", target: "es2022", legalComments: "none" });
  return `${HEADER}${code}`;
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  const expected = renderAuthorityCopy(readFileSync(join(ROOT, AUTHORITY_SOURCE), "utf8"));
  const target = join(ROOT, AUTHORITY_COPY);
  if (process.argv.includes("--check")) {
    let current = null;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = null;
    }
    if (current !== expected) {
      console.error(`${AUTHORITY_COPY} is stale: run npm run generate:auto-rec-authority`);
      process.exit(1);
    }
    console.log(`${AUTHORITY_COPY} matches ${AUTHORITY_SOURCE}.`);
  } else {
    writeFileSync(target, expected);
    console.log(`wrote ${AUTHORITY_COPY}`);
  }
}
