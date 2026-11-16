/**
 * Tier from a change set: T1 (the publisher may open a pull request) or T2 (a
 * private draft for a person to decide on).
 *
 * docs/policy/engineering-agent.md §3, §4 and §9-5 are the contract. The input
 * is the changed-file set the app derived from two verified Git tree listings,
 * plus the results of the analyses that live in their own modules
 * (credential reachability, the control-plane slice). Nothing here trusts the
 * model's own account of what it changed, the branch name, or the kind of
 * card the work came from.
 *
 * Every rule here only ever moves a change towards T2. The single way to reach
 * T1 is to be refused by none of them.
 */

import { classifyPath, isCanonicalRepoPath } from "./agentAuthorityFiles.ts";

export const GIT_MODES = {
  file: "100644",
  executable: "100755",
  symlink: "120000",
  gitlink: "160000",
  tree: "040000",
} as const;

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

/** One entry of the changed-file set, as derived from the two tree listings. */
export type ChangedEntry = {
  path: string;
  /** For renames and copies, the source path. */
  previousPath?: string;
  status: ChangeStatus;
  /** Git mode before and after; null where the side does not exist. */
  oldMode: string | null;
  newMode: string | null;
  /** Git object type after the change; null for a deletion. */
  newType: "blob" | "tree" | "commit" | null;
  /** Size in bytes after the change; 0 for a deletion. */
  sizeBytes: number;
  /** Whether the new content is text the policy can read. */
  isText: boolean;
  addedLines: number;
  removedLines: number;
  /** Lines added by the change, for the decision-value alarms. Empty for a deletion. */
  addedText: string;
  /** The whole file after the change. Empty for a deletion or non-text. */
  newText: string;
};

/*
 * No size, count, extension, path-shape or file-shape rule (owner decisions
 * 2026-11-15 and 2026-11-16: an internal development flow, limited only by
 * what it must protect). Until 2026-11-16 a path no rule classified, a
 * top-level directory nobody listed, a new framework entry file (route, page,
 * configuration), a file that loads code at run time, an executable bit, a
 * binary file, a policy-sounding test name and a framework version nobody
 * re-checked were each T2 as well. What is left is what money, secrets and
 * the control plane need: the control-plane paths and slice (which itself
 * fails closed on a control-plane module that assembles what it loads), the
 * credential reachability of CI jobs, the decision-value alarms, the tests the
 * policy documents name, and Git objects that are not plain files.
 *
 * A symbolic link stays T2: its target is read where the link is built or
 * served, so a link at a product path can point at a credential file or a
 * control-plane file that no path rule sees (`public/x -> /proc/self/environ`
 * would publish the build's environment).
 */

/**
 * Names whose values AGENTS.md reserves for a person. Outside the
 * control-plane files they are an alarm: the rule never narrows the path list,
 * it only adds T2 to changes the list would have let through.
 */
export const DECISION_VALUE_ALARMS: readonly RegExp[] = [
  /\bcreditWeight\b/,
  /\bmaxOutputTokens\b/,
  /\breservationOutputTokens\b/,
  /\bpriceSchedule\b/,
  /\bpricingVersion\b/,
  /\bservice_tier\b/,
  /\bguestDefaultModelId\b/,
  /\bDEFAULT_MODEL_ID\b/,
  /\bdiscountAmountCents\b/,
  /\bproductKey\b/,
];

export type T2Reason =
  | "path_not_canonical"
  | "control_plane_path"
  | "symlink"
  | "gitlink"
  | "not_a_blob"
  | "policy_named_test"
  | "decision_value_alarm"
  | "empty_change"
  | "credential_reachable"
  | "credential_analysis_failed"
  | "control_plane_slice"
  | "slice_analysis_failed"
  | "unsupported_tree_change";

export type PushFinding = { reason: T2Reason; path: string | null; detail?: string };

export type TierInput = {
  changes: readonly ChangedEntry[];
  /** Test files that the base commit's policy documents name by path. */
  policyNamedTests: ReadonlySet<string>;
  /** The credential reachability result for the base commit. */
  credential:
    | { status: "analysed"; forbidsAll: boolean; forbiddenPaths: ReadonlySet<string> }
    | { status: "failed" };
  /**
   * The control-plane slice: every product path, in the base or the result,
   * that already reaches a control-plane symbol, plus every path that names an
   * environment variable, AppSetting key, registry or configuration the slice
   * reads. Checked against both sides of every change.
   */
  slice: { status: "analysed"; slicePaths: ReadonlySet<string> } | { status: "failed" };
  /**
   * What tree verification reports it does not support (a path
   * `.gitattributes` applies to, a nested `.gitattributes`, a submodule):
   * a person reads such a change, so each is a T2 finding rather than a
   * refusal (owner decision 2026-11-15).
   */
  unsupported?: ReadonlyArray<{ reason: string; path: string | null }>;
};

export type TierVerdict =
  | { tier: "T1"; findings: [] }
  | { tier: "T2"; findings: PushFinding[] };

const basenameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A test whose own name says it pins a policy, a contract or an invariant.
 * The push policy no longer judges by name (2026-11-16); the merge lane's
 * Decision Maker allow list still does, and its scope is unchanged.
 */
export const isPolicyTestName = (path: string) =>
  path.startsWith("tests/") && /Policy|Contract|Invariant/.test(basenameOf(path));

/**
 * Test files the base commit's instruction documents name by path. The caller
 * passes the documents read at the base commit: `AGENTS.md`, `docs/agents/machine-index.md`, `docs/policy/**`,
 * `docs/ui-contracts/**` and the security regression script.
 */
export const policyNamedTestPaths = (documents: Iterable<string>): Set<string> => {
  const found = new Set<string>();
  const pattern = /(?:^|[\s`("'[])(tests\/[A-Za-z0-9._/\-[\]()]+\.[A-Za-z0-9]+)/gm;
  for (const text of documents) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return found;
};

const entryChecks = (entry: ChangedEntry, input: TierInput): PushFinding[] => {
  const findings: PushFinding[] = [];
  const paths = [entry.path, ...(entry.previousPath ? [entry.previousPath] : [])];

  for (const path of paths) {
    if (!isCanonicalRepoPath(path)) {
      findings.push({ reason: "path_not_canonical", path });
      continue;
    }
    if (classifyPath(path) === "control-plane") findings.push({ reason: "control_plane_path", path });
    if (input.policyNamedTests.has(path)) findings.push({ reason: "policy_named_test", path });
  }

  const modes = [entry.oldMode, entry.newMode];
  if (modes.includes(GIT_MODES.symlink)) findings.push({ reason: "symlink", path: entry.path });
  if (modes.includes(GIT_MODES.gitlink)) findings.push({ reason: "gitlink", path: entry.path });
  for (const mode of modes) {
    if (
      mode !== null &&
      mode !== GIT_MODES.file &&
      mode !== GIT_MODES.executable &&
      mode !== GIT_MODES.symlink &&
      mode !== GIT_MODES.gitlink
    ) {
      findings.push({ reason: "not_a_blob", path: entry.path, detail: mode });
    }
  }

  if (entry.status !== "deleted") {
    if (entry.newType !== "blob") findings.push({ reason: "not_a_blob", path: entry.path });
    for (const pattern of DECISION_VALUE_ALARMS) {
      if (pattern.test(entry.addedText)) {
        findings.push({ reason: "decision_value_alarm", path: entry.path, detail: pattern.source });
      }
    }
  }

  if (input.credential.status === "analysed") {
    for (const path of paths) {
      if (input.credential.forbiddenPaths.has(path)) {
        findings.push({ reason: "credential_reachable", path });
      }
    }
  }
  // Both sides of a rename or copy: moving a slice member to a fresh product
  // path is still a change to that member.
  if (input.slice.status === "analysed") {
    for (const path of paths) {
      if (input.slice.slicePaths.has(path)) {
        findings.push({ reason: "control_plane_slice", path });
      }
    }
  }

  return findings;
};

/**
 * Decides the tier. Every finding is kept, so the owner can see why a draft is
 * a draft; the tier is T1 only when there are none.
 */
export const decideTier = (input: TierInput): TierVerdict => {
  const findings: PushFinding[] = [];

  if (input.changes.length === 0) findings.push({ reason: "empty_change", path: null });

  if (input.credential.status === "failed") {
    findings.push({ reason: "credential_analysis_failed", path: null });
  } else if (input.credential.forbidsAll) {
    findings.push({ reason: "credential_reachable", path: null });
  }
  // A slice analysis that did not finish fails the whole patch, never one file.
  if (input.slice.status === "failed") {
    findings.push({ reason: "slice_analysis_failed", path: null });
  }

  for (const entry of input.changes) findings.push(...entryChecks(entry, input));
  for (const item of input.unsupported ?? []) {
    findings.push({ reason: "unsupported_tree_change", path: item.path, detail: item.reason });
  }

  return findings.length === 0 ? { tier: "T1", findings: [] } : { tier: "T2", findings };
};
