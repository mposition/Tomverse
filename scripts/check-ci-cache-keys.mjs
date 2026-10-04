#!/usr/bin/env node
/**
 * Fails when an Actions cache key lets one workflow restore another's entry.
 *
 * Judgement is scripts/ci-cache-key-policy.mjs; this only reads the workflow
 * directory and prints. Read-only, no credentials.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CACHE_FAMILIES,
  NON_WRITE_CACHE_MODES,
  WIDELY_READABLE_BRANCHES,
  describeFinding,
  judgeCacheKeys,
} from "./ci-cache-key-policy.mjs";

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
  `Actions cache check passed across ${sources.length} workflow(s): no key is declared by two of them, ` +
    `every key carries <family>-v<n>-<namespace>- in fixed text, no restore-key reaches past its own, ` +
    `no two workflows share or prefix a namespace (paths with a declared family: ` +
    `${CACHE_FAMILIES.map((entry) => entry.family).join(", ")}), nothing writes a cache from a run ` +
    `that can land on ${WIDELY_READABLE_BRANCHES.join(" or ")}, and every workflow that can run there ` +
    `declares cache-mode: ${NON_WRITE_CACHE_MODES.join(" or ")} so the job's token cannot write one ` +
    `past its declared steps.`,
);
