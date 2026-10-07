// Reads a branch's effective protection -- classic branch protection and every
// active ruleset rule -- and prints it in the normalised shape of
// lib/qaReleaseBranchProtectionCore.ts (docs/policy/qa-release-agent.md
// version 7, section 8 item 10). For develop it also compares with the
// protection the policy records.
//
// Read-only. Needs GH_TOKEN or GITHUB_TOKEN with administration read on the
// repository (classic protection is admin-read); prints no token or header.
//
//   npm run report:qa-release-protection -- --branch develop
//
// Exit 0: read, and (develop) the same as the policy's record. Exit 1: read,
// and different. Exit 2: could not read.

import {
  QA_RELEASE_DEVELOP_PROTECTION_RECORDED,
  qaReleaseClassicProtection,
  qaReleaseProtectionDifferences,
  qaReleaseRulesetRules,
} from "../lib/qaReleaseBranchProtectionCore.ts";

const REPOSITORY = "mposition/Tomverse";
const BRANCHES = new Set(["develop", "main"]);

const args = process.argv.slice(2);
const branchIndex = args.indexOf("--branch");
const branch = branchIndex >= 0 ? args[branchIndex + 1] : undefined;
if (!branch || !BRANCHES.has(branch)) {
  console.error("usage: --branch develop|main");
  process.exit(2);
}
const token = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
if (!token) {
  console.error("GH_TOKEN or GITHUB_TOKEN is required (administration read).");
  process.exit(2);
}

const get = async (path, { allow404 = false } = {}) => {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (allow404 && response.status === 404) return null;
  if (response.status !== 200) throw new Error(`github_${response.status}`);
  return response.json();
};

try {
  const snapshot = {
    branch,
    classic: qaReleaseClassicProtection(await get(`/branches/${branch}/protection`, { allow404: true })),
    rules: qaReleaseRulesetRules(await get(`/rules/branches/${branch}`)),
  };
  const differences = branch === "develop" ? qaReleaseProtectionDifferences(QA_RELEASE_DEVELOP_PROTECTION_RECORDED, snapshot) : null;
  console.log(JSON.stringify({ readAt: new Date().toISOString(), repository: REPOSITORY, snapshot, differencesFromPolicyRecord: differences }, null, 2));
  process.exitCode = differences && differences.length > 0 ? 1 : 0;
} catch (error) {
  console.error(`could not read the protection: ${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 2;
}
