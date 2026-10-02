#!/usr/bin/env node
/**
 * Fails when an Actions cache key lets one workflow restore another's entry.
 *
 * Judgement is scripts/ci-cache-key-policy.mjs; this only reads the workflow
 * directory and prints. Read-only, no credentials.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describeFinding, judgeCacheKeys } from "./ci-cache-key-policy.mjs";

const WORKFLOW_DIR = ".github/workflows";

const sources = readdirSync(WORKFLOW_DIR)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => ({
    path: `${WORKFLOW_DIR}/${name}`,
    text: readFileSync(join(WORKFLOW_DIR, name), "utf8"),
  }));

const { findings, problems } = judgeCacheKeys(sources);

// A workflow that cannot be read is a failure rather than a pass: this check
// exists to answer a question about every workflow, and silence about one of
// them is not an answer.
if (problems.length > 0) {
  console.error("Cache key check could not read every workflow:");
  for (const problem of problems) console.error(`  ${problem.workflowPath}: ${problem.problem}`);
  process.exit(1);
}

if (findings.length > 0) {
  console.error(`Cache key check failed with ${findings.length} finding(s):`);
  for (const finding of findings) console.error(`  ${describeFinding(finding)}`);
  console.error("");
  console.error("Why this is a gate: .github/audits/actions-cache-poisoning-audit-2026-10-03.md F1 and F2.");
  process.exit(1);
}

console.log(
  `Cache key check passed: ${sources.length} workflow(s), governed cache families ` +
    `${JSON.stringify([".next/cache", "~/.cache/ms-playwright"])}. No shared keys and no family-wide restore-keys.`,
);
