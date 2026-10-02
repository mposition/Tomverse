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
type Section = {
  code: NotCheckedCode;
  size: (digest: QaReleaseDigest) => number;
  limit: number;
  empty: (digest: QaReleaseDigest) => void;
};

/**
 * Every capped list, in the order the size pass empties them. The three issue
 * lists are separate sections sharing one code, so one list over its cap does
 * not take the other two with it.
 */
const SECTIONS: Section[] = [
  { code: "hypothetical_overflow", size: (d) => d.hypothetical.length, limit: LIMITS.hypothetical, empty: (d) => void (d.hypothetical = []) },
  { code: "ci_overflow", size: (d) => d.ci.length, limit: LIMITS.ci, empty: (d) => void (d.ci = []) },
  { code: "gates_changed_overflow", size: (d) => d.gates.changed.length, limit: LIMITS.gatesChanged, empty: (d) => void (d.gates.changed = []) },
  { code: "applicability_unknown_overflow", size: (d) => d.gates.applicabilityUnknown.length, limit: LIMITS.applicabilityUnknown, empty: (d) => void (d.gates.applicabilityUnknown = []) },
  { code: "issues_overflow", size: (d) => d.issues.candidates.length, limit: LIMITS.issuesCandidates, empty: (d) => void (d.issues.candidates = []) },
  { code: "issues_overflow", size: (d) => d.issues.blocked.length, limit: LIMITS.issuesBlocked, empty: (d) => void (d.issues.blocked = []) },
  { code: "issues_overflow", size: (d) => d.issues.landedButUnverified.length, limit: LIMITS.issuesLandedButUnverified, empty: (d) => void (d.issues.landedButUnverified = []) },
  { code: "release_lane_overflow", size: (d) => d.releaseLane.length, limit: LIMITS.releaseLane, empty: (d) => void (d.releaseLane = []) },
  { code: "checks_overflow", size: (d) => d.checks.length, limit: LIMITS.checks, empty: (d) => void (d.checks = []) },
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
      // The service keeps no state; the app compares stored rows to find
      // changes, and the code below says this list is not that comparison.
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
  addCode(digest, "gates_changed_not_compared");

  // Hypothetical rows count only as a complete pair: under each assumption,
  // one report, and in it exactly one row per applicability-unknown gate that
  // the assumption actually classified. Anything less is not coverage, and
  // its rows are dropped so a partial matrix cannot read as results.
  const unknownIds = digest.gates.applicabilityUnknown;
  const coveredUnder = (assumed: boolean) =>
    input.hypotheticalReports.filter((r) => r.assumed === assumed).length === 1 &&
    unknownIds.every((id) => {
      const rows = hypothetical.filter((row) => row.assumed === assumed && row.id === id);
      return rows.length === 1 && rows[0].verdict !== "applicability_unknown";
    });
  if (unknownIds.length > 0 && !(coveredUnder(true) && coveredUnder(false))) {
    digest.hypothetical = [];
    addCode(digest, "memory_condition_unknown");
  }

  // A list over its own maximum is replaced, never truncated.
  for (const section of SECTIONS) {
    if (section.size(digest) > section.limit) {
      section.empty(digest);
      addCode(digest, section.code);
    }
  }

  // Then the whole document must fit the contract. Only a section that still
  // holds something is emptied, so a code always names a list that lost rows.
  for (const section of SECTIONS) {
    if (qaReleaseDigestByteLength(digest) <= QA_RELEASE_DIGEST_MAX_BYTES) break;
    if (section.size(digest) === 0) continue;
    section.empty(digest);
    addCode(digest, section.code);
  }
  if (qaReleaseDigestByteLength(digest) > QA_RELEASE_DIGEST_MAX_BYTES) {
    // Unreachable while the schema's worst case fits; never submit over the cap.
    throw new RangeError("digest_too_large");
  }

  if (digest.notChecked.length > LIMITS.notChecked) {
    throw new RangeError("more notChecked codes than the schema allows");
  }
  return qaReleaseDigestSchema.parse(digest);
}
