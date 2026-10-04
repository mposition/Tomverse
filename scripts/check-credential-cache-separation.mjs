#!/usr/bin/env node
/**
 * Fails when a job holding a credential restores a cache nothing verifies.
 *
 * The separation this enforces exists today by accident. Every job the
 * reachability analysis judges to hold a writable credential restores only a
 * package manager's own cache, which `npm ci` checks against the lockfile, so a
 * tampered entry fails or is refetched rather than installing different code.
 * None of them restores `.next/cache` or the Playwright browser cache, which
 * have no such check -- a build reads the first into the server bundle it then
 * runs, and a cache hit launches the second without downloading or hashing it.
 *
 * Nothing was holding that apart. One `actions/cache` step added to any of
 * those jobs would put unverified bytes next to a repository write token and
 * provider API keys, and the existing `credential_job_restores_cache` rule
 * would not notice: it already fires for all of them, for the verified cache.
 *
 * Judgement is lib/agentCredentialReachability.ts -- the same module the agent
 * push policy uses, deliberately, so there is one answer to "which jobs hold a
 * credential" rather than two that can drift
 * (.github/audits/actions-cache-poisoning-audit-2026-10-03.md F4 and P3).
 *
 * Read-only, no credentials. Prints counts rather than names: the repository is
 * public and docs/policy/engineering-agent.md §16 keeps the list of unresolved
 * reachability targets out of it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { analyseCredentialReachability } from "../lib/agentCredentialReachability.ts";

const WORKFLOW_DIR = ".github/workflows";

/** The kinds that must never reach a credentialed job. */
const REFUSED_KINDS = new Set(["unverified", "unreadable"]);

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
  exclusions: [],
  // Not this check's question. It asks what a credentialed job restores, which
  // the recorded isolation does not change.
  cacheIsolationRecorded: false,
});

if (analysis.status !== "analysed") {
  console.error(`Credential cache separation check could not analyse ${analysis.problems.length} workflow(s).`);
  console.error("Run npm run report:engineering-agent-tiers locally to see which; it is not printed here (policy §16).");
  process.exit(1);
}

const cacheReasons = analysis.reasons.filter((reason) => reason.reason === "credential_job_restores_cache");
const offenders = cacheReasons.filter((reason) => reason.cacheKinds.some((kind) => REFUSED_KINDS.has(kind)));

const byKind = new Map();
for (const reason of cacheReasons) {
  const key = reason.cacheKinds.join("+") || "(none)";
  byKind.set(key, (byKind.get(key) ?? 0) + 1);
}
const distribution = [...byKind].sort().map(([kind, count]) => `${kind}=${count}`).join(", ");

if (offenders.length > 0) {
  console.error(
    `Credential cache separation check failed: ${offenders.length} job(s) holding a credential restore a cache ` +
      `nothing verifies (${distribution}).`,
  );
  console.error("");
  console.error("A job with a write permission or an external secret may restore a package manager's own cache,");
  console.error("because npm ci verifies it against the lockfile. It may not restore build output or browser");
  console.error("binaries: nothing checks those, and the job executes them.");
  console.error("");
  console.error("Either take the cache out of that job, or take the credential out of it. The names are not");
  console.error("printed here -- this repository is public and docs/policy/engineering-agent.md §16 keeps the list");
  console.error("of unresolved reachability targets out of it. Run npm run report:engineering-agent-tiers locally.");
  process.exit(1);
}

// Zero is its own sentence. The clause about what the restored cache is only
// describes a case where something is restored, and printing "all of it
// package-manager cache ()" at zero states a fact about an empty set.
console.log(
  cacheReasons.length === 0
    ? `Credential cache separation check passed: no credentialed job restores any cache. ` +
        `${analysis.credentialedJobs.length} credentialed job(s) across ${workflows.length} workflow(s).`
    : `Credential cache separation check passed: ${cacheReasons.length} credentialed job(s) restore a cache, ` +
        `all of it package-manager cache that npm ci verifies against the lockfile (${distribution}). ` +
        `${analysis.credentialedJobs.length} credentialed job(s) across ${workflows.length} workflow(s).`,
);
