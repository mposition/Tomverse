/**
 * The three things that must each be true, separately, before any account is
 * routed by Auto.
 *
 * The rollout plan states them as one sentence -- "shadow report acceptable,
 * offline quality evaluation passed, attempt/manifest boundary passed; if any
 * one is missing it stays shadow" -- and a sentence is not a mechanism. This
 * register is the mechanism: `lib/autoCohort.ts` refuses to place anybody in
 * the cohort while any entry here is `pending`, so turning Auto on for a real
 * user requires the evidence to exist rather than requiring somebody to
 * remember that it should.
 *
 * ## Why they cannot be collapsed into one check
 *
 * Each answers a question the others cannot.
 *
 * - The **shadow report** measures blast radius: how much would change if Auto
 *   were switched on. It never generated the recommended model's answer, so it
 *   is silent on whether the change would be an improvement.
 * - The **offline evaluation** measures answer quality against a
 *   pre-registered baseline, with a confidence interval. It says nothing about
 *   whether the production dispatch path can record what it sent.
 * - The **attempt/manifest boundary** establishes that every dispatch carries a
 *   finalized manifest, so a routed request can be reconstructed afterwards.
 *   It says nothing about the quality of the choice.
 *
 * Reading any one as the others is the mistake the separation exists to
 * prevent, and it is an easy one to make, because all three produce reassuring
 * numbers.
 *
 * ## What an agent may do here
 *
 * Add a `pending` entry, fill in the evidence fields it can compute, and keep
 * the notes current. Moving an entry to `passed` is a human attestation --
 * `attestedBy` is a person, and `scripts/check-auto-rollout-readiness.mjs`
 * (PR Fast Gate) refuses a `passed` entry whose evidence is incomplete. The
 * commit history is the audit record, the same way the memory-extraction eval
 * register works.
 */

/** Bump when a gate is added, removed, or its evidence requirements change. */
export const AUTO_ROLLOUT_READINESS_VERSION = "auto-rollout-readiness-v1";

export type AutoReadinessGateId =
  | "shadow_report"
  | "offline_quality_evaluation"
  | "attempt_manifest_boundary";

export type AutoReadinessEntry = {
  id: AutoReadinessGateId;
  title: string;
  /** What this gate establishes, and -- as importantly -- what it does not. */
  measures: string;
  status: "pending" | "passed";
  /** A person. Never a script, a job, or an agent. */
  attestedBy: string | null;
  attestedAt: string | null;
  /**
   * Required in full on a `passed` entry, `null` while pending.
   *
   * `artifactRef` is a path or URL a reviewer can open. `summary` is the
   * figure the attestation turns on, written out, so the register is readable
   * without fetching the artefact.
   */
  evidence: {
    artifactRef: string;
    evaluatedCommit: string;
    summary: string;
    /** Re-attestation deadline: readiness is a measurement, and it ages. */
    expiresAt: string;
    knownLimitations: string;
  } | null;
  notes?: string;
};

export const AUTO_ROLLOUT_READINESS: readonly AutoReadinessEntry[] = [
  {
    id: "shadow_report",
    title: "Shadow figures are acceptable",
    measures:
      "How much would change if Auto were switched on: candidate-survival rate, " +
      "per-model selection distribution, disagreement with the user's own choice, " +
      "hard-filter rejection reasons, no_candidate rate, sticky/hysteresis switch " +
      "frequency, and Router decision latency. It does NOT measure whether the " +
      "change would be an improvement -- shadow never generated the recommended " +
      "model's answer, so there is no pair and no win rate.",
    status: "pending",
    attestedBy: null,
    attestedAt: null,
    evidence: null,
    notes:
      "npm run report:routing-shadow computes every figure listed above and " +
      "prints, beside its own numbers, what it cannot measure. What is missing " +
      "is the data: ROUTING_SHADOW has not been enabled on real traffic, so the " +
      "report currently has no rows to describe.",
  },
  {
    id: "offline_quality_evaluation",
    title: "Offline paired quality evaluation passed",
    measures:
      "Answer quality against the pre-registered fixed-model baseline, paired " +
      "and blind, as a win-rate delta with a 95% confidence interval (ROUTE-01, " +
      "margin -2pp). It does NOT establish that the production dispatch path can " +
      "record what it sent, and it is not the shadow report.",
    status: "pending",
    attestedBy: null,
    attestedAt: null,
    evidence: null,
    notes:
      "The harness exists: npm run eval:router-quality -- --mode=decision, " +
      "validated by npm run check:router-quality-eval, following " +
      "docs/ops/tomverse-chat-router-evaluation-set.md. What is missing is human: " +
      "a decision set has to be adopted and frozen, a baseline pre-registered, a " +
      "pilot run so n can be pre-registered, and the decision run executed. §10 of " +
      "that document reserves each of those for a person.",
  },
  {
    id: "attempt_manifest_boundary",
    title: "Attempt and manifest boundary passed",
    measures:
      "That every dispatched attempt carries its own finalized, immutable " +
      "manifest (ROUTE-06), that finalization is atomic, that cancellation and " +
      "stream failure reach the record, and what the extra writes cost " +
      "time-to-first-token. It says nothing about the quality of the routing " +
      "choice.",
    status: "pending",
    attestedBy: null,
    attestedAt: null,
    evidence: null,
    notes:
      "The records, constraints and instrumentation are implemented and covered " +
      "by tests/integration/routing-dispatch-instrumentation.db.test.ts. What is " +
      "missing is the production measurement: " +
      "ROUTING_DISPATCH_INSTRUMENTATION is still `off` in production, so " +
      "npm run report:routing-dispatch-readiness has no runs to grade, and " +
      "`enforce` -- the fail-closed posture §5 requires -- has not been reached.",
  },
];

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Everything wrong with the register, as sentences.
 *
 * The interesting rule is the one about `passed`: an entry may only claim to
 * have passed if it names a person, a date and a complete evidence block. A
 * gate that passed because somebody edited a string is the failure this whole
 * file exists to prevent, and it is indistinguishable from a real pass unless
 * something demands the evidence.
 */
export const autoRolloutReadinessProblems = (
  register: readonly AutoReadinessEntry[] = AUTO_ROLLOUT_READINESS,
  now: () => number = Date.now
): readonly string[] => {
  const problems: string[] = [];
  const expected: AutoReadinessGateId[] = [
    "shadow_report",
    "offline_quality_evaluation",
    "attempt_manifest_boundary",
  ];

  for (const id of expected) {
    if (!register.some((entry) => entry.id === id)) {
      problems.push(`the register has no entry for ${id}`);
    }
  }
  const seen = new Set<string>();
  for (const entry of register) {
    if (seen.has(entry.id)) problems.push(`${entry.id} appears more than once`);
    seen.add(entry.id);

    if (!isNonEmptyString(entry.title)) problems.push(`${entry.id} has no title`);
    if (!isNonEmptyString(entry.measures)) {
      problems.push(`${entry.id} does not say what it measures`);
    }
    if (entry.status !== "pending" && entry.status !== "passed") {
      problems.push(`${entry.id} has status "${String(entry.status)}"`);
    }
    if (entry.status !== "passed") {
      // A pending entry carrying an attestation is a half-flipped gate: the
      // fields say a person signed something the status says did not happen.
      if (entry.attestedBy || entry.attestedAt || entry.evidence) {
        problems.push(`${entry.id} is pending but carries an attestation`);
      }
      continue;
    }

    if (!isNonEmptyString(entry.attestedBy)) {
      problems.push(`${entry.id} passed without naming who attested it`);
    }
    if (!isNonEmptyString(entry.attestedAt)) {
      problems.push(`${entry.id} passed without a date`);
    }
    if (!entry.evidence) {
      problems.push(`${entry.id} passed with no evidence`);
      continue;
    }
    for (const [label, value] of [
      ["artifact reference", entry.evidence.artifactRef],
      ["evaluated commit", entry.evidence.evaluatedCommit],
      ["summary", entry.evidence.summary],
      ["re-attestation deadline", entry.evidence.expiresAt],
      ["known limitations", entry.evidence.knownLimitations],
    ] as const) {
      if (!isNonEmptyString(value)) {
        problems.push(`${entry.id} passed with no ${label}`);
      }
    }
    // Readiness is a measurement of a system that keeps changing. An
    // attestation with no deadline would outlive the thing it described.
    const expiresAt = Date.parse(entry.evidence.expiresAt ?? "");
    if (Number.isNaN(expiresAt)) {
      if (isNonEmptyString(entry.evidence.expiresAt)) {
        problems.push(`${entry.id} has a re-attestation deadline that is not a date`);
      }
    } else if (expiresAt <= now()) {
      problems.push(
        `${entry.id}'s attestation expired on ${entry.evidence.expiresAt} and must be renewed`
      );
    }
  }

  return problems;
};

export type ReadinessState = {
  ready: boolean;
  /** Gates not yet attested, in register order. Empty when ready. */
  outstanding: readonly AutoReadinessGateId[];
  /** Register problems. A malformed register is never ready, whatever it says. */
  problems: readonly string[];
};

/**
 * Whether all three gates are attested and the register is well formed.
 *
 * Fails closed on a malformed register rather than reading the entries it can
 * parse: a register that does not validate is a register nobody can rely on,
 * and "two of the three gates look passed" is not a state anything should act
 * on.
 */
export const autoRolloutReadiness = (
  register: readonly AutoReadinessEntry[] = AUTO_ROLLOUT_READINESS,
  now: () => number = Date.now
): ReadinessState => {
  const problems = autoRolloutReadinessProblems(register, now);
  const outstanding = register
    .filter((entry) => entry.status !== "passed")
    .map((entry) => entry.id);
  return {
    ready: problems.length === 0 && outstanding.length === 0,
    outstanding,
    problems,
  };
};
