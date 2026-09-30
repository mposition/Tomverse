import type {
  PromptRefinerShadowEvidenceBundle,
  PromptRefinerShadowEvidenceCaseFailure,
  PromptRefinerShadowEvidenceGateReason,
} from "@/lib/promptRefinerShadowEvidenceCore";

/** A client-safe, content-free view of one immutable synthetic v6 run. */
export const PROMPT_REFINER_SHADOW_HISTORICAL_EVIDENCE_PATH =
  "/api/admin/prompt-refiner/shadow-run/evidence" as const;

export const PROMPT_REFINER_SHADOW_HISTORICAL_RUN_ID =
  "prompt-refiner-shadow-run-v6" as const;
export const PROMPT_REFINER_SHADOW_HISTORICAL_CASE_IDS = Object.freeze([
  "prsv1-ko-01", "prsv1-ko-02", "prsv1-ko-03", "prsv1-ko-04",
  "prsv1-ko-05", "prsv1-ko-06", "prsv1-ko-07", "prsv1-ko-08",
  "prsv1-en-01", "prsv1-en-02", "prsv1-en-03", "prsv1-en-04",
  "prsv1-en-05", "prsv1-en-06", "prsv1-en-07", "prsv1-en-08",
] as const);
type ExhaustiveValues<All extends string, Values extends readonly All[]> =
  Exclude<All, Values[number]> extends never ? Values : never;

type GateOutcome = PromptRefinerShadowEvidenceBundle["gateOutcome"];
type TerminalStatus = PromptRefinerShadowEvidenceBundle["cases"][number]["terminalStatus"];
type EvidenceStatus = PromptRefinerShadowEvidenceBundle["cases"][number]["evidenceStatus"];

const GATE_OUTCOME_VALUES =
  ["pass", "fail", "insufficient_evidence"] as const satisfies readonly GateOutcome[];
const GATE_OUTCOMES = new Set<GateOutcome>(
  GATE_OUTCOME_VALUES satisfies ExhaustiveValues<GateOutcome, typeof GATE_OUTCOME_VALUES>
);
const TERMINAL_STATUS_VALUES =
  ["suggested", "failed", "unknown"] as const satisfies readonly TerminalStatus[];
const TERMINAL_STATUSES = new Set<TerminalStatus>(
  TERMINAL_STATUS_VALUES satisfies ExhaustiveValues<TerminalStatus, typeof TERMINAL_STATUS_VALUES>
);
const EVIDENCE_STATUS_VALUES =
  ["pass", "fail", "insufficient_evidence"] as const satisfies readonly EvidenceStatus[];
const EVIDENCE_STATUSES = new Set<EvidenceStatus>(
  EVIDENCE_STATUS_VALUES satisfies ExhaustiveValues<EvidenceStatus, typeof EVIDENCE_STATUS_VALUES>
);

const GATE_REASON_VALUES = [
  "case_evidence_failed", "case_evidence_incomplete",
  "injection_evidence_failed", "injection_evidence_incomplete",
  "terminal_failure_present", "unknown_present", "cost_incomplete",
  "cost_threshold_exceeded", "latency_incomplete",
  "latency_p90_exceeded", "latency_max_exceeded",
] as const satisfies readonly PromptRefinerShadowEvidenceGateReason[];
const GATE_REASONS = new Set<PromptRefinerShadowEvidenceGateReason>(
  GATE_REASON_VALUES satisfies ExhaustiveValues<
    PromptRefinerShadowEvidenceGateReason, typeof GATE_REASON_VALUES
  >
);
const CASE_REASON_VALUES = [
  "not_suggested", "source_not_changed", "length_out_of_bounds",
  "language_mismatch", "required_concept_missing", "exact_literal_missing",
  "unsafe_injection_framing",
] as const satisfies readonly PromptRefinerShadowEvidenceCaseFailure[];
const CASE_REASONS = new Set<PromptRefinerShadowEvidenceCaseFailure>(
  CASE_REASON_VALUES satisfies ExhaustiveValues<
    PromptRefinerShadowEvidenceCaseFailure, typeof CASE_REASON_VALUES
  >
);

export type PromptRefinerShadowHistoricalDiagnostics = Readonly<{
  runId: typeof PROMPT_REFINER_SHADOW_HISTORICAL_RUN_ID;
  gateOutcome: GateOutcome;
  gateReasons: readonly PromptRefinerShadowEvidenceGateReason[];
  attemptedCases: 16;
  passedCases: number;
  cases: readonly Readonly<{
    caseId: (typeof PROMPT_REFINER_SHADOW_HISTORICAL_CASE_IDS)[number];
    terminalStatus: TerminalStatus;
    evidenceStatus: EvidenceStatus;
    failureReasons: readonly PromptRefinerShadowEvidenceCaseFailure[];
  }>[];
  executionAdmitted: false;
  suggestionUiAuthorized: false;
  routerCouplingAuthorized: false;
  paidRunAuthorized: false;
  humanReviewRequired: true;
  productAdapterReady: false;
}>;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

const isOneOf = <T extends string>(value: unknown, allowed: ReadonlySet<T>): value is T =>
  typeof value === "string" && allowed.has(value as T);

const reasonsAreClosed = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>
): value is T[] =>
  Array.isArray(value) &&
  value.length <= allowed.size &&
  value.every((reason) => typeof reason === "string" && allowed.has(reason as T)) &&
  new Set(value).size === value.length;

/** Rejects extra fields, forged case IDs, count drift, and unreviewed reason codes. */
export function parsePromptRefinerShadowHistoricalDiagnostics(
  value: unknown
): PromptRefinerShadowHistoricalDiagnostics | null {
  const wrapper = record(value);
  if (!wrapper || !exactKeys(wrapper, ["diagnostics"])) return null;
  if (wrapper.diagnostics === null) return null;
  const diagnostics = record(wrapper.diagnostics);
  if (!diagnostics || !exactKeys(diagnostics, [
    "runId", "gateOutcome", "gateReasons", "attemptedCases",
    "passedCases", "cases", "executionAdmitted", "productAdapterReady",
    "suggestionUiAuthorized", "routerCouplingAuthorized", "paidRunAuthorized",
    "humanReviewRequired",
  ])) return null;
  if (diagnostics.runId !== PROMPT_REFINER_SHADOW_HISTORICAL_RUN_ID ||
    diagnostics.attemptedCases !== 16 ||
    diagnostics.executionAdmitted !== false ||
    diagnostics.suggestionUiAuthorized !== false ||
    diagnostics.routerCouplingAuthorized !== false ||
    diagnostics.paidRunAuthorized !== false ||
    diagnostics.humanReviewRequired !== true ||
    diagnostics.productAdapterReady !== false ||
    !Number.isSafeInteger(diagnostics.passedCases) ||
    (diagnostics.passedCases as number) < 0 ||
    (diagnostics.passedCases as number) > 16 ||
    !isOneOf(diagnostics.gateOutcome, GATE_OUTCOMES) ||
    !reasonsAreClosed(diagnostics.gateReasons, GATE_REASONS) ||
    !Array.isArray(diagnostics.cases) ||
    diagnostics.cases.length !== PROMPT_REFINER_SHADOW_HISTORICAL_CASE_IDS.length
  ) return null;

  let passed = 0;
  for (const [index, candidate] of diagnostics.cases.entries()) {
    const item = record(candidate);
    if (!item || !exactKeys(item, [
      "caseId", "terminalStatus", "evidenceStatus", "failureReasons",
    ]) || item.caseId !== PROMPT_REFINER_SHADOW_HISTORICAL_CASE_IDS[index] ||
      !isOneOf(item.terminalStatus, TERMINAL_STATUSES) ||
      !isOneOf(item.evidenceStatus, EVIDENCE_STATUSES) ||
      !reasonsAreClosed(item.failureReasons, CASE_REASONS)
    ) return null;
    if (item.evidenceStatus === "pass") {
      if (item.terminalStatus !== "suggested" || item.failureReasons.length !== 0) return null;
      passed += 1;
    } else if (item.evidenceStatus === "fail") {
      if (item.failureReasons.length === 0 || item.terminalStatus === "unknown") return null;
    } else if (item.failureReasons.length !== 0 || item.terminalStatus !== "unknown") {
      return null;
    }
  }
  if (passed !== diagnostics.passedCases ||
    (diagnostics.gateOutcome === "pass") !== (diagnostics.gateReasons.length === 0) ||
    (diagnostics.gateOutcome === "pass" && passed !== 16)
  ) return null;
  return diagnostics as PromptRefinerShadowHistoricalDiagnostics;
}

/** Explicit projection: never serialize the stored bundle or its case objects. */
export function projectPromptRefinerShadowHistoricalDiagnostics(
  bundle: PromptRefinerShadowEvidenceBundle
): PromptRefinerShadowHistoricalDiagnostics {
  const candidate = {
    runId: PROMPT_REFINER_SHADOW_HISTORICAL_RUN_ID,
    gateOutcome: bundle.gateOutcome,
    gateReasons: bundle.gateReasons,
    attemptedCases: bundle.summary.attemptedCases,
    passedCases: bundle.summary.passedCases,
    cases: bundle.cases.map((item) => ({
      caseId: item.caseId,
      terminalStatus: item.terminalStatus,
      evidenceStatus: item.evidenceStatus,
      failureReasons: item.failureReasons,
    })),
    executionAdmitted: bundle.executionAdmitted,
    productAdapterReady: bundle.productAdapterReady,
    suggestionUiAuthorized: bundle.suggestionUiAuthorized,
    routerCouplingAuthorized: bundle.routerCouplingAuthorized,
    paidRunAuthorized: bundle.paidRunAuthorized,
    humanReviewRequired: bundle.humanReviewRequired,
  };
  const parsed = parsePromptRefinerShadowHistoricalDiagnostics({ diagnostics: candidate });
  if (!parsed) throw new Error("prompt_refiner_historical_evidence_invalid");
  return parsed;
}
