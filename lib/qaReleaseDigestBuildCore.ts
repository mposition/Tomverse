/**
 * Builds the QA-release daily digest from the report outputs.
 *
 * docs/policy/qa-release-agent.md: the digest carries numbers, enum values,
 * issue numbers and SHAs only. This module keeps only those fields from the
 * reports (gate notes, file lists and issue titles are dropped here) and
 * never truncates a list: a section whose list exceeds its maximum is replaced
 * by a fixed overflow code, because a truncated list reads as a complete one.
 * If the whole document still exceeds the 16 KiB contract, sections are
 * replaced in a fixed order until it fits.
 *
 * Pure: every input is passed in.
 */
import {
  QA_RELEASE_DIGEST_ARRAY_LIMITS as LIMITS,
  QA_RELEASE_DIGEST_MAX_BYTES,
  QA_RELEASE_GATE_STATUSES,
  QA_RELEASE_GATE_VERDICTS,
  QA_RELEASE_ISSUE_VERDICTS,
  type QaReleaseDigest,
  qaReleaseDigestByteLength,
  qaReleaseDigestSchema,
} from "./qaReleaseDigestSchemaCore.ts";

type GateRow = { id: string; status: string; verdict: string };
type IssueRow = { number: number; verdict: string };
type NotCheckedCode = QaReleaseDigest["notChecked"][number];

export type QaReleaseDigestBuildInput = {
  digestDate: string;
  baseSha: string;
  generatedAt: string;
  runDeadline: string;
  /** `report:release-gate-evidence --json`, run without a condition. */
  gateReport: { classified: GateRow[] };
  /** The same report run with the memory condition assumed true and false. */
  hypotheticalReports: { assumed: boolean; report: { classified: GateRow[] } }[];
  /** `report:issue-backlog --json`, or `null` when it could not be produced. */
  issueReport: { classified: IssueRow[] } | null;
  checks: QaReleaseDigest["checks"];
  ci: QaReleaseDigest["ci"];
  releaseLane: QaReleaseDigest["releaseLane"];
  /** Codes the caller already knows apply, such as `github_read_unavailable`. */
  notChecked: NotCheckedCode[];
};

const countBy = <K extends string>(keys: readonly K[], values: readonly string[]): Record<K, number> => {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const value of values) {
    if (!(keys as readonly string[]).includes(value)) {
      throw new RangeError(`unknown value ${JSON.stringify(value)}`);
    }
    counts[value as K] += 1;
  }
  return counts;
};

/**
 * Sections replaced, in this order, when the document is still too large.
 * Each step empties one list and records its overflow code.
 */
const SHRINK_ORDER: { code: NotCheckedCode; empty: (digest: QaReleaseDigest) => void }[] = [
  { code: "hypothetical_overflow", empty: (d) => void (d.hypothetical = []) },
  { code: "ci_overflow", empty: (d) => void (d.ci = []) },
  { code: "gates_changed_overflow", empty: (d) => void (d.gates.changed = []) },
  {
    code: "issues_overflow",
    empty: (d) => {
      d.issues.candidates = [];
      d.issues.blocked = [];
      d.issues.landedButUnverified = [];
    },
  },
  { code: "release_lane_overflow", empty: (d) => void (d.releaseLane = []) },
  { code: "checks_overflow", empty: (d) => void (d.checks = []) },
];

function addCode(digest: QaReleaseDigest, code: NotCheckedCode): void {
  if (!digest.notChecked.includes(code)) digest.notChecked.push(code);
}

export function buildQaReleaseDigest(input: QaReleaseDigestBuildInput): QaReleaseDigest {
  const gates = input.gateReport.classified;
  const issues = input.issueReport?.classified ?? null;

  const hypothetical = input.hypotheticalReports.flatMap(({ assumed, report }) =>
    report.classified
      .filter((row) => gates.some((gate) => gate.id === row.id && gate.verdict === "applicability_unknown"))
      .map((row) => ({
        condition: "memory-release-b-enabled" as const,
        assumed,
        id: row.id,
        verdict: row.verdict as QaReleaseDigest["hypothetical"][number]["verdict"],
      })),
  );

  const numbersWith = (verdict: string) =>
    (issues ?? []).filter((row) => row.verdict === verdict).map((row) => row.number);

  const digest: QaReleaseDigest = {
    schemaVersion: 1,
    digestDate: input.digestDate,
    baseSha: input.baseSha,
    generatedAt: input.generatedAt,
    runDeadline: input.runDeadline,
    gates: {
      byVerdict: countBy(QA_RELEASE_GATE_VERDICTS, gates.map((row) => row.verdict)),
      byStatus: countBy(QA_RELEASE_GATE_STATUSES, gates.map((row) => row.status)),
      // The service keeps no state; the app compares stored rows to find changes.
      changed: [],
      applicabilityUnknown: gates.filter((row) => row.verdict === "applicability_unknown").map((row) => row.id),
    },
    hypothetical,
    issues: {
      status: issues === null ? "unavailable" : "ok",
      byVerdict: countBy(QA_RELEASE_ISSUE_VERDICTS, (issues ?? []).map((row) => row.verdict)),
      candidates: numbersWith("open_work"),
      blocked: numbersWith("blocked"),
      landedButUnverified: numbersWith("landed_but_unverified"),
    },
    checks: [...input.checks],
    ci: [...input.ci],
    releaseLane: [...input.releaseLane],
    notChecked: [],
  };

  for (const code of input.notChecked) addCode(digest, code);
  if (issues === null) addCode(digest, "issue_backlog_unavailable");

  // A list over its own maximum is replaced, never truncated.
  const over: Record<NotCheckedCode, boolean> = {
    hypothetical_overflow: digest.hypothetical.length > LIMITS.hypothetical,
    ci_overflow: digest.ci.length > LIMITS.ci,
    gates_changed_overflow: digest.gates.changed.length > LIMITS.gatesChanged,
    issues_overflow:
      digest.issues.candidates.length > LIMITS.issuesCandidates ||
      digest.issues.blocked.length > LIMITS.issuesBlocked ||
      digest.issues.landedButUnverified.length > LIMITS.issuesLandedButUnverified,
    release_lane_overflow: digest.releaseLane.length > LIMITS.releaseLane,
    checks_overflow: digest.checks.length > LIMITS.checks,
  } as Record<NotCheckedCode, boolean>;
  for (const step of SHRINK_ORDER) {
    if (over[step.code]) {
      step.empty(digest);
      addCode(digest, step.code);
    }
  }
  if (digest.gates.applicabilityUnknown.length > LIMITS.applicabilityUnknown) {
    throw new RangeError("more applicability-unknown gates than the registry can hold");
  }

  // Then the whole document must fit the contract.
  for (const step of SHRINK_ORDER) {
    if (qaReleaseDigestByteLength(digest) <= QA_RELEASE_DIGEST_MAX_BYTES) break;
    step.empty(digest);
    addCode(digest, step.code);
  }
  if (qaReleaseDigestByteLength(digest) > QA_RELEASE_DIGEST_MAX_BYTES) {
    addCode(digest, "digest_too_large");
  }

  if (digest.notChecked.length > LIMITS.notChecked) {
    throw new RangeError("more notChecked codes than the schema allows");
  }
  return qaReleaseDigestSchema.parse(digest);
}
