/**
 * Landing experiments: the rules that do not touch the database.
 *
 * Contract: docs/policy/marketing-automation.md sections 6.1 (experiment
 * activation) and 9.1. The activation setting never carries words (a bundle id
 * and a variant id name code in `components/marketing/landingExperimentBundles.ts`),
 * it always carries the pre-registration, and an experiment that cannot be
 * read is no experiment: every function here that decides "active" answers
 * false on anything it does not recognise.
 */

import { z } from "zod";

import { landingVariantLocales } from "@/components/marketing/landingExperimentBundles";
import { EXPERIMENT_CONTROL_ARM } from "@/lib/marketingRoutes";

export const MARKETING_EXPERIMENT_CONFIG_KEY =
  "marketingAutomation.experimentConfig";
/** One counter row per experiment, arm and metric; the suffix is built by `experimentCounterKey`. */
export const MARKETING_EXPERIMENT_COUNTER_PREFIX =
  "marketingAutomation.experimentCount.";

export const MARKETING_EXPERIMENT_START_ACTION = "marketing_experiment.started";
export const MARKETING_EXPERIMENT_STOP_ACTION = "marketing_experiment.stopped";
export const MARKETING_EXPERIMENT_REPORT_SOURCE_VERSION =
  "marketing-experiment-counters-v1";

/**
 * The cache, CSP and rewrite spike (policy 9.1: "구현 전 ... 스파이크를 E2E로
 * 통과"; 6.1: "스파이크 통과 기록"). It is a record in code because it is a
 * statement about this build: the E2E spec exists, ran against a production
 * build and passed. A test refuses this constant if the spec file is gone.
 */
export const MARKETING_EXPERIMENT_SPIKE = Object.freeze({
  passed: true,
  e2eSpec: "tests/e2e/landing-experiment-spike.spec.ts",
  recordedAt: "2026-11-01",
});

export const EXPERIMENT_MAX_DURATION_DAYS = 56;
export const EXPERIMENT_MAX_VARIANT_RATIO = 0.5;
export const EXPERIMENT_METRICS = ["primary_cta_click"] as const;
export const EXPERIMENT_EVENT_KINDS = ["exposure", "conversion"] as const;
export type ExperimentEventKind = (typeof EXPERIMENT_EVENT_KINDS)[number];
export const EXPERIMENT_LOCALES = [
  "en",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "pt",
] as const;

export const experimentIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{2,47}$/, "lowercase letters, digits and dashes, 3 to 48 characters");

/** A variant id is a short label such as `b`; it must match the cookie's arm pattern. */
export const experimentVariantIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "lowercase letters, digits and dashes");

const isoInstant = z.iso.datetime({ offset: true });

/**
 * What an operator commits to before the first visitor is assigned
 * (policy 9.1: hypothesis, primary metric, minimum sample, fixed duration,
 * stop rule). The fixed duration is `startsAt`/`endsAt` on the configuration.
 */
export const experimentPreregistrationSchema = z
  .object({
    hypothesis: z.string().trim().min(20).max(500),
    primaryMetric: z.enum(EXPERIMENT_METRICS),
    minExposuresPerArm: z.number().int().min(100).max(1_000_000),
    stopRule: z
      .object({
        /** Stop when the variant's rate is this far below the control's, relative. */
        relativeDropPercent: z.number().min(5).max(100),
        /** Not before each arm has this many exposures. */
        afterExposuresPerArm: z.number().int().min(50).max(1_000_000),
      })
      .strict(),
  })
  .strict();
export type ExperimentPreregistration = z.infer<
  typeof experimentPreregistrationSchema
>;

export const experimentConfigSchema = z
  .object({
    version: z.literal(1),
    experimentId: experimentIdSchema,
    bundleId: experimentIdSchema.refine((value) => value.startsWith("home-"), {
      message: "only home bundles can be activated",
    }),
    variantId: experimentVariantIdSchema.refine(
      (value) => value !== EXPERIMENT_CONTROL_ARM,
      { message: "the variant cannot be called control" }
    ),
    locales: z.array(z.enum(EXPERIMENT_LOCALES)).min(1).max(7),
    /** The variant's share of assigned visitors; the rest see the default. */
    variantRatio: z.number().gt(0).max(EXPERIMENT_MAX_VARIANT_RATIO),
    startsAt: isoInstant,
    endsAt: isoInstant,
    preregistration: experimentPreregistrationSchema,
    status: z.enum(["running", "stopped"]),
    stoppedAt: isoInstant.nullable(),
  })
  .strict()
  .superRefine((config, context) => {
    const start = Date.parse(config.startsAt);
    const end = Date.parse(config.endsAt);
    if (!(end > start)) {
      context.addIssue({ code: "custom", message: "endsAt must follow startsAt" });
    } else if (end - start > EXPERIMENT_MAX_DURATION_DAYS * 86_400_000) {
      context.addIssue({
        code: "custom",
        message: `an experiment runs at most ${EXPERIMENT_MAX_DURATION_DAYS} days`,
      });
    }
    const covered = landingVariantLocales(config.bundleId, config.variantId);
    for (const locale of config.locales) {
      if (!covered.includes(locale)) {
        context.addIssue({
          code: "custom",
          message: `the variant has no copy for ${locale}`,
        });
      }
    }
  });
export type ExperimentConfig = z.infer<typeof experimentConfigSchema>;

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
