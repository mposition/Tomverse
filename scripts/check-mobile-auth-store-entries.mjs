// Whether the two secret-store entries have the shape the rotation depends on.
//
//   npm run check:mobile-auth-store-entries -- --active <file> --pending <file>
//   npm run check:mobile-auth-store-entries            (checks the templates)
//
// The entries themselves live in the vault. What this reads is a copy of their
// metadata -- the non-secret half -- so an operator can check a Pending before
// relying on it, and so the templates in this repository cannot drift from the
// rules that describe them.
//
// **Structure only.** Every field is written by hand, the deployment id
// included, so a pair that passes here says the two entries are internally
// consistent and are not each other's leftovers. It says nothing about what is
// deployed. That is the post-deploy verification, and binding evidence to a
// deployment is still an open decision:
// docs/ops/mobile-auth-key-rotation.md section 6.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MOBILE_STORE_ENTRY_DISCLAIMER,
  mobileStoreEntryProblems,
  mobileStorePairProblems,
} from "./mobile-auth-store-entry-core.mjs";

const argument = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const DEFAULTS = {
  active: "docs/ops/mobile-auth-store-entries/active.template.json",
  pending: "docs/ops/mobile-auth-store-entries/pending.template.json",
};

const activePath = argument("active") ?? DEFAULTS.active;
const pendingPath = argument("pending") ?? DEFAULTS.pending;
// Resolved, so `./docs/...` and `docs/...` are the same two files. Whether the
// placeholders are tolerated has to depend on which file is being read, not on
// how the operator spelled the path.
const isTemplate = (given, standard) => resolve(given) === resolve(standard);
const checkingTemplates =
  isTemplate(activePath, DEFAULTS.active) && isTemplate(pendingPath, DEFAULTS.pending);

const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // The file is not repeated in the message: if it is malformed because a
    // ring was pasted into it, the ring would come out here.
    console.error(`FAIL mobile auth store entries: ${path} is not readable JSON (${error.name}).`);
    process.exit(1);
  }
};

const active = read(activePath);
const pending = read(pendingPath);

// The templates carry the two placeholders on purpose -- the fingerprint rule
// is not decided, and a template that invented one would be that decision. The
// exemption is those exact strings and nothing else: an earlier version
// dropped every problem whose text mentioned the fingerprint, which exempted a
// missing field as readily as a placeholder.
const options = { allowPlaceholders: checkingTemplates };

const problems = [
  ...mobileStoreEntryProblems(active, `active (${activePath})`, options),
  ...mobileStoreEntryProblems(pending, `pending (${pendingPath})`, options),
  ...mobileStorePairProblems({ active, pending }),
];

if (problems.length > 0) {
  console.error(`FAIL mobile auth store entries (${problems.length} problem${problems.length === 1 ? "" : "s"})\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\n  ${MOBILE_STORE_ENTRY_DISCLAIMER}`);
  console.error("  docs/ops/mobile-auth-key-rotation.md section 2.2");
  process.exit(1);
}

console.log(
  `OK mobile auth store entries: ${activePath} and ${pendingPath} have the shape section 2.2 describes.`
);
console.log(`  ${MOBILE_STORE_ENTRY_DISCLAIMER}`);
if (checkingTemplates) {
  console.log(
    "  These are the templates: their fingerprint fields are placeholders because the\n" +
      "  algorithm is not decided (section 6, item 2). A real entry needs real values."
  );
}
