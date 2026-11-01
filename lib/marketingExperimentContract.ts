/**
 * The vocabulary of landing experiments that a route may import without
 * reaching the marketing store: names, the strict schemas, the request
 * bodies and the refusal error.
 *
 * Kept free of every local import except the copy bundles (which import
 * nothing). `tests/marketingS2b1Store.test.mjs` reads each marketing admin
 * route and treats any module that reaches `lib/marketingStore.ts` within two
 * helpers as the store itself, which may be mentioned only inside the
 * mutation's transaction. A route that needs an action name or a schema
 * outside it therefore cannot import them from a module that imports the
 * store, or the routing rules, or anything further down.
 *
 * Policy: docs/policy/marketing-automation.md sections 6.1 and 9.1.
 */

import { z } from "zod";

import { landingVariantLocales } from "@/components/marketing/landingExperimentBundles";

/** The same word as `EXPERIMENT_CONTROL_ARM` in `lib/marketingRoutes.ts`; a test holds them equal. */
const CONTROL_ARM = "control";

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
      (value) => value !== CONTROL_ARM,
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

export const experimentStartBodySchema = z
  .object({
    experimentId: experimentIdSchema,
    bundleId: z.string().min(3).max(48),
    variantId: z.string().min(1).max(48),
    locales: z.array(z.enum(EXPERIMENT_LOCALES)).min(1).max(7),
    /** The variant's share, in whole percent: 1 to 50. */
    variantRatioPercent: z.number().int().min(1).max(50),
    durationDays: z.number().int().min(1).max(EXPERIMENT_MAX_DURATION_DAYS),
    preregistration: experimentPreregistrationSchema,
    /** The row's version the screen read; null while nothing was ever saved. */
    expectedVersion: z.string().max(64).nullable(),
  })
  .strict();
export type ExperimentStartBody = z.infer<typeof experimentStartBodySchema>;

export const experimentStopBodySchema = z
  .object({ expectedVersion: z.string().max(64) })
  .strict();
export type ExperimentStopBody = z.infer<typeof experimentStopBodySchema>;

export class MarketingExperimentRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketingExperimentRefusedError";
    this.code = code;
  }
}

export const MARKETING_EXPERIMENT_REFUSAL_STATUS: Readonly<Record<string, number>> = {
  experiment_not_admitted: 409,
  experiment_config_invalid: 422,
  experiment_conflict: 409,
  experiment_running: 409,
  experiment_id_used: 409,
  experiment_not_running: 409,
};
