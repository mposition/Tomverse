#!/usr/bin/env node
/**
 * How often would the engineering agent's rules have let a change through?
 *
 * docs/policy/engineering-agent.md §14 makes a tier ratio over a representative
 * corpus part of finishing the deterministic kernel: the push-forbidden rules
 * are conservative on purpose, and this measures what that costs, so the owner
 * can decide whether to widen the manifest's classification.
 *
 * The corpus is the last N pull requests merged into develop (first-parent
 * merge commits). Each is judged against its own base -- the merge's first
 * parent -- with every analysis the app runs: ownership manifest, credential
 * reachability, control-plane slice, the tier rules, and the parts of tree
 * listing verification that judge content rather than integrity -- its size
 * limits and what it does not support (the same function the app calls).
 * Re-hashing the listing is skipped: these are real Git objects, not a
 * drafting service's claims.
 *
 * Output is counts only. Paths are not printed, because the reasons a real
 * change is forbidden can name a reachability path the policy keeps out of
 * public files (§16).
 *
 * Read-only: it reads Git objects and writes nothing.
 *
 *   npm run report:engineering-agent-tiers -- --limit 30 [--ref origin/develop] [--json]
 *   npm run report:engineering-agent-tiers -- --limit 30 --simulate-tests-excluded --json
 */

import { execFileSync, spawnSync } from "node:child_process";

import { CONVENTION_VERSIONS } from "../lib/agentAuthorityFiles.ts";
import { cacheIsolationRecordSignature } from "../lib/agentCacheIsolationRecord.ts";
import { analyseCredentialReachability, credentialForbiddenPaths } from "../lib/agentCredentialReachability.ts";
import { AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS } from "../lib/agentCredentialReviewedExclusions.ts";
import { computeControlPlaneSlice } from "../lib/agentControlPlaneSlice.ts";
import { decideTier, policyNamedTestPaths } from "../lib/agentPushPolicy.ts";
import { TREE_LIMITS, decodeText, diffLines, unsupportedTreeChanges } from "../lib/engineeringAgentTreeVerify.ts";

import { judgeAgentPrCacheIsolation } from "./agent-pr-cache-isolation-policy.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const limit = Number.parseInt(option("--limit", "30"), 10);
const ref = option("--ref", "origin/develop");
const asJson = args.includes("--json");
// This is a read-only what-if report. It does not change the deployed image,
// policy, or the runtime T1 authority list.
const simulateTestsExcluded = args.includes("--simulate-tests-excluded");

const git = (gitArgs, input) =>
  execFileSync("git", gitArgs, { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, input });

/** Reads many blobs in one process. */
const readBlobs = (oids) => {
  if (oids.length === 0) return new Map();
  const result = spawnSync("git", ["cat-file", "--batch"], {
    input: `${oids.join("\n")}\n`,
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  const out = result.stdout;
  const blobs = new Map();
  let offset = 0;
  for (const oid of oids) {
    const newline = out.indexOf(10, offset);
    const header = out.subarray(offset, newline).toString("utf8").split(" ");
    const size = Number.parseInt(header[2], 10);
    blobs.set(oid, out.subarray(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1;
  }
  return blobs;
};

const treeListing = (commit, withTrees = false) =>
  git(["ls-tree", "-r", ...(withTrees ? ["-t"] : []), "-z", commit])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, oid] = meta.split(" ");
      return { path, mode, type, oid };
    });

const TEXT_FOR_ANALYSIS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|ya?ml|md)$/;

const commits = git(["rev-list", "--first-parent", "--merges", `--max-count=${limit}`, ref])
  .toString("utf8")
  .split("\n")
  .filter(Boolean);

const tally = {
  total: 0,
  t1: 0,
  t2: 0,
  listingRefused: 0,
  withinSizeLimits: 0,
  t1WithinSize: 0,
  t1IfCredentialResolved: 0,
  // How many of these merges §5's cache isolation record actually lifted the
  // cache rule for. Zero while the record is unsigned, and zero for any merge
  // whose own workflows broke the condition it rests on.
  cacheIsolationApplied: 0,
};
const reasons = new Map();
const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

for (const commit of commits) {
  const base = git(["rev-parse", `${commit}^1`]).toString("utf8").trim();
  const baseEntries = treeListing(base, true);
  const listing = baseEntries.filter((entry) => entry.type === "blob");
  const wanted = listing.filter((entry) => TEXT_FOR_ANALYSIS.test(entry.path));
  const blobs = readBlobs(wanted.map((entry) => entry.oid));
  const text = (oid) => {
    const content = blobs.get(oid);
    return content === undefined ? "" : (decodeText(content) ?? "");
  };
  const baseFiles = listing.map((entry) => ({ path: entry.path, text: TEXT_FOR_ANALYSIS.test(entry.path) ? text(entry.oid) : "" }));

  const raw = git(["diff-tree", "-r", "--no-renames", "-z", base, commit]).toString("utf8").split("\0").filter(Boolean);
  const diffs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, oldOid, newOid, status] = raw[i].replace(/^:/, "").split(" ");
    diffs.push({ path: raw[i + 1], oldMode, newMode, oldOid, newOid, status });
  }
  const zero = /^0+$/;
  const newBlobs = readBlobs(diffs.filter((d) => !zero.test(d.newOid) && d.newMode !== "160000").map((d) => d.newOid));
  const oldBlobs = readBlobs(diffs.filter((d) => !zero.test(d.oldOid) && d.oldMode !== "160000").map((d) => d.oldOid));

  const changes = diffs.map((d) => {
    const status = d.status === "A" ? "added" : d.status === "D" ? "deleted" : "modified";
    const before = zero.test(d.oldOid) ? "" : decodeText(oldBlobs.get(d.oldOid) ?? new Uint8Array());
    const after = zero.test(d.newOid) ? "" : decodeText(newBlobs.get(d.newOid) ?? new Uint8Array());
    const lines =
      before !== null && after !== null ? diffLines(before, after, 301) : { exceeded: false, addedLines: 0, removedLines: 0, addedText: "" };
    return {
      path: d.path,
      status,
      oldMode: status === "added" ? null : d.oldMode,
      newMode: status === "deleted" ? null : d.newMode,
      newType: status === "deleted" ? null : d.newMode === "160000" ? "commit" : "blob",
      sizeBytes: newBlobs.get(d.newOid)?.length ?? 0,
      isText: status === "deleted" ? before !== null : after !== null,
      addedLines: lines.exceeded ? 301 : lines.addedLines,
      removedLines: lines.exceeded ? 0 : lines.removedLines,
      addedText: lines.exceeded ? "" : lines.addedText,
      newText: status === "deleted" ? "" : (after ?? ""),
    };
  });

  const workflows = listing
    .filter((entry) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path))
    .map((entry) => ({ path: entry.path, blobSha: entry.oid, text: text(entry.oid) }));
  // Always judged blind to the cache record first. Human-reviewed, blob-pinned
  // job exclusions still apply; they cannot lift the separate cache rule.
  // §5's record is only true while
  // check:agent-pr-cache-isolation passes, and that check reads the analysis
  // taken with the record ignored -- an analysis taken with it applied reports
  // no cache reasons at all, so the condition the record rests on would look
  // satisfied because the evidence had been hidden.
  const blind = analyseCredentialReachability({ workflows, exclusions: AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS, cacheIsolationRecorded: false });
  const narrow = judgeAgentPrCacheIsolation(blind);
  const signature = cacheIsolationRecordSignature();
  // Both halves, and nothing else lifts it: the owner's signature, and the
  // condition holding against these workflows right now.
  const isolationRecorded = signature.signed && narrow.status === "judged" && narrow.held;
  const credential = isolationRecorded
    ? analyseCredentialReachability({ workflows, exclusions: AGENT_CREDENTIAL_REVIEWED_EXCLUSIONS, cacheIsolationRecorded: true })
    : blind;
  if (isolationRecorded) tally.cacheIsolationApplied += 1;
  const slice = computeControlPlaneSlice({ baseFiles, changes,
    ...(simulateTestsExcluded ? { deployExcludedPrefixes: ["tests"] } : {}),
  });
  const lock = JSON.parse(text(listing.find((entry) => entry.path === "package-lock.json")?.oid ?? "") || "{}");
  const installedVersions = Object.fromEntries(
    Object.keys(CONVENTION_VERSIONS).map((name) => [name, lock.packages?.[`node_modules/${name}`]?.version ?? null]),
  );
  const documents = baseFiles
    .filter((file) => file.path === "AGENTS.md" || /^docs\/(?:policy|ui-contracts)\//.test(file.path))
    .map((file) => file.text);

  const input = (credentialView) => ({
    changes,
    policyNamedTests: policyNamedTestPaths(documents),
    installedVersions,
    credential: credentialView,
    slice: slice.status === "analysed" ? { status: "analysed", slicePaths: slice.slicePaths } : { status: "failed" },
  });
  const credentialView =
    credential.status === "analysed"
      ? {
          status: "analysed",
          forbidsAll: credential.forbidsAll,
          forbiddenPaths: credentialForbiddenPaths(credential, changes.map((c) => c.path)),
        }
      : { status: "failed" };
  // The app refuses a listing past its limits outright, before any tier.
  const baseBlobOids = new Set(listing.map((entry) => entry.oid));
  const introduced = diffs.filter((d) => !zero.test(d.newOid) && d.newMode !== "160000" && !baseBlobOids.has(d.newOid));
  const resultEntries = treeListing(commit, true);
  const refused =
    baseEntries.length > TREE_LIMITS.maxEntries ||
    resultEntries.length > TREE_LIMITS.maxEntries ||
    introduced.length > TREE_LIMITS.maxChangedBlobs ||
    introduced.some((d) => (newBlobs.get(d.newOid)?.length ?? 0) > TREE_LIMITS.maxChangedBlobBytes);

  // What tree verification does not support sends the patch to T2, as in the app.
  const rootAttributes = listing.find((entry) => entry.path === ".gitattributes");
  const attributesText = rootAttributes === undefined ? null : decodeText(readBlobs([rootAttributes.oid]).get(rootAttributes.oid));
  const leafPaths = (entries) => entries.filter((entry) => entry.type !== "tree").map((entry) => entry.path);
  const unsupported = unsupportedTreeChanges({
    baseTruncated: false,
    basePaths: leafPaths(baseEntries),
    resultPaths: leafPaths(resultEntries),
    // Undecodable attributes are as unsupported as an unknown attribute line.
    baseGitattributes: rootAttributes !== undefined && attributesText === null ? "[unreadable]" : attributesText,
    changes: changes.map((c) => ({
      path: c.path,
      oldType: c.oldMode === null ? null : c.oldMode === "160000" ? "commit" : "blob",
      newType: c.newType,
    })),
  });
  const policyVerdict = decideTier(input(credentialView));
  const verdict =
    unsupported.length === 0
      ? policyVerdict
      : {
          tier: "T2",
          findings: [
            ...policyVerdict.findings,
            ...[...new Set(unsupported.map((u) => u.reason))].map((reason) => ({ reason: `tree_${reason}` })),
          ],
        };
  const resolved = decideTier(input({ status: "analysed", forbidsAll: false, forbiddenPaths: new Set() }));

  const withinSize =
    changes.length <= 5 && changes.reduce((sum, c) => sum + c.addedLines + c.removedLines, 0) <= 300;
  tally.total += 1;
  if (refused) {
    tally.listingRefused += 1;
    continue;
  }
  tally[verdict.tier === "T1" ? "t1" : "t2"] += 1;
  if (withinSize) {
    tally.withinSizeLimits += 1;
    if (verdict.tier === "T1") tally.t1WithinSize += 1;
  }
  if (resolved.tier === "T1" && unsupported.length === 0) tally.t1IfCredentialResolved += 1;
  for (const reason of new Set(verdict.findings.map((finding) => finding.reason))) count(reasons, reason);
}

const summary = {
  ref,
  simulatedTestsExcluded: simulateTestsExcluded,
  pullRequests: tally.total,
  t1: tally.t1,
  t2: tally.t2,
  listingRefused: tally.listingRefused,
  withinSizeLimits: tally.withinSizeLimits,
  t1WithinSizeLimits: tally.t1WithinSize,
  t1IfCredentialReachabilityResolved: tally.t1IfCredentialResolved,
  cacheIsolationRecordSigned: cacheIsolationRecordSignature().signed,
  cacheIsolationRecordProblems: cacheIsolationRecordSignature().problems,
  cacheIsolationAppliedToMerges: tally.cacheIsolationApplied,
  pullRequestsPerReason: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])),
};

if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`Engineering agent tier ratio over the last ${summary.pullRequests} merges into ${ref}`);
  console.log(`  T1 ${summary.t1} / T2 ${summary.t2} / refused before any tier ${summary.listingRefused}`);
  console.log(`  within the size limits: ${summary.withinSizeLimits} (T1 among them: ${summary.t1WithinSizeLimits})`);
  console.log(`  T1 if credential reachability were resolved: ${summary.t1IfCredentialReachabilityResolved}`);
  console.log(
    `  policy §5 cache isolation record: ${summary.cacheIsolationRecordSigned ? "signed" : "unsigned"}` +
      `${summary.cacheIsolationRecordSigned ? "" : ` (${summary.cacheIsolationRecordProblems.join(", ")})`}` +
      `, lifted the cache rule for ${summary.cacheIsolationAppliedToMerges} of these merges`,
  );
  console.log("  pull requests per reason (a PR counts once per reason):");
  for (const [reason, n] of Object.entries(summary.pullRequestsPerReason)) console.log(`    ${reason}: ${n}`);
}
