// Reports the approval check an agent policy names (steps 0 to 6 of the
// "승인 판정" table) from git and GitHub records only.
//
//   npm run report:agent-policy-approval -- --policy docs/policy/qa-release-agent.md
//   npm run report:agent-policy-approval -- --policy <path> --ref origin/develop --json
//
// A report, not a gate: it always exits 0 once it has judged, and a record it
// could not read is reported as unknown rather than passed. GitHub facts (the
// pull request, its merger, files and commit authors) need GITHUB_TOKEN or
// GH_TOKEN with read access; without one those steps read unknown. It writes
// nothing anywhere. Judgement: lib/agentPolicyApprovalCore.ts.

import { execFileSync } from "node:child_process";

import {
  AGENT_OPERATOR_ALLOWLIST_PATH,
  judgeAgentPolicyApproval,
  parseAgentPolicyHeader,
  parseAllowlist,
  previousApprovedPolicyVersion,
} from "../lib/agentPolicyApprovalCore.ts";

const REPOSITORY = "mposition/Tomverse";

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const policyPath = option("--policy");
const ref = option("--ref", "origin/develop");
const asJson = args.includes("--json");
if (!policyPath || !/^docs\/policy\/[a-z0-9-]+\.md$/.test(policyPath)) {
  console.error("Usage: --policy docs/policy/<agent>.md [--ref <git ref>] [--json]");
  process.exit(1);
}

const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOrNull = (...gitArgs) => {
  try {
    return git(...gitArgs);
  } catch {
    return null;
  }
};

/** Whether a git command exits 0 -- for questions answered by the exit code. */
const gitSucceeds = (...gitArgs) => gitOrNull(...gitArgs) !== null;

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

/** Every page of a GitHub list, or null when anything could not be read. */
const githubList = async (path) => {
  if (!token) return null;
  const items = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!response?.ok) return null;
    const body = await response.json();
    if (!Array.isArray(body)) return null;
    items.push(...body);
    if (body.length < 100) return items;
  }
  return null;
};

const githubObject = async (path) => {
  if (!token) return null;
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  return response?.ok ? response.json() : null;
};

/** The merged pull requests that contain a commit, with what the steps read. */
const pullRequestsFor = async (commit) => {
  const listed = await githubList(`/repos/${REPOSITORY}/commits/${commit}/pulls`);
  if (listed === null) return null;
  const result = [];
  for (const entry of listed) {
    const detail = await githubObject(`/repos/${REPOSITORY}/pulls/${entry.number}`);
    const files = await githubList(`/repos/${REPOSITORY}/pulls/${entry.number}/files`);
    const commits = await githubList(`/repos/${REPOSITORY}/pulls/${entry.number}/commits`);
    result.push({
      number: entry.number,
      baseRef: entry.base?.ref ?? "",
      headRef: entry.head?.ref ?? "",
      mergedBy: detail?.merged_by?.login ?? null,
      mergedAt: detail?.merged_at ?? null,
      changedFiles: files === null ? null : files.map((file) => file.filename),
      commitAuthors: commits === null ? null : commits.map((c) => ({ login: c.author?.login ?? null, type: c.author?.type ?? null })),
      baseSha: detail?.base?.sha ?? null,
      mergeCommitSha: detail?.merge_commit_sha ?? null,
    });
  }
  return result;
};

const policyText = gitOrNull("show", `${ref}:${policyPath}`);
if (policyText === null) {
  console.error(`${policyPath} is not on ${ref}.`);
  process.exit(1);
}
const header = parseAgentPolicyHeader(policyText);
const lastChangeCommit = gitOrNull("log", "-1", "--format=%H", ref, "--", policyPath) || null;
const pullRequests = lastChangeCommit ? await pullRequestsFor(lastChangeCommit) : null;
const mergedIntoDevelop = pullRequests?.filter((pr) => pr.baseRef === "develop" && pr.mergedAt) ?? [];
// The previous approved version is what develop held just before the policy
// PR merged -- the first parent of its merge commit -- not the parent of the
// PR's last commit, which in a multi-commit PR is one of its own drafts.
// A merge commit not on the ref, or anything git cannot answer, is
// "unknown"; what the file says there is previousApprovedPolicyVersion's call.
const previousVersion = (() => {
  const mergeCommit = mergedIntoDevelop.length === 1 ? mergedIntoDevelop[0].mergeCommitSha : null;
  if (!mergeCommit) return "unknown";
  // Squash and rebase merges leave a merge_commit_sha that need not be on the
  // ref; an older tree there would read an older version. Only a merge commit
  // in the ref's history is develop as it stood before the merge.
  if (!gitSucceeds("merge-base", "--is-ancestor", mergeCommit, ref)) return "unknown";
  // A root commit has no parent, so the file was new there.
  const parents = gitOrNull("rev-list", "--parents", "-n", "1", mergeCommit);
  if (parents === null) return "unknown";
  if (parents.split(" ").length === 1) return previousApprovedPolicyVersion({ present: false });
  const listed = gitOrNull("ls-tree", "--name-only", `${mergeCommit}^1`, "--", policyPath);
  if (listed === null) return "unknown";
  if (listed === "") return previousApprovedPolicyVersion({ present: false });
  return previousApprovedPolicyVersion({ present: true, text: gitOrNull("show", `${mergeCommit}^1:${policyPath}`) });
})();

const developPr = mergedIntoDevelop;
const baseSha = developPr.length === 1 ? developPr[0].baseSha : null;
const firstCommit = (gitOrNull("log", "--diff-filter=A", "--format=%H", ref, "--", AGENT_OPERATOR_ALLOWLIST_PATH) ?? "")
  .split("\n")
  .filter(Boolean)
  .pop() ?? null;
const allowlistAt = (commit) => {
  const text = gitOrNull("show", `${commit}:${AGENT_OPERATOR_ALLOWLIST_PATH}`);
  return text === null ? null : parseAllowlist(text);
};

let changes = null;
let accountsAtBase = null;
if (baseSha && firstCommit) {
  accountsAtBase = allowlistAt(baseSha)?.accounts ?? null;
  const commits = gitOrNull("log", "--reverse", "--format=%H", `${firstCommit}..${baseSha}`, "--", AGENT_OPERATOR_ALLOWLIST_PATH);
  if (commits !== null) {
    changes = [];
    for (const commit of commits.split("\n").filter(Boolean)) {
      const after = allowlistAt(commit);
      if (after === null) {
        changes = null;
        break;
      }
      changes.push({ commit, before: allowlistAt(`${commit}^`), after, pullRequests: await pullRequestsFor(commit) });
    }
  }
}

const steps = judgeAgentPolicyApproval({
  policyPath,
  header,
  previousVersion,
  lastChangeCommit,
  pullRequests,
  allowlist: {
    firstCommit,
    accountsAtBase,
    changes,
    genesisPullRequests: firstCommit ? await pullRequestsFor(firstCommit) : null,
  },
});

if (asJson) {
  console.log(JSON.stringify({ policyPath, ref, header, steps }, null, 2));
} else {
  console.log(`${policyPath} at ${ref} (version ${header.version ?? "?"}, approvedBy ${header.approvedBy ?? "?"}, approvedAt ${header.approvedAt ?? "?"})`);
  for (const step of steps) console.log(`  ${step.step.padEnd(3)} ${step.result.padEnd(8)} ${step.reason}`);
  if (!token) console.log("  (no GITHUB_TOKEN or GH_TOKEN: the pull request steps read unknown)");
  console.log("A report, not a gate: it proves the procedure was followed, not who followed it (allowlist section 5).");
}
