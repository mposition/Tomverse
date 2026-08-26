// Fails when the release checklist and CI disagree about what the gate is.
//
// See scripts/check-release-gate-coverage-core.mjs for why this exists and
// what each direction of the mismatch costs.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditReleaseGateCoverage,
  enforcedByCi,
  MANUALLY_GATED_CHECKS,
  scriptMentions,
} from "./check-release-gate-coverage-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const packageScripts = Object.keys(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {}
).filter((name) => /^(check|verify):/.test(name));

const workflowsDir = join(root, ".github", "workflows");
const ciMentions = new Set();
for (const entry of readdirSync(workflowsDir)) {
  if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
  const source = readFileSync(join(workflowsDir, entry), "utf8");
  // A dispatch-only workflow stops nothing, so what it runs is a step of a
  // procedure rather than a gate the checklist has to carry.
  if (!enforcedByCi(source)) continue;
  for (const script of scriptMentions(source)) {
    ciMentions.add(script);
  }
}

const checklistMentions = scriptMentions(
  readFileSync(join(root, ".github", "RELEASE_CHECKLIST.md"), "utf8")
);

const { errors } = auditReleaseGateCoverage({
  packageScripts,
  ciMentions,
  checklistMentions,
});

if (errors.length > 0) {
  console.error(
    `\n${errors.length} release gate coverage problem(s):\n` +
      errors.map((message) => `  - ${message}`).join("\n") +
      "\n\nThe release checklist is the only place the whole gate is written\n" +
      "down in one list. A check CI enforces but the checklist omits means a\n" +
      "release manager who followed the checklist did not run the gate.\n"
  );
  process.exit(1);
}

console.log(
  `Release gate coverage check passed: ${ciMentions.size} CI-enforced and ` +
    `${Object.keys(MANUALLY_GATED_CHECKS).length} manually gated check(s), ` +
    `all named in the release checklist.`
);
