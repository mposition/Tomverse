/**
 * Landing experiments: the rules that do not touch the database.
 *
 * Policy: docs/policy/marketing-automation.md sections 6.1 (experiment
 * activation) and 9.1. The activation setting never carries words (a bundle id
 * and a variant id name code in `components/marketing/landingExperimentBundles.ts`),
 * it always carries the pre-registration, and an experiment that cannot be
 * read is no experiment: every function here that decides "active" answers
 * false on anything it does not recognise.
 *
 * Names, schemas, the request bodies and the refusal error are in
 * `lib/marketingExperimentContract.ts` (re-exported here), because the admin
 * routes may import only modules that do not reach the marketing store.
 */

import {
  EXPERIMENT_MAX_DURATION_DAYS,
  MARKETING_EXPERIMENT_COUNTER_PREFIX,
  experimentConfigSchema,
  type ExperimentConfig,
  type ExperimentEventKind,
  type ExperimentPreregistration,
} from "@/lib/marketingExperimentContract";
import { EXPERIMENT_CONTROL_ARM } from "@/lib/marketingRoutes";

export const parseExperimentConfig = (
  raw: string | null | undefined
): ExperimentConfig | null => {
  if (!raw) return null;
  try {
    const parsed = experimentConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export type ExperimentCounts = Readonly<{
  controlExposures: number;
  controlConversions: number;
  variantExposures: number;
  variantConversions: number;
}>;

export const EMPTY_EXPERIMENT_COUNTS: ExperimentCounts = Object.freeze({
  controlExposures: 0,
  controlConversions: 0,
  variantExposures: 0,
  variantConversions: 0,
});

export const experimentCounterKey = (
  experimentId: string,
  arm: string,
  kind: ExperimentEventKind
) => `${MARKETING_EXPERIMENT_COUNTER_PREFIX}${experimentId}.${arm}.${kind}`;

/** Counter rows -> the four numbers. A malformed value reads as zero, never as a guess. */
export const experimentCountsFromRows = (
  config: Pick<ExperimentConfig, "experimentId" | "variantId">,
  rows: ReadonlyMap<string, string>
): ExperimentCounts => {
  const read = (arm: string, kind: ExperimentEventKind) => {
    const value = rows.get(experimentCounterKey(config.experimentId, arm, kind));
    return value && /^\d{1,12}$/.test(value) ? Number(value) : 0;
  };
  return {
    controlExposures: read(EXPERIMENT_CONTROL_ARM, "exposure"),
    controlConversions: read(EXPERIMENT_CONTROL_ARM, "conversion"),
    variantExposures: read(config.variantId, "exposure"),
    variantConversions: read(config.variantId, "conversion"),
  };
};

const rate = (conversions: number, exposures: number) =>
  exposures > 0 ? conversions / exposures : null;

export const experimentRates = (counts: ExperimentCounts) => ({
  control: rate(counts.controlConversions, counts.controlExposures),
  variant: rate(counts.variantConversions, counts.variantExposures),
});

/**
 * The pre-registered stop rule, evaluated on the counters. It stops nothing by
 * itself: `resolveActiveExperiment` treats a triggered rule as a stopped
 * experiment, so no unaudited write is needed to honour it.
 */
export const experimentStopRuleTriggered = (
  preregistration: ExperimentPreregistration,
  counts: ExperimentCounts
) => {
  const { relativeDropPercent, afterExposuresPerArm } = preregistration.stopRule;
  if (
    counts.controlExposures < afterExposuresPerArm ||
    counts.variantExposures < afterExposuresPerArm
  ) {
    return false;
  }
  const { control, variant } = experimentRates(counts);
  if (control === null || variant === null || control === 0) return false;
  return (control - variant) / control >= relativeDropPercent / 100;
};

export type ActiveExperimentResolution =
  | { active: true; config: ExperimentConfig }
  | {
      active: false;
      reason: "stopped" | "not_started" | "ended" | "stop_rule";
    };

export const resolveActiveExperiment = (
  config: ExperimentConfig,
  counts: ExperimentCounts,
  now: Date
): ActiveExperimentResolution => {
  if (config.status !== "running") return { active: false, reason: "stopped" };
  const time = now.getTime();
  if (time < Date.parse(config.startsAt)) {
    return { active: false, reason: "not_started" };
  }
  if (time >= Date.parse(config.endsAt)) return { active: false, reason: "ended" };
  if (experimentStopRuleTriggered(config.preregistration, counts)) {
    return { active: false, reason: "stop_rule" };
  }
  return { active: true, config };
};

/** `roll` in [0, 1): below the ratio is the variant. */
export const pickExperimentArm = (
  config: Pick<ExperimentConfig, "variantId" | "variantRatio">,
  roll: number
) => (roll < config.variantRatio ? config.variantId : EXPERIMENT_CONTROL_ARM);

/**
 * Whether analytics is on for this visitor, by the same rule the consent
 * provider applies (components/analytics/AnalyticsProvider.tsx,
 * `analyticsEnabled`): accepted, or undecided where the policy is a notice
 * with opt-out. Anything else is off, and off means the default copy and no
 * measurement at all.
 */
export const experimentAnalyticsActive = (
  consent: "accepted" | "declined" | "unset",
  mode: "opt_in" | "notice_opt_out"
) => consent === "accepted" || (consent === "unset" && mode === "notice_opt_out");

export const experimentCookieMaxAgeSeconds = (config: ExperimentConfig, now: Date) =>
  Math.max(
    0,
    Math.min(
      Math.floor((Date.parse(config.endsAt) - now.getTime()) / 1000),
      EXPERIMENT_MAX_DURATION_DAYS * 86_400
    )
  );
