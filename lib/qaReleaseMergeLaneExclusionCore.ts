/**
 * Which develop pull requests the QA-release merge lane must leave to a person.
 *
 * docs/policy/qa-release-agent.md (version 3), section 8 item 3, is the
 * contract. A pull request listed here is never merged by the lane; it is
 * shown in Admin as human work, and the lane moves on to the next oldest
 * candidate. Every input comes from the caller -- this module reads no
 * network, file or clock -- and every uncertainty excludes.
 */
import { classifyPath, compileManifestPattern, isCanonicalRepoPath } from "./agentAuthorityFiles.ts";
import { isPolicyTestName } from "./agentPushPolicy.ts";

/**
 * Gate paths: only what a revert cannot undo or what would let an agent widen
 * its own gate (owner, 2026-10-23: "keep only the minimum"). The workflows
 * and actions hold the secrets CI runs with; the instructions and the lane's
 * own policy say what agents may do; admin auth, the system audit actors and
 * the authority manifest are the security and audit boundary. Everything else
 * -- scripts, root config other than the three below, workspace manifests and
 * configs, audit records, other policies --
 * is reversible code the lane merges like any feature; CI has already run it
 * on the pull request.
 */
export const QA_RELEASE_MERGE_LANE_GATE_PATTERNS: readonly string[] = [
  ".github/workflows/**",
  ".github/actions/**",
  // The root manifest names the scripts the operator and CI run (npm run merge-train ...);
  // the TypeScript and Next configuration decide which file an import resolves to, so a
  // path alias could swap a kept module for an unkept one (independent review, 2026-10-23).
  "package.json",
  "tsconfig*.json",
  "next.config.*",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/policy/qa-release-agent.md",
  "lib/adminAuth*",
  "lib/adminAuditSystemActors.ts",
  "lib/agentAuthorityFiles.ts",
];

/** Head branches whose own contract requires a human merge or a required review. */
export const QA_RELEASE_MERGE_LANE_EXCLUDED_BRANCH_PREFIXES: readonly string[] = [
  "agent",
  "marketing-agent",
  "feedback-autofix",
  "feedback-autofix-main",
  "autofix",
  "visual-baseline",
  "dependabot",
];

/**
 * The one exception to the `agent` prefix (owner decision 2026-11-13: "develop
 * 병합 권한은 DM에게 승인합니다. main은 안됩니다."): an engineering agent pull
 * request, head `agent/engineering/<run>`, that the app reports approved by
 * the Decision Maker with its conditions re-checked at this very head
 * (lib/amux/dmT2MergeRead.ts). Develop only; the lane never merges into main.
 */
export const QA_RELEASE_DM_APPROVED_HEAD = /^agent\/engineering\/[0-9]{1,20}$/;

/**
 * The only paths a Decision Maker approved pull request may change and still
 * be merged without a person (review r-20261113-134019-5d8f82: an allow list,
 * not a block list -- a list of what a revert cannot undo always misses one,
 * such as a deletion route's re-authentication, a spending cap or a discount
 * provider). Every changed path, both sides of a rename, must be inside it;
 * one outside leaves the whole pull request to a person. Tests, documents
 * other than policy, UI contracts and agent instructions, locale strings,
 * components, and the page, layout, loading and error files of app routes.
 * Code under lib/, every API route and everything else is a person's.
 */
export const QA_RELEASE_DM_MERGE_ALLOW_PATTERNS: readonly string[] = [
  "tests/**",
  "docs/**",
  "locales/**",
  "components/**",
  "app/**/page.tsx",
  "app/**/layout.tsx",
  "app/**/loading.tsx",
  "app/**/error.tsx",
];

/** Inside the allow list and still a person's: the policy, the UI contracts, the agent instructions, every API route. */
export const QA_RELEASE_DM_MERGE_ALLOW_EXCEPT_PATTERNS: readonly string[] = [
  "docs/policy/**",
  "docs/ui-contracts/**",
  "docs/agents/**",
  "app/api/**",
];

/**
 * Laid over the allow list, without regard to case: the gate paths above and
 * what a revert cannot undo (migrations and the schema; prices, credits and
 * the contract role's other areas; authentication and secrets; the audit
 * chain; deletion and retention). A path on it is a person's even inside the
 * allow list.
 */
export const QA_RELEASE_DM_MERGE_BLOCK_PATTERNS: readonly string[] = [
  "prisma/migrations/**",
  "prisma/schema.prisma",
  "lib/modelPricing*",
  "lib/credit*",
  "lib/chatCostGuardrails.ts",
  "lib/models.ts",
  "lib/billing*",
  "lib/planChange*",
  "app/api/billing/**",
  "lib/conversationProduct.ts",
  "lib/email*",
  "lib/auth*",
  "app/api/auth/**",
  "lib/**/*Secret*",
  "lib/adminAudit*",
  "lib/**/*SystemAudit*",
  "lib/amux/auditContract.ts",
  "lib/retention*",
  "lib/**/*Retention*",
  "lib/**/*Deletion*",
];

export type QaReleaseChangedFile = {
  path: string;
  /** Set for a rename: both sides are judged. */
  previousPath?: string | null;
  /**
   * The new text of a changed `migration.sql` under `prisma/migrations`, or
   * `null` when it could not be read. Ignored for every other path.
   */
  migrationSql?: string | null;
};

/**
 * Table names a migration must not touch unattended: this agent's own tables
 * and the shared digest table its rows live in (policy version 2, section 8
 * item 3).
 */
export const QA_RELEASE_PROTECTED_TABLE_PATTERN = /QaRelease[A-Za-z0-9_]*|AgentDigestItem/;

export const QA_RELEASE_MIGRATION_SQL_PATH = /^prisma\/migrations\/[^/]+\/migration\.sql$/;

export type QaReleaseExclusionInput = {
  headBranch: string;
  changedFiles: readonly QaReleaseChangedFile[];
  /** False when the changed-file list could not be read to its last page. */
  changedFilesComplete: boolean;
  /** `tests/**` paths named by the policy documents at the pull request's base; null when unread. */
  policyTestPaths: readonly string[] | null;
  /** This agent's own path patterns, read from the policy at the pull request's base; null when unread. */
  agentOwnPatterns: readonly string[] | null;
  /**
   * The app reports this pull request approved by the Decision Maker, its
   * conditions re-checked, at this head, into develop (QA_RELEASE_DM_APPROVED_HEAD).
   * Absent or false: the `agent` prefix leaves it to a person, as ever.
   */
  dmApproved?: boolean;
};

export type QaReleaseExclusionReason =
  | "changed_files_incomplete"
  | "changed_files_empty"
  | "inputs_unreadable"
  | "unreadable_path"
  | "gate_path"
  | "policy_test"
  | "agent_own_path"
  | "protected_table_migration"
  | "excluded_branch"
  /** A Decision Maker approved pull request that changes a path outside its merge allow list. */
  | "dm_outside_allowlist";

export type QaReleaseExclusion =
  | { excluded: false }
  | { excluded: true; reasons: QaReleaseExclusionReason[] };

const GATE_MATCHERS = QA_RELEASE_MERGE_LANE_GATE_PATTERNS.map(compileManifestPattern);
const DM_ALLOW_MATCHERS = QA_RELEASE_DM_MERGE_ALLOW_PATTERNS.map(compileManifestPattern);
const DM_ALLOW_EXCEPT_MATCHERS = QA_RELEASE_DM_MERGE_ALLOW_EXCEPT_PATTERNS
  .map((pattern) => new RegExp(compileManifestPattern(pattern).source, "i"));
const DM_BLOCK_MATCHERS = [...QA_RELEASE_MERGE_LANE_GATE_PATTERNS, ...QA_RELEASE_DM_MERGE_BLOCK_PATTERNS]
  .map((pattern) => new RegExp(compileManifestPattern(pattern).source, "i"));

/**
 * Owner decision 2026-11-14 (AMUX process audit bundle 2, AMUXFLOW/B2): a
 * Decision Maker approved pull request into develop is judged as a person's
 * session pull request is -- the lane's gate paths, the block list of what a
 * revert cannot undo, policy tests, the engineering agent's control plane --
 * instead of an allow list that left every lib/ and API change to a person.
 * The policy, UI contract and agent instruction documents stay a person's.
 * main is never in reach. Off unless
 * TOMVERSE_QA_RELEASE_DM_MERGE_BLOCK_LIST_ONLY=enabled; turning it on widens
 * what the Decision Maker merges unattended, which is the owner's call.
 */
export const QA_RELEASE_DM_MERGE_BLOCK_LIST_ONLY_ENV = "TOMVERSE_QA_RELEASE_DM_MERGE_BLOCK_LIST_ONLY";
export const qaReleaseDmMergeBlockListOnly = (
  value: string | undefined = process.env[QA_RELEASE_DM_MERGE_BLOCK_LIST_ONLY_ENV],
) => value?.trim() === "enabled";
// Every API route stays a person's even here: a user data deletion route's
// re-authentication and confirmation live there, and no name list finds them
// all (review r-20261114-073121-cf0260). So do paths that name a deletion.
const DM_DOCUMENT_GATE_MATCHERS = ["docs/policy/**", "docs/ui-contracts/**", "docs/agents/**",
  "app/api/**", "**/*delet*", "**/*purge*", "**/*erase*"]
  .map((pattern) => new RegExp(compileManifestPattern(pattern).source, "i"));

/**
 * Whether one changed path may be part of a pull request the Decision Maker
 * merges: a canonical path inside the allow list and outside its exceptions,
 * a product path in the engineering agent's authority manifest (its
 * control-plane tests, documents and components stay a person's), not a
 * policy test (by name, lib/agentPushPolicy.ts, or named by the policy
 * documents when the caller read them), and on no block list.
 */
export function qaReleaseDmMergeAllowed(path: unknown, policyTestPaths: readonly string[] = [],
  blockListOnly: boolean = qaReleaseDmMergeBlockListOnly()): boolean {
  if (!isReadablePath(path)) return false;
  if (blockListOnly) {
    // AMUXFLOW/B2: the rule a person's pull request meets, plus the
    // documents that are gates themselves.
    if (DM_DOCUMENT_GATE_MATCHERS.some((matcher) => matcher.test(path))) return false;
  } else {
    if (!DM_ALLOW_MATCHERS.some((matcher) => matcher.test(path))) return false;
    if (DM_ALLOW_EXCEPT_MATCHERS.some((matcher) => matcher.test(path))) return false;
  }
  if (classifyPath(path) !== "product") return false;
  if (isPolicyTestName(path) || policyTestPaths.includes(path)) return false;
  return !DM_BLOCK_MATCHERS.some((matcher) => matcher.test(path));
}

/**
 * A repository-relative path as Git stores it, judged by the same rule the
 * ownership manifest uses. Anything else cannot be judged against the
 * patterns and so excludes the pull request.
 */
function isReadablePath(path: unknown): path is string {
  return typeof path === "string" && isCanonicalRepoPath(path);
}

function branchExcluded(headBranch: string, dmApproved: boolean): boolean {
  if (dmApproved && QA_RELEASE_DM_APPROVED_HEAD.test(headBranch)) return false;
  return QA_RELEASE_MERGE_LANE_EXCLUDED_BRANCH_PREFIXES.some(
    (prefix) => headBranch === prefix || headBranch.startsWith(`${prefix}/`),
  );
}

/**
 * The paths of a Decision Maker approved pull request that leave it to a
 * person (qaReleaseDmMergeAllowed): outside the allow list, on a block list,
 * a policy test, or one that cannot be judged. Empty when none does.
 */
export function qaReleaseDmApprovedHumanPaths(paths: readonly unknown[], policyTestPaths: readonly string[] = []): string[] {
  return paths.flatMap((path) => qaReleaseDmMergeAllowed(path, policyTestPaths) ? [] : [String(path).slice(0, 200)]);
}

export function judgeQaReleaseMergeLaneExclusion(input: QaReleaseExclusionInput): QaReleaseExclusion {
  const reasons = new Set<QaReleaseExclusionReason>();
  const dmApproved = input.dmApproved === true;

  if (typeof input.headBranch !== "string" || input.headBranch === "" || branchExcluded(input.headBranch, dmApproved)) {
    reasons.add("excluded_branch");
  }
  // The lists the judgement depends on must be present; a missing one is not
  // an empty one.
  if (!Array.isArray(input.policyTestPaths) || !Array.isArray(input.agentOwnPatterns)) {
    reasons.add("inputs_unreadable");
  }
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : null;
  if (changedFiles === null || input.changedFilesComplete !== true) {
    reasons.add("changed_files_incomplete");
  } else if (changedFiles.length === 0) {
    reasons.add("changed_files_empty");
  }
  if (reasons.has("inputs_unreadable") || changedFiles === null || input.policyTestPaths === null || input.agentOwnPatterns === null) {
    return { excluded: true, reasons: [...reasons].sort() };
  }

  const judgeFile = fileJudge(input.policyTestPaths, input.agentOwnPatterns, dmApproved);
  for (const file of changedFiles) for (const reason of judgeFile(file)) reasons.add(reason);

  return reasons.size === 0 ? { excluded: false } : { excluded: true, reasons: [...reasons].sort() };
}

/** The per-file half of the judgement: what one changed file excludes for. */
function fileJudge(policyTestPaths: readonly string[], agentOwnPatterns: readonly string[], dmApproved = false) {
  const policyTests = new Set(policyTestPaths);
  const ownMatchers = agentOwnPatterns.map(compileManifestPattern);
  return (file: QaReleaseChangedFile): Set<QaReleaseExclusionReason> => {
    const reasons = new Set<QaReleaseExclusionReason>();
    const paths = [file.path];
    if (file.previousPath !== undefined && file.previousPath !== null) paths.push(file.previousPath);
    for (const path of paths) {
      if (!isReadablePath(path)) {
        reasons.add("unreadable_path");
        continue;
      }
      if (GATE_MATCHERS.some((matcher) => matcher.test(path))) {
        reasons.add("gate_path");
      }
      if (policyTests.has(path)) reasons.add("policy_test");
      if (ownMatchers.some((matcher) => matcher.test(path))) reasons.add("agent_own_path");
      if (dmApproved && !qaReleaseDmMergeAllowed(path, policyTestPaths)) reasons.add("dm_outside_allowlist");
    }
    if (isReadablePath(file.path) && QA_RELEASE_MIGRATION_SQL_PATH.test(file.path)) {
      if (typeof file.migrationSql !== "string" || QA_RELEASE_PROTECTED_TABLE_PATTERN.test(file.migrationSql)) {
        reasons.add("protected_table_migration");
      }
    }
    return reasons;
  };
}

/**
 * The changed files that leave a pull request to a person, with why, for the
 * Admin screen: the same per-file rule as the judgement, so the screen names
 * exactly the files the lane stopped on. Empty when the inputs were not read.
 */
export function qaReleaseMergeLaneExcludingFiles(
  input: QaReleaseExclusionInput,
  limit = 20,
): { path: string; reasons: QaReleaseExclusionReason[] }[] {
  if (!Array.isArray(input.changedFiles) || !Array.isArray(input.policyTestPaths) || !Array.isArray(input.agentOwnPatterns)) return [];
  const judgeFile = fileJudge(input.policyTestPaths, input.agentOwnPatterns, input.dmApproved === true);
  const out: { path: string; reasons: QaReleaseExclusionReason[] }[] = [];
  for (const file of input.changedFiles) {
    const reasons = judgeFile(file);
    if (reasons.size > 0) out.push({ path: String(file.path).slice(0, 200), reasons: [...reasons].sort() });
    if (out.length >= limit) break;
  }
  return out;
}
