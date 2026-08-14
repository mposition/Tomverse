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
// tell which was meant. That rule and the unscoped one are enforced on the
// lines this change added, so they stop new ones without demanding a rewrite
// of every comment that predates the check.

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
  // This check's own fixtures. They contain deliberately wrong citations —
  // that is what they test — and a checker that failed on its own negative
  // cases could not have any.
  //
  // Note for whoever runs this before committing: the corpus is `git
  // ls-files`, so an untracked file is invisible. A local pass on new files
  // that have not been added yet is not a pass; this exclusion exists because
  // that happened.
  "scripts/check-policy-section-references-core.mjs",
  "tests/policySectionReferences.test.mjs",
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
 * The two soft rules are enforced on lines this change actually added.
 *
 * They were briefly enforced as repository-wide totals, and that was wrong
 * for a reason worth keeping: merging an unrelated day of develop moved the
 * unscoped count from 991 to 1002, and the check failed on a branch whose
 * diff touched none of them. A gate that fails for something the author did
 * not do is a gate people learn to skip.
 *
 * So the absolute rules — a section its document lacks, a section no document
 * has — stay global, because those are wrong wherever they sit. The two
 * legibility rules apply only to added lines, which is exactly "do not add a
 * new one" and nothing more. The several hundred that predate this are left
 * where they are until someone touches that line for another reason.
 *
 * With no base to compare against (a detached checkout, a first commit) the
 * soft rules are reported and not enforced, and the summary says so.
 */
const baseRef = () => {
  const explicit = process.argv.indexOf("--since");
  if (explicit !== -1 && process.argv[explicit + 1]) {
    return process.argv[explicit + 1];
  }
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return "origin/develop";
};

/** File -> set of line numbers this change added, or null when unknown. */
const addedLines = (ref) => {
  let base;
  try {
    base = execSync(`git merge-base HEAD ${ref}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
  let diff;
  try {
    diff = execSync(`git diff -U0 ${base} -- .`, {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch {
    return null;
  }
  const byFile = new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      current = header[1];
      if (!byFile.has(current)) byFile.set(current, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i += 1) byFile.get(current).add(start + i);
    }
  }
  return byFile;
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

const added = addedLines(baseRef());
const isNew = (entry) => {
  if (!added) return false;
  const match = /^(.+):(\d+)\s/.exec(entry);
  if (!match) return false;
  return added.get(match[1])?.has(Number(match[2])) === true;
};

const newUnscoped = unscoped.filter(isNew);
const newAmbiguous = ambiguous.filter(isNew);

const report = (label, entries) => {
  console.error(`${label} (${entries.length}):`);
  for (const entry of entries.slice(0, 40)) console.error(`  ${entry}`);
  if (entries.length > 40) console.error(`  ... and ${entries.length - 40} more`);
  console.error("");
};

if (failures.length > 0 || newUnscoped.length > 0 || newAmbiguous.length > 0) {
  console.error("Policy section reference check failed.\n");
  if (failures.length > 0) {
    console.error(`Sections that do not exist (${failures.length}):`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error("");
  }
  if (newUnscoped.length > 0) {
    report("Added lines whose citation has no document to resolve against", newUnscoped);
  }
  if (newAmbiguous.length > 0) {
    report("Added lines whose citation could mean more than one document", newAmbiguous);
  }
  console.error(
    "Write the document beside the number — `docs/policy/external-conversation-import-and-memory.md §14` —\n" +
      "or correct the number. A citation nobody can follow is worse than none."
  );
  process.exit(1);
}

console.log(
  `Policy section reference check passed: ${checked} citation(s) against ` +
    `${policyDocuments.length} policy document(s). ${resolved} resolve to a ` +
    `named document and none point at a section that does not exist. ` +
    (added
      ? `No added line introduces an unscoped or ambiguous one ` +
        `(${unscoped.length} and ${ambiguous.length} predate this change).`
      : `No base to diff against, so the ${unscoped.length} unscoped and ` +
        `${ambiguous.length} ambiguous bare citation(s) were reported only.`)
);
