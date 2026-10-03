/**
 * The approval check every agent policy names (docs/policy/qa-release-agent.md
 * and docs/policy/product-research-agent.md, the table under "승인 판정";
 * docs/policy/agent-operator-allowlist.md section 3 for the allowlist's own
 * changes): steps 0 to 6, judged from git and GitHub records only.
 *
 * A report, not a gate (the policies say so): every step answers pass, fail
 * or unknown, and an unknown -- a record that could not be read -- is never
 * turned into a pass. Pure: the script that gathers the records
 * (scripts/report-agent-policy-approval.mjs) passes them in.
 *
 * What this cannot prove is the allowlist's section 5: an agent session
 * commits under the operator's name, so the steps prove the procedure was
 * followed, not who followed it.
 */

export type AgentPolicyHeader = {
  approvedBy: string | null;
  approvedAt: string | null;
  version: number | null;
  allowlistGenesisCommit: string | null;
};

/** A pull request as GitHub records it; null fields were not readable. */
export type AgentPolicyPullRequest = {
  number: number;
  baseRef: string;
  headRef: string;
  mergedBy: string | null;
  mergedAt: string | null;
  changedFiles: readonly string[] | null;
  commitAuthors: readonly { login: string | null; type: string | null }[] | null;
  /** The base commit the PR was merged onto. */
  baseSha: string | null;
};

/** One change of the allowlist file between its genesis and the policy PR's base. */
export type AllowlistChange = {
  commit: string;
  /** The allowlist's accounts and version before and after this commit. */
  before: { accounts: readonly string[]; version: number | null } | null;
  after: { accounts: readonly string[]; version: number | null };
  /** The PRs that brought this commit into develop, or null if unread. */
  pullRequests: readonly AgentPolicyPullRequest[] | null;
};

export type AgentPolicyApprovalFacts = {
  policyPath: string;
  header: AgentPolicyHeader;
  /**
   * The previous approved version, read on develop just before the policy PR
   * merged (previousApprovedPolicyVersion): a number, "new" when the file was
   * absent there or was a draft naming neither approver nor version, or
   * "unknown" when it could not be read or named an approver without a
   * readable version.
   */
  previousVersion: number | "new" | "unknown";
  /** The last commit that changed the policy file. */
  lastChangeCommit: string | null;
  /** The PRs merged into develop that contain that commit, or null if unread. */
  pullRequests: readonly AgentPolicyPullRequest[] | null;
  allowlist: {
    /** The file's first commit, from git. */
    firstCommit: string | null;
    /** Accounts listed in the allowlist at the policy PR's base, or null if unread. */
    accountsAtBase: readonly string[] | null;
    /** Every allowlist change after its first commit up to that base, or null if unread. */
    changes: readonly AllowlistChange[] | null;
    /**
     * The PRs that brought the first commit in. A later commit merged by that
     * same PR is part of the genesis the operator stamped (allowlist section
     * 4), not a change section 3 judges.
     */
    genesisPullRequests: readonly AgentPolicyPullRequest[] | null;
  };
};

export type AgentPolicyApprovalStep = {
  step: "0" | "0a" | "1" | "2" | "3" | "4" | "5" | "6";
  result: "pass" | "fail" | "unknown";
  reason: string;
};

const pass = (step: AgentPolicyApprovalStep["step"], reason: string): AgentPolicyApprovalStep => ({ step, result: "pass", reason });
const fail = (step: AgentPolicyApprovalStep["step"], reason: string): AgentPolicyApprovalStep => ({ step, result: "fail", reason });
const unknown = (step: AgentPolicyApprovalStep["step"], reason: string): AgentPolicyApprovalStep => ({ step, result: "unknown", reason });

/** `to-develop` as a path segment of the branch name (AGENTS.md, branch names). */
export const hasToDevelopSegment = (branch: string): boolean => branch.split("/").includes("to-develop");

const isBot = (author: { login: string | null; type: string | null }) =>
  author.type === "Bot" || (author.login ?? "").endsWith("[bot]");

/** Reads the header lines every agent policy file carries. */
export function parseAgentPolicyHeader(text: string): AgentPolicyHeader {
  const approvedBy = /approvedBy:\s*([A-Za-z0-9-]+)/.exec(text)?.[1] ?? null;
  const approvedAt = /approvedAt:\s*(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
  // Written as `2` in one policy and `v1` in another.
  const version = /정책 버전:\s*v?(\d+)/.exec(text)?.[1];
  const genesis = /allowlistGenesisCommit:\s*([0-9a-f]{40})/.exec(text)?.[1] ?? null;
  return { approvedBy, approvedAt, version: version === undefined ? null : Number(version), allowlistGenesisCommit: genesis };
}

/**
 * The previous approved version, from the policy file as develop held it just
 * before the policy PR merged (the caller reads that tree). Absent there, or a
 * draft that names neither an approver nor a version, is "new". A file that
 * names an approver but no readable version is an unread record: "unknown",
 * never a first approval. `text` null means git could not answer.
 */
export function previousApprovedPolicyVersion(
  before: { present: false } | { present: true; text: string | null },
): number | "new" | "unknown" {
  if (!before.present) return "new";
  if (before.text === null) return "unknown";
  const header = parseAgentPolicyHeader(before.text);
  if (header.version !== null) return header.version;
  return header.approvedBy === null ? "new" : "unknown";
}

/** The accounts and version of the allowlist file's text. */
export function parseAllowlist(text: string): { accounts: string[]; version: number | null } {
  const section = text.split(/^## 2\./m)[1]?.split(/^## /m)[0] ?? "";
  const accounts = [...section.matchAll(/^\|\s*`([A-Za-z0-9-]+)`\s*\|/gm)].map((match) => match[1]);
  const version = /^version:\s*(\d+)/m.exec(text)?.[1];
  return { accounts, version: version === undefined ? null : Number(version) };
}

/** The one PR into develop, or why there is not exactly one. */
function onlyDevelopPullRequest(
  pullRequests: readonly AgentPolicyPullRequest[] | null,
): { pr: AgentPolicyPullRequest } | { reason: string; unknown: boolean } {
  if (pullRequests === null) return { reason: "pull requests could not be read", unknown: true };
  const intoDevelop = pullRequests.filter((pr) => pr.baseRef === "develop" && pr.mergedAt !== null);
  if (intoDevelop.length !== 1) return { reason: `${intoDevelop.length} merged pull requests into develop`, unknown: false };
  return { pr: intoDevelop[0] };
}

function judgeAllowlistChange(change: AllowlistChange, allowlistPath: string): string | null {
  if (change.before === null) return `${change.commit}: the list before it could not be read`;
  if (change.after.version === null || change.before.version === null || change.after.version <= change.before.version) {
    return `${change.commit}: version did not increase`;
  }
  const only = onlyDevelopPullRequest(change.pullRequests);
  if (!("pr" in only)) return `${change.commit}: ${only.reason}`;
  const { pr } = only;
  if (pr.changedFiles === null || pr.changedFiles.length !== 1 || pr.changedFiles[0] !== allowlistPath) {
    return `${change.commit}: its pull request #${pr.number} changed more than the allowlist`;
  }
  if (hasToDevelopSegment(pr.headRef)) return `${change.commit}: branch ${pr.headRef} carries to-develop`;
  if (pr.mergedBy === null || !change.before.accounts.includes(pr.mergedBy)) {
    return `${change.commit}: merged by an account not on the list before it`;
  }
  return null;
}

export const AGENT_OPERATOR_ALLOWLIST_PATH = "docs/policy/agent-operator-allowlist.md";

export function judgeAgentPolicyApproval(facts: AgentPolicyApprovalFacts): AgentPolicyApprovalStep[] {
  const { header } = facts;
  const steps: AgentPolicyApprovalStep[] = [];
  const only = onlyDevelopPullRequest(facts.pullRequests);
  const pr = "pr" in only ? only.pr : null;

  // 0: the approver is on the allowlist at the PR's base, the allowlist's
  // first commit is the named genesis, and every later change kept section 3.
  if (header.approvedBy === null || header.allowlistGenesisCommit === null) {
    steps.push(fail("0", "approvedBy or allowlistGenesisCommit is missing"));
  } else if (
    facts.allowlist.firstCommit === null ||
    facts.allowlist.accountsAtBase === null ||
    facts.allowlist.changes === null ||
    facts.allowlist.genesisPullRequests === null
  ) {
    steps.push(unknown("0", "the allowlist's history could not be read"));
  } else if (facts.allowlist.firstCommit !== header.allowlistGenesisCommit) {
    steps.push(fail("0", "the allowlist's first commit is not the named genesis"));
  } else if (!facts.allowlist.accountsAtBase.includes(header.approvedBy)) {
    steps.push(fail("0", `${header.approvedBy} is not on the allowlist at the pull request's base`));
  } else {
    const genesis = onlyDevelopPullRequest(facts.allowlist.genesisPullRequests);
    const genesisNumber = "pr" in genesis ? genesis.pr.number : null;
    const later = facts.allowlist.changes.filter((change) => {
      const own = onlyDevelopPullRequest(change.pullRequests);
      return !("pr" in own) || own.pr.number !== genesisNumber;
    });
    const broken = later
      .map((change) => judgeAllowlistChange(change, AGENT_OPERATOR_ALLOWLIST_PATH))
      .filter((reason): reason is string => reason !== null);
    steps.push(
      broken.length === 0
        ? pass("0", `${header.approvedBy} is listed; ${later.length} later allowlist change(s) kept section 3`)
        : fail("0", broken.join("; ")),
    );
  }

  // 0a: the header is filled and the version moved up.
  if (header.approvedBy === null || header.approvedAt === null || header.version === null) {
    steps.push(fail("0a", "approvedBy, approvedAt or the policy version is missing"));
  } else if (facts.previousVersion === "unknown") {
    steps.push(unknown("0a", "the previous version could not be read"));
  } else if (facts.previousVersion !== "new" && header.version <= facts.previousVersion) {
    steps.push(fail("0a", `version ${header.version} is not above the previous ${facts.previousVersion}`));
  } else {
    steps.push(pass("0a", `version ${header.version}${facts.previousVersion === "new" ? " (first)" : ` above ${facts.previousVersion}`}`));
  }

  // 1: the last change.
  steps.push(
    facts.lastChangeCommit === null
      ? unknown("1", "the last change could not be found")
      : pass("1", facts.lastChangeCommit),
  );

  // 2: exactly one PR brought it into develop.
  if (pr) steps.push(pass("2", `#${pr.number}`));
  else if ("unknown" in only && only.unknown) steps.push(unknown("2", only.reason));
  else steps.push(fail("2", "reason" in only ? only.reason : "no pull request"));

  // 3 to 6 need that PR.
  if (!pr) {
    for (const step of ["3", "4", "5", "6"] as const) steps.push(unknown(step, "no single pull request to judge"));
    return steps;
  }
  steps.push(hasToDevelopSegment(pr.headRef) ? fail("3", `branch ${pr.headRef} carries to-develop`) : pass("3", pr.headRef));

  if (pr.mergedBy === null) steps.push(unknown("4", "the merger could not be read"));
  else steps.push(pr.mergedBy === header.approvedBy ? pass("4", pr.mergedBy) : fail("4", `merged by ${pr.mergedBy}`));

  const mergedOn = pr.mergedAt?.slice(0, 10) ?? null;
  if (mergedOn === null) steps.push(unknown("5", "the merge time could not be read"));
  else steps.push(mergedOn === header.approvedAt ? pass("5", mergedOn) : fail("5", `merged ${mergedOn}, approvedAt ${header.approvedAt}`));

  if (pr.changedFiles === null || pr.commitAuthors === null) {
    steps.push(unknown("6", "the pull request's files or commits could not be read"));
  } else if (pr.changedFiles.length !== 1 || pr.changedFiles[0] !== facts.policyPath) {
    steps.push(fail("6", `the pull request changed ${pr.changedFiles.length} file(s), not only ${facts.policyPath}`));
  } else if (pr.commitAuthors.some(isBot)) {
    steps.push(fail("6", "a commit was written by a bot"));
  } else if (pr.commitAuthors.some((author) => author.login !== header.approvedBy)) {
    steps.push(fail("6", "a commit author is not the approver"));
  } else {
    steps.push(pass("6", `${pr.commitAuthors.length} commit(s) by ${header.approvedBy}`));
  }
  return steps;
}
