// Every `§NN` in the codebase points at a section that exists.
//
//   npm run check:policy-section-references
//
// ## The failure this exists for
//
// Release C shipped 105 citations of sections 31, 32 and 42 to 46 across 38
// files. None of those sections exist: they came from a program specification
// that was never committed, and docs/policy/external-conversation-import-and-memory.md
// ends at §25. Every one of them told a reader to open something that is not
// there, and nothing caught it — `check:doc-references` validates *paths*, and
// each of those citations sat beside a path that was perfectly correct.
//
// A section number is a reference like any other. This is the check that
// treats it as one.
//
// ## Why a number alone cannot be validated
//
// There are fourteen policy documents and their numbering is independent:
// §9 is retrieval in one and something else in another, and §22 exists in some
// and not others. So a bare `§22` is only meaningful relative to a document,
// and this check resolves it the two ways a reader does.
//
//   1. **Explicit.** `docs/policy/external-conversation-import-and-memory.md §14, §9.1` — the path and the sections
//      on the same line. Each section is validated against that document. This
//      is the form to write; it is the only one that survives a file being
//      split, and the only one a reader can follow without guessing.
//
//   2. **Scoped.** A bare `§14` in a file that names one or more policy
//      documents resolves against those documents. It passes if any of them
//      has the section — which is what a reader would conclude too.
//
// A bare citation in a file that names no policy document at all cannot be
// resolved by anyone, so it fails unless it is a known non-policy reference
// (see below).
//
// ## What is deliberately not checked
//
//   * `prisma/migrations/**` — applied migrations are immutable. A citation
//     inside one records what was true when it ran, and editing it would
//     change a file the database has already checksummed.
//   * `.github/audits/**` and the remediation reports — past records. They say
//     what was believed at the time, which is their whole value.
//   * Anything citing a standard rather than a policy: `RFC 9111 §5.2.2.5` is
//     a real reference to a document this check does not own. A line naming a
//     non-policy `.md` file is skipped for the same reason.
//
// ## Ambiguity
//
// A bare citation in a file naming several policy documents is reported when
// more than one of them has that section, because the reader has no way to
// tell which was meant. Those are listed as ambiguous and recorded in
// AMBIGUOUS_BASELINE: existing ones are tolerated, new ones fail, which is the
// same shape `tests/localeParity.test.mjs` uses for English left in a locale.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  classifyFile,
  sectionsFromMarkdown,
} from "./check-policy-section-references-core.mjs";

const EXCLUDED_PREFIXES = [
  // Immutable once applied.
  "prisma/migrations/",
  // Past records, preserved as written.
  ".github/audits/",
];

const EXCLUDED_FILES = new Set([
  // Past records at the repository root, in the same class as .github/audits:
  // they say what was believed when they were written.
  "FINAL_REMEDIATION_REPORT_KO.md",
  "Tomverse-Insight-UX-Audit-Final-Report.md",
  "Tomverse-Insight-UX-Audit-Final-Work-Order.md",
  "Tomverse-Insight-UX-Audit-Final-Work-Order-Amended.md",
]);

/**
 * Bare citations that name no policy document and resolve to nothing here,
 * because they point at a document this check does not own. Each entry says
 * which.
 */
const NON_POLICY_REFERENCES = [
  {
    file: "lib/conversationLock.ts",
    sections: ["7.5"],
    reason: ".github/RELEASE_CHECKLIST.md §7.5, named on the next line.",
  },
  {
    file: "tests/modelRegistryPricingInheritance.test.ts",
    sections: ["7.6"],
    reason: ".github/RELEASE_CHECKLIST.md §7.6, named two lines above.",
  },
  {
    file: "lib/discardResponseBody.ts",
    sections: ["5.2.2.5"],
    reason: "RFC 9111 §5.2.2.5, named on the line above.",
  },
];

/**
 * The repository's existing bare citations, as recorded numbers.
 *
 * Two of the four rules are absolute and have no baseline: an explicit
 * citation naming a section its document does not have, and a citation of a
 * section **no** policy document has. Both are wrong however the file is
 * written, and both are what Release C got wrong.
 *
 * The other two are about legibility rather than correctness. A bare `§8.1`
 * in a file that names no document resolves fine for anyone who knows which
 * document the file is about, and several hundred of them predate this check.
 * Failing them all would mean rewriting comments that are not wrong, so they
 * are counted instead: the totals below are what exists today, and the check
 * fails when either grows. New code writes the document beside the number.
 *
 * Lower these when a file is touched for other reasons. Raising one is a
 * deliberate decision that belongs in the pull request that does it.
 */
const BASELINE = {
  /** Bare citations in files that name no policy document. */
  unscoped: 991,
  /** Bare citations that could mean more than one document the file names. */
  ambiguous: 81,
};

const SCANNED_EXTENSIONS = ["*.ts", "*.tsx", "*.mjs", "*.prisma", "*.md"];

const tracked = (patterns) =>
  execSync(`git ls-files ${patterns.map((p) => `'${p}'`).join(" ")}`)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);

const policyDocuments = tracked(["docs/policy/*.md"]);
const sections = new Map(
  policyDocuments.map((path) => [
    path,
    sectionsFromMarkdown(readFileSync(path, "utf8")),
  ])
);

const failures = [];
const unscoped = [];
const ambiguous = [];
let checked = 0;
let resolved = 0;

for (const file of tracked(SCANNED_EXTENSIONS)) {
  if (EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
  if (EXCLUDED_FILES.has(file)) continue;

  const source = readFileSync(file, "utf8");
  if (!source.includes("§")) continue;

  const result = classifyFile({
    file,
    source,
    sections,
    // A document citing its own section is the commonest reader model there
    // is: `.github/RELEASE_CHECKLIST.md` saying "see §7.2" means its own.
    ownSections: file.endsWith(".md")
      ? sectionsFromMarkdown(source)
      : new Set(),
    exempt: new Set(
      NON_POLICY_REFERENCES.filter((entry) => entry.file === file).flatMap(
        (entry) => entry.sections
      )
    ),
  });

  resolved += result.valid;
  checked +=
    result.valid +
    result.missing.length +
    result.unscoped.length +
    result.ambiguous.length;
  failures.push(...result.missing);
  unscoped.push(...result.unscoped);
  ambiguous.push(...result.ambiguous);
}

const overBaseline = (kind, found) => found.length > BASELINE[kind];

const report = (label, entries, limit) => {
  console.error(`${label} (${entries.length}, recorded ${limit}):`);
  for (const entry of entries.slice(0, 40)) console.error(`  ${entry}`);
  if (entries.length > 40) {
    console.error(`  ... and ${entries.length - 40} more`);
  }
  console.error("");
};

const failed =
  failures.length > 0 ||
  overBaseline("unscoped", unscoped) ||
  overBaseline("ambiguous", ambiguous);

if (failed) {
  console.error("Policy section reference check failed.\n");
  if (failures.length > 0) {
    console.error(`Sections that do not exist (${failures.length}):`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error("");
  }
  if (overBaseline("unscoped", unscoped)) {
    report("Bare citations with no document to resolve against", unscoped, BASELINE.unscoped);
  }
  if (overBaseline("ambiguous", ambiguous)) {
    report("Bare citations that could mean more than one document", ambiguous, BASELINE.ambiguous);
  }
  console.error(
    "Write the document beside the number — `docs/policy/external-conversation-import-and-memory.md §14` — or\n" +
      "correct the number. A citation nobody can follow is worse than none."
  );
  process.exit(1);
}

console.log(
  `Policy section reference check passed: ${checked} citation(s) against ` +
    `${policyDocuments.length} policy document(s). ` +
    `${resolved} resolve to a named document, none point at a section that ` +
    `does not exist, and ${unscoped.length} unscoped / ${ambiguous.length} ` +
    `ambiguous bare citation(s) are within the recorded baseline ` +
    `(${BASELINE.unscoped} / ${BASELINE.ambiguous}).`
);
