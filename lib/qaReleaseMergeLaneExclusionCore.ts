/**
 * Which develop pull requests the QA-release merge lane must leave to a person.
 *
 * docs/policy/qa-release-agent.md (version 1), section 8 item 3, is the
 * contract. A pull request listed here is never merged by the lane; it is
 * shown in Admin as human work, and the lane moves on to the next oldest
 * candidate. Every input comes from the caller -- this module reads no
 * network, file or clock -- and every uncertainty excludes.
 */
import { compileManifestPattern } from "./agentAuthorityFiles.ts";

/** Gate paths: the checks, their runners and the documents that define them. */
export const QA_RELEASE_MERGE_LANE_GATE_PATTERNS: readonly string[] = [
  ".github/**",
  "scripts/**",
  "package.json",
  "package-lock.json",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/policy/**",
  "docs/ui-contracts/**",
  "docs/release-gates/**",
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

export type QaReleaseChangedFile = {
  path: string;
  /** Set for a rename: both sides are judged. */
  previousPath?: string | null;
};

export type QaReleaseExclusionInput = {
  headBranch: string;
  changedFiles: readonly QaReleaseChangedFile[];
  /** False when the changed-file list could not be read to its last page. */
  changedFilesComplete: boolean;
  /** `tests/**` paths named by the policy documents at the pull request's base. */
  policyTestPaths: readonly string[];
  /** This agent's own path patterns, read from the policy at the pull request's base. */
  agentOwnPatterns: readonly string[];
};

export type QaReleaseExclusionReason =
  | "changed_files_incomplete"
  | "unreadable_path"
  | "gate_path"
  | "policy_test"
  | "agent_own_path"
  | "excluded_branch";

export type QaReleaseExclusion =
  | { excluded: false }
  | { excluded: true; reasons: QaReleaseExclusionReason[] };

const GATE_MATCHERS = QA_RELEASE_MERGE_LANE_GATE_PATTERNS.map(compileManifestPattern);

/**
 * A repository-relative path as Git stores it. Anything else cannot be judged
 * against the patterns and so excludes the pull request.
 */
function isReadablePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (/[\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function branchExcluded(headBranch: string): boolean {
  return QA_RELEASE_MERGE_LANE_EXCLUDED_BRANCH_PREFIXES.some(
    (prefix) => headBranch === prefix || headBranch.startsWith(`${prefix}/`),
  );
}

export function judgeQaReleaseMergeLaneExclusion(input: QaReleaseExclusionInput): QaReleaseExclusion {
  const reasons = new Set<QaReleaseExclusionReason>();

  if (!input.changedFilesComplete || input.changedFiles.length === 0) {
    reasons.add("changed_files_incomplete");
  }
  if (typeof input.headBranch !== "string" || input.headBranch === "" || branchExcluded(input.headBranch)) {
    reasons.add("excluded_branch");
  }

  const policyTests = new Set(input.policyTestPaths);
  const ownMatchers = input.agentOwnPatterns.map(compileManifestPattern);

  for (const file of input.changedFiles) {
    const paths = [file.path];
    if (file.previousPath !== undefined && file.previousPath !== null) paths.push(file.previousPath);
    for (const path of paths) {
      if (!isReadablePath(path)) {
        reasons.add("unreadable_path");
        continue;
      }
      if (GATE_MATCHERS.some((matcher) => matcher.test(path))) reasons.add("gate_path");
      if (policyTests.has(path)) reasons.add("policy_test");
      if (ownMatchers.some((matcher) => matcher.test(path))) reasons.add("agent_own_path");
    }
  }

  return reasons.size === 0 ? { excluded: false } : { excluded: true, reasons: [...reasons].sort() };
}
