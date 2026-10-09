// Runs the docs/policy/trust-safety-compliance-agent.md §2 approval judgement of
// `docs/policy/trust-safety-compliance-agent.md` and prints the manifest that
// section requires.
//
// See scripts/report-trust-safety-policy-approval-core.mjs for why this exists,
// the three readings that decide the verdict, and what the manifest must never
// contain. This file only reads git and GitHub; it writes nothing.
//
// Where to run it: the operator's local PowerShell, inside a clone of this
// repository. It needs `gh` authenticated for reads. **No production
// credentials, and nothing is written** -- not the policy, not the allowlist,
// not a registry.
//
// Usage:
//   npm run report:trust-safety-policy-approval
//   npm run report:trust-safety-policy-approval -- --json
//
// A verdict is evidence an operator signs under §12 (4). It is not a merge
// condition, and this script is not a gate.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  changedTheFile,
  isEvilMerge,
  judgeTrustSafetyPolicyApproval,
  readAllOrNothing,
  versionEntryOf,
} from "./report-trust-safety-policy-approval-core.mjs";

const POLICY_PATH = "docs/policy/trust-safety-compliance-agent.md";
const ALLOWLIST_PATH = "docs/policy/agent-operator-allowlist.md";
const DEFAULT_BRANCH = "origin/develop";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
// docs/policy/trust-safety-compliance-agent.md §2 asks for this judgement twice: before stage 1 merges anything, and on every
// re-approval. The first of those is about a ref that is not yet develop, so the
// ref is an argument -- and a ref that cannot be read is how the fail-closed
// path is exercised for real rather than asserted.
const branchIndex = args.indexOf("--branch");
const BRANCH = branchIndex >= 0 ? args[branchIndex + 1] : DEFAULT_BRANCH;
if (branchIndex >= 0 && !BRANCH) {
  console.error("--branch needs a revision");
  process.exit(2);
}

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, stderr: (result.stderr ?? String(result.error ?? "")).trim() };
  }
  return { ok: true, stdout: result.stdout };
};

const git = (...commandArgs) => run("git", commandArgs);

/**
 * `gh` is read-only here. A failure returns undefined rather than a guess: docs/policy/trust-safety-compliance-agent.md §2
 * treats a fact it cannot read as unmet, and the core says so for each step.
 */
const gh = (...commandArgs) => {
  const result = run("gh", commandArgs);
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
};

/**
 * A path at a revision: present with a blob, genuinely absent, or unreadable.
 *
 * These three are not interchangeable, and an earlier draft collapsed the last
 * two. A file that does not exist yet at some commit is an ordinary fact -- the
 * policy had a first commit. A read that failed is docs/policy/trust-safety-compliance-agent.md §2's "could not read", which
 * it calls unmet. Turning the second into the first let a version the reader
 * never opened drop out of V_max.
 *
 * `git rev-parse <rev>:<path>` fails for both cases, so the two are separated
 * by asking the tree whether the entry is there at all.
 */
const entryAt = (rev, path) => {
  const listed = git("ls-tree", "--format=%(objectname)", rev, "--", path);
  if (!listed.ok) return { state: "unreadable" };
  const blob = listed.stdout.trim();
  if (blob === "") return { state: "absent" };
  return { state: "present", blob };
};

const blobOf = (rev, path) => {
  const entry = entryAt(rev, path);
  return entry.state === "present" ? entry.blob : undefined;
};

/** The text at a revision, with absence and failure kept apart. */
const readAt = (rev, path) => {
  const entry = entryAt(rev, path);
  if (entry.state !== "present") return entry;
  const result = git("show", `${rev}:${path}`);
  if (!result.ok) return { state: "unreadable" };
  return { state: "present", text: result.stdout };
};

const fileAt = (rev, path) => {
  const read = readAt(rev, path);
  return read.state === "present" ? read.text : undefined;
};

/** The header line's three fields, read from the one line that holds them. */
const headerFields = (text) => {
  if (text === undefined) return undefined;
  const line = text.split(/\r?\n/).find((candidate) => /^version:\s/.test(candidate));
  if (!line) return {};
  const read = (key) => {
    const match = new RegExp(`${key}:\\s*([^·\\n]+)`).exec(line);
    return match ? match[1].trim() : undefined;
  };
  return { version: read("version"), approvedBy: read("approvedBy"), approvedAt: read("approvedAt") };
};

const declaredGenesis = (text) => {
  if (text === undefined) return undefined;
  const match = /^allowlistGenesisCommit:\s*([0-9a-f]{7,40})\s*$/m.exec(text);
  return match ? match[1] : undefined;
};

/**
 * The version in the last row of the header's version history table. §0a reads
 * the last row specifically, because a revision appends there.
 *
 * Scoped to that one table, found by its own header row. Reading every table in
 * the document instead returned 1 while the header said 2: §12's tables also
 * start their rows with an integer, and the document's last such row is not
 * this table's last row.
 */
const lastHistoryRowVersion = (text) => {
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^\|\s*버전\s*\|/.test(line));
  if (headerIndex < 0) return undefined;
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\|/.test(line)) break;
    if (/^\|\s*-+/.test(line)) continue;
    rows.push(line.split("|").map((cell) => cell.trim()));
  }
  if (rows.length === 0) return undefined;
  return rows[rows.length - 1][1];
};

/** The accounts the allowlist's table names, read from its first column. */
const allowlistApprovers = (text) => {
  if (text === undefined) return undefined;
  return text
    .split(/\r?\n/)
    .filter((line) => /^\|\s*`[^`]+`\s*\|/.test(line))
    .map((line) => /^\|\s*`([^`]+)`/.exec(line)?.[1])
    .filter(Boolean);
};

const commitsTouching = (rev, path) => {
  const result = git("log", "--full-history", "--format=%H", rev, "--", path);
  if (!result.ok) return undefined;
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
};

const parentsOf = (sha) => {
  const result = git("rev-list", "--parents", "-n", "1", sha);
  if (!result.ok) return undefined;
  return result.stdout.trim().split(/\s+/).slice(1);
};

const commitWithParents = (sha, path) => ({
  sha,
  blob: blobOf(sha, path),
  parents: (parentsOf(sha) ?? []).map((parent) => ({ sha: parent, blob: blobOf(parent, path) })),
});

/**
 * The pull request that **put** this commit into develop -- not every pull
 * request whose history contains it.
 *
 * `commits/{sha}/pulls` answers the second question. Run on 2026-10-07 for the
 * commit that approved version 2, it returned four: the one that merged it and
 * three still open, branched off develop afterwards. A judgement made by hand
 * the same morning saw only one, because those three did not exist yet -- it was
 * right by timing. So the rows are narrowed to pull requests merged into
 * develop whose **own** commit list holds the commit.
 */
const pullRequestsFor = (sha) => {
  const rows = gh(
    "api",
    `repos/{owner}/{repo}/commits/${sha}/pulls`,
    "--jq",
    "[.[] | {number, base: .base.ref, merged: (.merged_at != null)}]",
  );
  if (rows === undefined) return undefined;
  const candidates = rows.filter((row) => row.base === "develop" && row.merged);
  const introduced = [];
  for (const row of candidates) {
    const own = gh("pr", "view", String(row.number), "--json", "commits", "--jq", "[.commits[].oid]");
    if (own === undefined) return undefined;
    if (own.includes(sha)) introduced.push({ number: row.number, base: row.base });
  }
  return introduced;
};

const identityOf = (sha) => {
  const result = git("log", "-1", "--format=%an%x1f%ae%x1f%cn%x1f%ce", sha);
  if (!result.ok) return undefined;
  const [authorName, authorEmail, committerName, committerEmail] = result.stdout.trim().split("\u001f");
  return {
    sha,
    author: { name: authorName, email: authorEmail },
    committer: { name: committerName, email: committerEmail },
  };
};

/** A pull request's own commits -- never the merge commit GitHub creates. */
const pullRequestFacts = (number) => {
  const view = gh(
    "pr",
    "view",
    String(number),
    "--json",
    "number,headRefName,mergedAt,mergedBy,mergeCommit,files,commits",
    "--jq",
    "{number, headRef: .headRefName, mergedAt, mergedBy: .mergedBy.login, merge: .mergeCommit.oid, files: [.files[].path], commits: [.commits[].oid]}",
  );
  if (view === undefined) return undefined;
  // `--jq .type` prints a bare `User`, which is not JSON: parsing it failed and
  // step 4 reported the account type as unreadable while GitHub had answered.
  // Ask for an object so the reply is always JSON.
  const account =
    view.mergedBy === undefined || view.mergedBy === null
      ? undefined
      : gh("api", `users/${view.mergedBy}`, "--jq", "{type: .type}");
  const type = account?.type;
  return {
    number: view.number,
    headRef: view.headRef,
    mergeCommit: view.merge,
    baseSha: view.merge ? git("rev-parse", `${view.merge}^1`).stdout?.trim() : undefined,
    mergedAtIso: view.mergedAt ?? undefined,
    mergedAtUtcDate: view.mergedAt ? String(view.mergedAt).slice(0, 10) : undefined,
    mergedBy: view.mergedBy ? { login: view.mergedBy, type: type ?? "unreadable" } : undefined,
    files: view.files,
    // One commit whose object is not local makes the whole observation
    // unreadable. Dropping it would leave its author unchecked, and dropping
    // every one would leave an empty array that `every()` calls true.
    commits: readAllOrNothing(view.commits, identityOf),
  };
};

// --- gather -------------------------------------------------------------

const policyText = fileAt(BRANCH, POLICY_PATH);
const header = headerFields(policyText);

const policyTouching = commitsTouching(BRANCH, POLICY_PATH);
const policyChanging = policyTouching?.filter((sha) =>
  changedTheFile(commitWithParents(sha, POLICY_PATH)),
);
const lastChangeCommit = policyChanging?.[0];

const containing = lastChangeCommit ? pullRequestsFor(lastChangeCommit) : undefined;
const approvalPr = containing?.length === 1 ? pullRequestFacts(containing[0].number) : undefined;
const base = approvalPr?.baseSha;

const reachablePolicyCommits = base ? commitsTouching(base, POLICY_PATH) : undefined;
const policyCommitsReachableFromBase = reachablePolicyCommits?.map((sha) =>
  // Absent is an ordinary fact with no version; unreadable is not.
  versionEntryOf(sha, readAt(sha, POLICY_PATH), (text) => headerFields(text)?.version),
);

const allowlistTextAtBase = base ? fileAt(base, ALLOWLIST_PATH) : undefined;
const allowlistTouching = base ? commitsTouching(base, ALLOWLIST_PATH) : undefined;
const allowlistCommits = allowlistTouching?.map((sha) => commitWithParents(sha, ALLOWLIST_PATH));
const allowlistChanging = allowlistCommits?.filter(changedTheFile);
const allowlistCarrying = allowlistCommits
  ?.filter((commit) => !changedTheFile(commit))
  .map((commit) => commit.sha);

const observedAllowlistGenesis = allowlistChanging?.length
  ? allowlistChanging[allowlistChanging.length - 1].sha
  : undefined;

const allowlistChanges = allowlistChanging?.map((commit) => {
  const prs = pullRequestsFor(commit.sha);
  return {
    sha: commit.sha,
    prNumbers: prs?.map((pr) => pr.number),
    evilMerge: isEvilMerge(commit),
  };
});

const allowlistPrNumbers = allowlistChanges
  ? [...new Set(allowlistChanges.flatMap((change) => change.prNumbers ?? []))]
  : undefined;
const genesisPrNumber = allowlistChanges?.find((change) => change.sha === observedAllowlistGenesis)
  ?.prNumbers?.[0];

const allowlistPrs = allowlistPrNumbers?.map((number) => {
  const facts = pullRequestFacts(number);
  if (facts === undefined) return { number };
  const ownChanges = allowlistChanges.filter((change) => (change.prNumbers ?? []).includes(number));
  const mergeText = facts.mergeCommit ? fileAt(facts.mergeCommit, ALLOWLIST_PATH) : undefined;
  const baseText = facts.baseSha ? fileAt(facts.baseSha, ALLOWLIST_PATH) : undefined;
  const baseList = allowlistApprovers(baseText);
  const mergeHeader = headerFields(mergeText);
  return {
    ...facts,
    commitPrCounts: ownChanges.map((change) => (change.prNumbers ?? []).length),
    // Items 2 and 3 compare against the approver the allowlist named at this
    // pull request's own merge, never today's.
    approvedByAtMerge: mergeHeader?.approvedBy,
    approvedAtAtMerge: mergeHeader?.approvedAt,
    baseVersion: headerFields(baseText)?.version,
    mergeVersion: headerFields(mergeText)?.version,
    baseListApprovers: baseList,
    approverWasOnBaseList:
      baseList === undefined || facts.mergedBy === undefined
        ? undefined
        : baseList.includes(facts.mergedBy.login),
  };
});

const laterTouching = approvalPr?.mergeCommit
  ? commitsTouching(`${approvalPr.mergeCommit}..${BRANCH}`, POLICY_PATH)
  : undefined;
const policyChangesAfterMerge = laterTouching?.filter((sha) =>
  changedTheFile(commitWithParents(sha, POLICY_PATH)),
);

const allowlistApproversAtBase = allowlistApprovers(allowlistTextAtBase);

const report = judgeTrustSafetyPolicyApproval({
  policyPath: POLICY_PATH,
  allowlistPath: ALLOWLIST_PATH,
  header,
  declaredGenesisCommit: declaredGenesis(policyText),
  historyLastRowVersion: lastHistoryRowVersion(policyText),
  lastChangeCommit,
  pullRequestsContainingLastChange: containing,
  approvalPr,
  policyCommitsReachableFromBase,
  policyChangesAfterMerge,
  observedAllowlistGenesis,
  allowlistApproversAtBase,
  approverOnAllowlistAtBase:
    allowlistApproversAtBase === undefined || header?.approvedBy === undefined
      ? undefined
      : allowlistApproversAtBase.includes(header.approvedBy),
  allowlistChanges,
  allowlistCarryingMerges: allowlistCarrying ?? [],
  allowlistPrs,
  genesisPrNumber,
});

// --- print --------------------------------------------------------------

// The exit code exists so a verdict cannot be missed from a shell, and --json
// is the form somebody scripts, so the rule cannot live on one path only.
const exitCode = report.verdict === "approved" ? 0 : 1;

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
}

const mark = (met) => (met === true ? "pass" : met === false ? "FAIL" : met === "skipped" ? "skip" : "????");

console.log(`docs/policy/trust-safety-compliance-agent.md §2 approval judgement of ${POLICY_PATH}`);
console.log(`read from ${BRANCH}\n`);
if (report.verdict !== "approved") {
  console.log(
    report.verdict === "unreadable"
      ? "Something needed could not be read. docs/policy/trust-safety-compliance-agent.md §2 calls that unmet, not unknown.\n"
      : "",
  );
}

for (const entry of report.steps) {
  console.log(`[${mark(entry.met)}] ${entry.id}. ${entry.title}`);
  console.log(`       ${entry.because}`);
  for (const sub of entry.conditions ?? entry.checks ?? []) {
    console.log(`  [${mark(sub.met)}] ${sub.id} ${sub.title}`);
    console.log(`         ${sub.because}`);
    for (const pr of sub.pullRequests ?? []) {
      console.log(`    [${mark(pr.met)}] pull request #${pr.number}${pr.genesis ? " (genesis)" : ""}`);
      for (const item of pr.items) {
        console.log(`      [${mark(item.met)}] ${item.id} ${item.title}`);
        console.log(`             ${item.because}`);
      }
    }
    if (sub.vMaxHolders) {
      console.log(`         V_max ${sub.vMax ?? "(none)"} held by ${sub.vMaxHolders.join(", ") || "(no commit)"}`);
    }
  }
  console.log("");
}

console.log(`verdict: ${report.verdict}`);
console.log("\nnotes");
for (const note of report.manifest.notes) console.log(`  - ${note}`);
console.log("\nnot in this report, on purpose");
for (const omission of report.manifest.omitted) console.log(`  - ${omission}`);
console.log("\nA person runs this and signs the verdict (§12 (4)). Nothing here was written.");

// A non-zero exit so a verdict that is not an approval cannot be missed by
// someone running this from a shell. It remains a report: no workflow consumes
// this code, and §12 (4) is where the signature happens.
process.exit(exitCode);
