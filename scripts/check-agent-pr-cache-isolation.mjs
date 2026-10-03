#!/usr/bin/env node
/**
 * Fails when a credentialed job that can run on the engineering agent's own
 * pull request restores an Actions cache -- any cache, the verified
 * package-manager one included.
 *
 * This is the device docs/policy/engineering-agent.md §5's cache isolation
 * record needs for its third direction. `check:credential-cache-separation`
 * does not maintain it: that check permits `verified_package_manager`, and the
 * lockfile comparison which makes that kind verified is not a defence against
 * this subject, because the agent can change `package-lock.json` in its own
 * pull request (.github/audits/actions-cache-poisoning-audit-2026-10-03.md P7).
 *
 * Judgement is scripts/agent-pr-cache-isolation-policy.mjs over
 * lib/agentCredentialReachability.ts; this only reads the workflow directory
 * and prints. Read-only, no credentials.
 *
 * Prints counts rather than names: the repository is public and
 * docs/policy/engineering-agent.md §16 keeps the list of unresolved
 * reachability targets out of it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { analyseCredentialReachability } from "../lib/agentCredentialReachability.ts";

import { judgeAgentPrCacheIsolation } from "./agent-pr-cache-isolation-policy.mjs";

const WORKFLOW_DIR = ".github/workflows";

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => ({
    path: `${WORKFLOW_DIR}/${name}`,
    // The analysis only uses blobSha to validate human exclusions, and this
    // check passes none, so a placeholder is honest here rather than a stand-in
    // for something it would otherwise read.
    blobSha: "0".repeat(40),
    text: readFileSync(join(WORKFLOW_DIR, name), "utf8"),
  }));

const analysis = analyseCredentialReachability({
  workflows,
  // No exclusion narrows this. §5's cache rule already ignores the human
  // exclusion list, and the owner's decision for this condition was to hold it
  // as a fact rather than to add a second, narrower exclusion mechanism.
  exclusions: [],
  // Deliberately false, and it must stay false. Passing `true` makes the
  // analysis stop reporting cache reasons, so this check would go blind at
  // exactly the moment the record it supports gets written -- and the record is
  // only true while this check holds.
  cacheIsolationRecorded: false,
});

const verdict = judgeAgentPrCacheIsolation(analysis);

if (verdict.status !== "judged") {
  console.error(
    `Agent PR cache isolation check could not analyse ${verdict.problemCount} workflow(s) or result field(s).`,
  );
  console.error("Run npm run report:engineering-agent-tiers locally to see which; it is not printed here (policy §16).");
  process.exit(1);
}

if (!verdict.held) {
  console.error(
    `Agent PR cache isolation check failed: ${verdict.offenders.length} job(s) holding a credential restore an ` +
      `Actions cache in a workflow an event the agent raises reaches (${verdict.kindDistribution}).`,
  );
  console.error("");
  console.error("This is a stronger condition than check:credential-cache-separation, on a narrower set of");
  console.error("workflows. A package manager's own cache is refused here too: npm ci compares it against the");
  console.error("lockfile, and the agent can change the lockfile in the same pull request, so the comparison");
  console.error("agrees with whatever the agent put there.");
  console.error("");
  console.error("A job's `if:` is not a way out. docs/policy/engineering-agent.md §5 forbids the analyser from");
  console.error("reading job conditions to narrow a result, and reading a trigger without its condition is the");
  console.error("mistake the audit's F5 made twice. Either take the cache out of that job, or take the");
  console.error("credential out of it.");
  console.error("");
  console.error("While this check fails, docs/policy/engineering-agent.md §5 forbids writing the cache isolation");
  console.error("record: its third condition is exactly what this check keeps.");
  console.error("");
  console.error("The names are not printed here -- this repository is public and");
  console.error("docs/policy/engineering-agent.md §16 keeps the list of unresolved reachability targets out of it.");
  console.error("Run npm run report:engineering-agent-tiers locally.");
  process.exit(1);
}

console.log(
  `Agent PR cache isolation check passed: of ${verdict.credentialedJobsInReachedCount} credentialed job(s) in the ` +
    `${verdict.reachedWorkflowCount} workflow(s) an event the agent raises reaches, none restores any Actions ` +
    `cache. ${verdict.cacheRestoringJobsAnywhereCount} credentialed job(s) restore one elsewhere, which this ` +
    `check does not ask about and docs/policy/engineering-agent.md §5 forbids all the same. ` +
    `${workflows.length} workflow(s) read.`,
);
