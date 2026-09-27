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

import {
  CONVENTION_VERSIONS,
  classifyPath,
  isCanonicalRepoPath,
  isKnownTopLevel,
} from "./agentAuthorityFiles.ts";

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
  /** Lines added by the change, for the content rules. Empty for a deletion. */
  addedText: string;
};

/** Proposed values (policy §9-5); fixed by revision before shadow. */
export const PUSH_LIMITS = {
  maxFiles: 5,
  maxChangedLines: 300,
  maxFileBytes: 200 * 1024,
} as const;

export const T1_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".css", ".md", ".json"] as const;

/** `.json` is text data the agent may write only for locales and fixtures. */
const JSON_ALLOWED_PREFIXES = ["locales/", "tests/fixtures/"];

/** Next's file-based entry points, and files named as configuration. */
const ENTRY_CONVENTION_NAMES = [
  /^route\.[^/]+$/,
  /^page\.[^/]+$/,
  /^layout\.[^/]+$/,
  /^template\.[^/]+$/,
  /^default\.[^/]+$/,
  /^middleware\.[^/]+$/,
  /^instrumentation(?:-client)?\.[^/]+$/,
  /^proxy\.[^/]+$/,
  /^(?:loading|error|global-error|not-found|forbidden|unauthorized)\.[^/]+$/,
  /^(?:opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[^/]+$/,
  /\.config\.[^/]+$/,
];

/**
 * Code that assembles what it loads at run time. A graph built from literal
 * imports cannot see where these lead, so a change that introduces one is T2.
 */
const RUNTIME_DISCOVERY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bimport\s*\(\s*(?!["'`][^"'`$]*["'`]\s*[,)])/, "dynamic_import_non_literal"],
  [/\brequire\s*\(\s*(?!["'][^"']*["']\s*\))/, "require_non_literal"],
  [/\brequire\.resolve\b/, "require_resolve"],
  [/\bimport\.meta\.glob\b/, "import_meta_glob"],
  [/\bcreateRequire\b/, "create_require"],
  [/\breaddir(?:Sync)?\b/, "directory_loader"],
  [/\bopendir(?:Sync)?\b/, "directory_loader"],
  [/\bglob(?:Sync)?\s*\(/, "directory_loader"],
  [/\bnew\s+Function\b/, "dynamic_evaluation"],
  [/\beval\s*\(/, "dynamic_evaluation"],
];

/**
 * Names whose values AGENTS.md reserves for a person. Outside the
 * control-plane files they are an alarm: the rule never narrows the path list,
 * it only adds T2 to changes the list would have let through.
 */
const DECISION_VALUE_ALARMS: readonly RegExp[] = [
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
  | "unclassified_path"
  | "unknown_top_level_directory"
  | "not_text"
  | "symlink"
  | "gitlink"
  | "executable_bit"
  | "not_a_blob"
  | "extension_not_allowed"
  | "json_outside_data_paths"
  | "policy_named_test"
  | "policy_test_name"
  | "entry_convention"
  | "runtime_discovery"
  | "decision_value_alarm"
  | "too_many_files"
  | "too_many_lines"
  | "file_too_large"
  | "empty_change"
  | "credential_reachable"
  | "credential_analysis_failed"
  | "control_plane_slice"
  | "slice_analysis_failed"
  | "convention_version_mismatch";

export type PushFinding = { reason: T2Reason; path: string | null; detail?: string };

export type TierInput = {
  changes: readonly ChangedEntry[];
  /** Test files that the base commit's policy documents name by path. */
  policyNamedTests: ReadonlySet<string>;
  /** Installed versions read from the base commit's lockfile. */
  installedVersions: Readonly<Record<keyof typeof CONVENTION_VERSIONS, string | null>>;
  /** The credential reachability result for the base commit. */
  credential:
    | { status: "analysed"; forbidsAll: boolean; forbiddenPaths: ReadonlySet<string> }
    | { status: "failed" };
  /** The control-plane slice result for this change set. */
  slice: { status: "analysed"; touchedPaths: ReadonlySet<string> } | { status: "failed" };
};

export type TierVerdict =
  | { tier: "T1"; findings: [] }
  | { tier: "T2"; findings: PushFinding[] };

const extensionOf = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

const basenameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const isPolicyTestName = (path: string) =>
  path.startsWith("tests/") && /Policy|Contract|Invariant/.test(basenameOf(path));

/**
 * Test files the base commit's instruction documents name by path. The caller
 * passes the documents read at the base commit: `AGENTS.md`, `docs/policy/**`,
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
    if (!isKnownTopLevel(path)) findings.push({ reason: "unknown_top_level_directory", path });
    const cls = classifyPath(path);
    if (cls === "control-plane") findings.push({ reason: "control_plane_path", path });
    if (cls === "unclassified") findings.push({ reason: "unclassified_path", path });
    if (input.policyNamedTests.has(path)) findings.push({ reason: "policy_named_test", path });
    if (isPolicyTestName(path)) findings.push({ reason: "policy_test_name", path });
  }

  const modes = [entry.oldMode, entry.newMode];
  if (modes.includes(GIT_MODES.symlink)) findings.push({ reason: "symlink", path: entry.path });
  if (modes.includes(GIT_MODES.gitlink)) findings.push({ reason: "gitlink", path: entry.path });
  if (modes.includes(GIT_MODES.executable)) {
    findings.push({ reason: "executable_bit", path: entry.path });
  }
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
    if (!entry.isText) findings.push({ reason: "not_text", path: entry.path });
    if (entry.sizeBytes > PUSH_LIMITS.maxFileBytes) {
      findings.push({ reason: "file_too_large", path: entry.path });
    }

    const extension = extensionOf(entry.path);
    if (!(T1_EXTENSIONS as readonly string[]).includes(extension)) {
      findings.push({ reason: "extension_not_allowed", path: entry.path, detail: extension });
    } else if (
      extension === ".json" &&
      !JSON_ALLOWED_PREFIXES.some((prefix) => entry.path.startsWith(prefix))
    ) {
      findings.push({ reason: "json_outside_data_paths", path: entry.path });
    }

    // A new file at a framework convention runs without anything importing it.
    if (
      (entry.status === "added" || entry.status === "renamed" || entry.status === "copied") &&
      ENTRY_CONVENTION_NAMES.some((pattern) => pattern.test(basenameOf(entry.path)))
    ) {
      findings.push({ reason: "entry_convention", path: entry.path });
    }

    for (const [pattern, detail] of RUNTIME_DISCOVERY_PATTERNS) {
      if (pattern.test(entry.addedText)) {
        findings.push({ reason: "runtime_discovery", path: entry.path, detail });
      }
    }
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
  if (input.slice.status === "analysed" && input.slice.touchedPaths.has(entry.path)) {
    findings.push({ reason: "control_plane_slice", path: entry.path });
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
  if (input.changes.length > PUSH_LIMITS.maxFiles) {
    findings.push({ reason: "too_many_files", path: null, detail: String(input.changes.length) });
  }
  const changedLines = input.changes.reduce(
    (sum, entry) => sum + entry.addedLines + entry.removedLines,
    0,
  );
  if (changedLines > PUSH_LIMITS.maxChangedLines) {
    findings.push({ reason: "too_many_lines", path: null, detail: String(changedLines) });
  }

  for (const [name, recorded] of Object.entries(CONVENTION_VERSIONS)) {
    const installed = input.installedVersions[name as keyof typeof CONVENTION_VERSIONS];
    if (installed !== recorded) {
      findings.push({
        reason: "convention_version_mismatch",
        path: null,
        detail: `${name}:${installed ?? "missing"}`,
      });
    }
  }

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

  return findings.length === 0 ? { tier: "T1", findings: [] } : { tier: "T2", findings };
};
