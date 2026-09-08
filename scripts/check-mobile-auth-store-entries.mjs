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
const checkingTemplates = activePath === DEFAULTS.active && pendingPath === DEFAULTS.pending;

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

const problems = [
  ...mobileStoreEntryProblems(active, `active (${activePath})`),
  ...mobileStoreEntryProblems(pending, `pending (${pendingPath})`),
  ...mobileStorePairProblems({ active, pending }),
];

// The templates carry placeholders on purpose -- the fingerprint rule is not
// decided, and a template that invented one would be that decision. They are
// still checked for everything else, so the shape cannot drift from the rules.
const templatePlaceholders = checkingTemplates
  ? problems.filter((problem) => /fingerprint/.test(problem))
  : [];
const real = problems.filter((problem) => !templatePlaceholders.includes(problem));

if (real.length > 0) {
  console.error(`FAIL mobile auth store entries (${real.length} problem${real.length === 1 ? "" : "s"})\n`);
  for (const problem of real) console.error(`  - ${problem}`);
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
