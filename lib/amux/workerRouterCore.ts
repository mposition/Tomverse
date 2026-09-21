import type { AmuxRoutingSnapshot } from "@/lib/amux/routing";

const NEUTRAL_PRIOR = 0.5;

const W_TASK_FIT = 0.30;
const W_PREDICTED_SUCCESS = 0.20;
const W_QUOTA_REMAINING = 0.20;
const W_EXPECTED_SPEED = 0.10;
const W_LOW_REWORK = 0.10;
const W_LOW_HUMAN_ATTENTION = 0.05;
const W_COST_EFFICIENCY = 0.05;

const INTRINSIC_WEIGHT_TOTAL = 0.80;

type EligibleSnapshot = Extract<
  AmuxRoutingSnapshot,
  { eligible: true }
>;

export type AmuxRoutingTask =
  EligibleSnapshot["task"];

type SnapshotRoutingCandidate =
  EligibleSnapshot["candidates"][number];

/**
 * Pure scorer input.
 *
 * The authoritative snapshot supplies confidence-adjusted historical, quota
 * and cost observations. Missing/stale evidence remains `null`, which this
 * scorer represents as an explicit neutral prior. Rust uses the same input
 * and algorithm.
 */
export type AmuxRoutingCandidate =
  Omit<
    SnapshotRoutingCandidate,
    | "predicted_success"
    | "quota_remaining"
    | "expected_speed"
    | "low_rework"
    | "low_human_attention"
    | "cost_efficiency"
    | "provider_exhausted"
  > & {
    predicted_success: number | null;
    quota_remaining: number | null;
    expected_speed: number | null;
    low_rework: number | null;
    low_human_attention: number | null;
    cost_efficiency: number | null;
    provider_exhausted: boolean;
  };

export type AmuxMetricBreakdown = {
  value: number;
  observed: boolean;
};

export type AmuxTaskFitBreakdown = {
  role_fit: number;
  provider_fit: number;
  combined: number;
  large_task: boolean;
};

export type AmuxCandidateScoreBreakdown = {
  task_fit: AmuxTaskFitBreakdown;
  predicted_success: AmuxMetricBreakdown;
  quota_remaining: AmuxMetricBreakdown;
  expected_speed: AmuxMetricBreakdown;
  low_rework: AmuxMetricBreakdown;
  low_human_attention: AmuxMetricBreakdown;
  cost_efficiency: AmuxMetricBreakdown;
  selected_score: number;
  intrinsic_score: number;
  operationally_allowed: boolean;
  provider_exhausted: boolean;
  selected_eligible: boolean;
};

export type AmuxScoredWorker = {
  worker_name: string;
  provider: string;
  breakdown: AmuxCandidateScoreBreakdown;
};

export type AmuxRoutingScoreResult = {
  preferred_worker: string | null;
  selected_worker: string | null;
  preferred_score: number | null;
  selected_score: number | null;
  candidates: AmuxScoredWorker[];
};

const clamp01 = (value: number) =>
  Math.max(0, Math.min(1, value));

const metric = (
  value: number | null,
): AmuxMetricBreakdown => {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return {
      value: clamp01(value),
      observed: true,
    };
  }

  return {
    value: NEUTRAL_PRIOR,
    observed: false,
  };
};

const roleFit = (
  kind: string,
  roles: readonly string[],
  largeTask: boolean,
) => {
  const has = (role: string) =>
    roles.includes(role);

  let fit = has(kind) ? 1 : 0;

  switch (kind) {
    case "architecture":
      if (has("reasoning")) fit = Math.max(fit, 0.85);
      if (has("contract")) fit = Math.max(fit, 0.80);
      if (has("review")) fit = Math.max(fit, 0.55);
      break;

    case "reasoning":
      if (has("architecture")) fit = Math.max(fit, 0.85);
      if (has("review")) fit = Math.max(fit, 0.65);
      break;

    case "feature":
      if (has("implementation")) fit = Math.max(fit, 0.90);
      if (largeTask && has("multi_file")) {
        fit = Math.max(fit, 0.90);
      }
      if (largeTask && has("long_running")) {
        fit = Math.max(fit, 0.80);
      }
      break;

    case "bugfix":
      if (has("implementation")) fit = Math.max(fit, 0.85);
      if (has("reasoning")) fit = Math.max(fit, 0.80);
      if (has("tests")) fit = Math.max(fit, 0.65);
      break;

    case "iteration":
      if (has("implementation")) fit = Math.max(fit, 0.70);
      if (has("bugfix")) fit = Math.max(fit, 0.70);
      break;

    case "refactor":
      if (has("implementation")) fit = Math.max(fit, 0.85);
      if (largeTask && has("multi_file")) {
        fit = Math.max(fit, 0.90);
      }
      break;

    case "migration":
      if (has("implementation")) fit = Math.max(fit, 0.65);
      if (has("reasoning")) fit = Math.max(fit, 0.65);
      if (has("multi_file")) fit = Math.max(fit, 0.85);
      break;

    case "dependency_upgrade":
      if (has("implementation")) fit = Math.max(fit, 0.60);
      if (has("tests")) fit = Math.max(fit, 0.75);
      if (has("multi_file")) fit = Math.max(fit, 0.70);
      break;

    case "tests":
      if (has("implementation")) fit = Math.max(fit, 0.60);
      if (has("bugfix")) fit = Math.max(fit, 0.65);
      if (has("integration")) fit = Math.max(fit, 0.70);
      break;

    case "review":
      if (has("contract")) fit = Math.max(fit, 0.80);
      if (has("security")) fit = Math.max(fit, 0.75);
      if (has("architecture")) fit = Math.max(fit, 0.70);
      break;

    case "security":
      if (has("review")) fit = Math.max(fit, 0.85);
      if (has("reasoning")) fit = Math.max(fit, 0.85);
      if (has("architecture")) fit = Math.max(fit, 0.75);
      break;

    case "integration":
      if (has("tests")) fit = Math.max(fit, 0.75);
      if (has("bugfix")) fit = Math.max(fit, 0.60);
      break;
  }

  if (has("fallback")) {
    fit = Math.max(fit, 0.25);
  }

  return clamp01(fit);
};

const providerFit = (
  kind: string,
  providerRaw: string,
  largeTask: boolean,
) => {
  const provider =
    providerRaw.trim().toLowerCase();

  const isClaude =
    provider === "claude" ||
    provider === "claude-code";

  const isCodex = provider === "codex";
  const isDevin = provider === "devin";

  switch (kind) {
    case "architecture":
    case "reasoning":
    case "security":
      if (isClaude) return 1;
      if (isCodex) return 0.75;
      if (isDevin) return 0.45;
      return 0.50;

    case "feature":
      if (largeTask) {
        if (isDevin) return 1;
        if (isCodex) return 0.95;
        if (isClaude) return 0.85;
        return 0.50;
      }

      if (isCodex) return 1;
      if (isDevin) return 0.95;
      if (isClaude) return 0.85;
      return 0.50;

    case "bugfix":
      if (isClaude) return 1;
      if (isCodex) return 0.95;
      if (isDevin) return 0.75;
      return 0.50;

    case "iteration":
    case "integration":
      if (isCodex) return 1;
      if (isClaude) return 0.75;
      if (isDevin) return 0.65;
      return 0.50;

    case "refactor":
      if (largeTask) {
        if (isDevin) return 1;
        if (isCodex) return 0.95;
        if (isClaude) return 0.85;
        return 0.50;
      }

      if (isCodex) return 1;
      if (isDevin) return 0.90;
      if (isClaude) return 0.85;
      return 0.50;

    case "migration":
      if (isDevin) return 1;
      if (isClaude) return 0.85;
      if (isCodex) return 0.80;
      return 0.50;

    case "dependency_upgrade":
      if (isDevin) return 1;
      if (isCodex) return 0.90;
      if (isClaude) return 0.70;
      return 0.50;

    case "tests":
      if (isCodex) return 1;
      if (isDevin) return 0.90;
      if (isClaude) return 0.75;
      return 0.50;

    case "review":
      return isClaude || isCodex
        ? 1
        : 0.50;

    default:
      return 0.50;
  }
};

const taskFit = (
  task: AmuxRoutingTask,
  candidate: AmuxRoutingCandidate,
): AmuxTaskFitBreakdown => {
  const largeTask =
    task.complexity >= 7 ||
    (task.files_expected ?? 0) >= 6;

  const role = roleFit(
    task.task_kind,
    candidate.worker.routing_roles,
    largeTask,
  );

  const provider = providerFit(
    task.task_kind,
    candidate.worker.provider,
    largeTask,
  );

  return {
    role_fit: role,
    provider_fit: provider,
    combined: clamp01(
      0.75 * role +
        0.25 * provider,
    ),
    large_task: largeTask,
  };
};

const scoreOne = (
  task: AmuxRoutingTask,
  candidate: AmuxRoutingCandidate,
): AmuxScoredWorker => {
  const fit = taskFit(task, candidate);

  const predictedSuccess =
    metric(candidate.predicted_success);

  const quotaRemaining =
    candidate.provider_exhausted
      ? {
          value: 0,
          observed: true,
        }
      : metric(candidate.quota_remaining);

  const expectedSpeed =
    metric(candidate.expected_speed);

  const lowRework =
    metric(candidate.low_rework);

  const lowHumanAttention =
    metric(candidate.low_human_attention);

  const costEfficiency =
    metric(candidate.cost_efficiency);

  const selectedScore =
    W_TASK_FIT * fit.combined +
    W_PREDICTED_SUCCESS *
      predictedSuccess.value +
    W_QUOTA_REMAINING *
      quotaRemaining.value +
    W_EXPECTED_SPEED *
      expectedSpeed.value +
    W_LOW_REWORK *
      lowRework.value +
    W_LOW_HUMAN_ATTENTION *
      lowHumanAttention.value +
    W_COST_EFFICIENCY *
      costEfficiency.value;

  const intrinsicScore =
    (
      W_TASK_FIT * fit.combined +
      W_PREDICTED_SUCCESS *
        predictedSuccess.value +
      W_EXPECTED_SPEED *
        expectedSpeed.value +
      W_LOW_REWORK *
        lowRework.value +
      W_LOW_HUMAN_ATTENTION *
        lowHumanAttention.value +
      W_COST_EFFICIENCY *
        costEfficiency.value
    ) /
    INTRINSIC_WEIGHT_TOTAL;

  const operationallyAllowed =
    !candidate.worker.archived &&
    !candidate.worker.paused &&
    !candidate.worker.isolated &&
    !candidate.worker.blocked;

  const selectedEligible =
    operationallyAllowed &&
    !candidate.provider_exhausted &&
    candidate.worker.running &&
    candidate.worker.status.toLowerCase() === "idle" &&
    candidate.worker.dispatch_ready;

  return {
    worker_name:
      candidate.worker.worker_name,
    provider:
      candidate.worker.provider,
    breakdown: {
      task_fit: fit,
      predicted_success:
        predictedSuccess,
      quota_remaining:
        quotaRemaining,
      expected_speed:
        expectedSpeed,
      low_rework:
        lowRework,
      low_human_attention:
        lowHumanAttention,
      cost_efficiency:
        costEfficiency,
      selected_score:
        selectedScore,
      intrinsic_score:
        intrinsicScore,
      operationally_allowed:
        operationallyAllowed,
      provider_exhausted:
        candidate.provider_exhausted,
      selected_eligible:
        selectedEligible,
    },
  };
};

const workerNameCompare = (
  left: AmuxScoredWorker,
  right: AmuxScoredWorker,
) =>
  left.worker_name < right.worker_name
    ? -1
    : left.worker_name > right.worker_name
      ? 1
      : 0;

const bestBy = (
  candidates: readonly AmuxScoredWorker[],
  selected: boolean,
) =>
  [...candidates]
    .filter((candidate) =>
      selected
        ? candidate.breakdown
            .selected_eligible
        : candidate.breakdown
            .operationally_allowed,
    )
    .sort((left, right) => {
      const leftScore = selected
        ? left.breakdown.selected_score
        : left.breakdown.intrinsic_score;

      const rightScore = selected
        ? right.breakdown.selected_score
        : right.breakdown.intrinsic_score;

      return (
        rightScore - leftScore ||
        workerNameCompare(left, right)
      );
    })[0] ?? null;

export const scoreAmuxWorkers = (
  task: AmuxRoutingTask,
  candidates: readonly AmuxRoutingCandidate[],
): AmuxRoutingScoreResult => {
  const scored = candidates
    .map((candidate) =>
      scoreOne(task, candidate),
    )
    .sort(workerNameCompare);

  const preferred =
    bestBy(scored, false);

  const selected =
    bestBy(scored, true);

  return {
    preferred_worker:
      preferred?.worker_name ?? null,
    selected_worker:
      selected?.worker_name ?? null,
    preferred_score:
      preferred?.breakdown
        .intrinsic_score ?? null,
    selected_score:
      selected?.breakdown
        .selected_score ?? null,
    candidates: scored,
  };
};
