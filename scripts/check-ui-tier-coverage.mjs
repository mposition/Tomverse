// Fails when the @ui-risk tier and the document that describes it disagree.
//
// See scripts/check-ui-tier-coverage-core.mjs for why this exists.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditUiTierCoverage,
  specMentions,
  UI_RISK_TAG,
} from "./check-ui-tier-coverage-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const specsDir = join(root, "tests", "e2e");

const taggedSpecs = readdirSync(specsDir)
  .filter((entry) => entry.endsWith(".spec.ts"))
  .filter((entry) =>
    readFileSync(join(specsDir, entry), "utf8").includes(UI_RISK_TAG)
  )
  .map((entry) => basename(entry))
  .sort();

const documentPath = join(root, ".github", "audits", "ui-test-tiers.md");
const document = readFileSync(documentPath, "utf8");

// Only the section that describes the tier. The document also names specs it
// deliberately keeps *out* of the PR tier, and reading those as members would
// invert the check.
const start = document.indexOf("## `@ui-risk` tier 구성");
if (start < 0) {
  console.error(
    "\n.github/audits/ui-test-tiers.md no longer has an `@ui-risk` tier section.\n" +
      "That document is the single source of truth for tier membership; without\n" +
      "the section there is nothing for the tag to be checked against.\n"
  );
  process.exit(1);
}
const end = document.indexOf("\n## ", start + 1);
const section = document.slice(start, end < 0 ? undefined : end);

const { errors } = auditUiTierCoverage({
  taggedSpecs,
  documentedSpecs: specMentions(section),
});

if (errors.length > 0) {
  console.error(
    `\n${errors.length} @ui-risk tier coverage problem(s):\n` +
      errors.map((message) => `  - ${message}`).join("\n") +
      "\n\nThe tier is selected by a tag, so a spec joins it by being tagged and\n" +
      "the document does not notice. That document is where the tier's size is\n" +
      "reasoned about, and this tier blocks merges.\n"
  );
  process.exit(1);
}

console.log(
  `UI tier coverage check passed: ${taggedSpecs.length} ${UI_RISK_TAG} spec file(s), all recorded.`
);
