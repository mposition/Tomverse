/**
 * Which develop pull requests the QA-release merge lane must leave to a person.
 *
 * docs/policy/qa-release-agent.md (version 3), section 8 item 3, is the
 * contract. A pull request listed here is never merged by the lane; it is
 * shown in Admin as human work, and the lane moves on to the next oldest
 * candidate. Every input comes from the caller -- this module reads no
 * network, file or clock -- and every uncertainty excludes.
 */
import { compileManifestPattern, isCanonicalRepoPath } from "./agentAuthorityFiles.ts";

/** Gate paths: the checks, their runners and the documents that define them. */
export const QA_RELEASE_MERGE_LANE_GATE_PATTERNS: readonly string[] = [
  ".github/**",
  "scripts/**",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/policy/**",
  "docs/ui-contracts/**",
  "docs/release-gates/**",
  "lib/adminAuth*",
  "lib/adminAuditSystemActors.ts",
  "lib/agentAuthorityFiles.ts",
];

/**
 * File names that are gate files wherever they sit (policy version 3): npm
 * reads every workspace's manifest and runs its install scripts during
 * `npm ci`, and an `.npmrc` anywhere in the tree can change what is fetched.
 * Compared without case, because a case-insensitive checkout reads
 * `Package.json` as the same file.
 */
export const QA_RELEASE_MERGE_LANE_GATE_FILE_NAMES: readonly string[] = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  ".npmrc",
];

const GATE_FILE_NAMES = new Set(QA_RELEASE_MERGE_LANE_GATE_FILE_NAMES);

const isGateFileName = (path: string): boolean =>
  GATE_FILE_NAMES.has(path.slice(path.lastIndexOf("/") + 1).toLowerCase());

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
  | "excluded_branch";

export type QaReleaseExclusion =
  | { excluded: false }
  | { excluded: true; reasons: QaReleaseExclusionReason[] };

const GATE_MATCHERS = QA_RELEASE_MERGE_LANE_GATE_PATTERNS.map(compileManifestPattern);

/**
 * A repository-relative path as Git stores it, judged by the same rule the
 * ownership manifest uses. Anything else cannot be judged against the
 * patterns and so excludes the pull request.
 */
function isReadablePath(path: unknown): path is string {
  return typeof path === "string" && isCanonicalRepoPath(path);
}

function branchExcluded(headBranch: string): boolean {
  return QA_RELEASE_MERGE_LANE_EXCLUDED_BRANCH_PREFIXES.some(
    (prefix) => headBranch === prefix || headBranch.startsWith(`${prefix}/`),
  );
}

export function judgeQaReleaseMergeLaneExclusion(input: QaReleaseExclusionInput): QaReleaseExclusion {
  const reasons = new Set<QaReleaseExclusionReason>();

  if (typeof input.headBranch !== "string" || input.headBranch === "" || branchExcluded(input.headBranch)) {
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

  const policyTests = new Set(input.policyTestPaths);
  const ownMatchers = input.agentOwnPatterns.map(compileManifestPattern);

  for (const file of changedFiles) {
    const paths = [file.path];
    if (file.previousPath !== undefined && file.previousPath !== null) paths.push(file.previousPath);
    for (const path of paths) {
      if (!isReadablePath(path)) {
        reasons.add("unreadable_path");
        continue;
      }
      // Every file at the repository root sets how checks run or are configured.
      if (!path.includes("/") || isGateFileName(path) || GATE_MATCHERS.some((matcher) => matcher.test(path))) {
        reasons.add("gate_path");
      }
      if (policyTests.has(path)) reasons.add("policy_test");
      if (ownMatchers.some((matcher) => matcher.test(path))) reasons.add("agent_own_path");
    }
    if (isReadablePath(file.path) && QA_RELEASE_MIGRATION_SQL_PATH.test(file.path)) {
      if (typeof file.migrationSql !== "string" || QA_RELEASE_PROTECTED_TABLE_PATTERN.test(file.migrationSql)) {
        reasons.add("protected_table_migration");
      }
    }
  }

  return reasons.size === 0 ? { excluded: false } : { excluded: true, reasons: [...reasons].sort() };
}
