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

import {
  LANDING_EXPERIMENT_LOCALES,
  landingVariantLocales,
} from "@/components/marketing/landingExperimentBundles";

/** The same word as `EXPERIMENT_CONTROL_ARM` in `lib/marketingRoutes.ts`; a test holds them equal. */
const CONTROL_ARM = "control";

export const MARKETING_EXPERIMENT_CONFIG_KEY =
  "marketingAutomation.experimentConfig";
/** One counter row per experiment, arm and metric; the suffix is built by `experimentCounterKey`. */
export const MARKETING_EXPERIMENT_COUNTER_PREFIX =
  "marketingAutomation.experimentCount.";

/**
 * One row per experiment whose pre-registered stop rule has been met, written
 * once (`ON CONFLICT DO NOTHING`) by the counting route and never changed. The
 * rule is evaluated on counters that keep moving, so on its own it could stop
 * an experiment and then, after a late click is counted, let it resume; this
 * row is what makes a met stop rule stay met. It is the same kind of record as
 * the counters (a fact derived from them, with no operator decision in it);
 * the person's Stop is still what writes the audit entry and the reports.
 */
export const MARKETING_EXPERIMENT_TRIPPED_PREFIX =
  "marketingAutomation.experimentTripped.";

/**
 * One row per experiment id ever started, never deleted. The stored
 * configuration holds only the latest run and the counters can be absent for
 * a run nobody saw, so neither can say that an id was used; this row can. An
 * id is never reused because an assignment cookie from the earlier run would
 * otherwise be a valid assignment in the new one.
 */
export const MARKETING_EXPERIMENT_USED_PREFIX =
  "marketingAutomation.experimentUsed.";

export const MARKETING_EXPERIMENT_START_ACTION = "marketing_experiment.started";
export const MARKETING_EXPERIMENT_STOP_ACTION = "marketing_experiment.stopped";
/**
 * The audit action for the experiments switch (operator decision 2026-11-04).
 * Declared here beside the start and stop actions, not in
 * `MARKETING_S2B1_ACTIONS`: that list is in `lib/marketingStore.ts`, which the
 * webhook receiver loads, so a new entry there is a change to code the
 * pipeline fingerprint covers and would stale the signed verification record.
 */
export const MARKETING_EXPERIMENT_SWITCH_ACTION =
  "marketing_setting.experiments_changed";
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
export const EXPERIMENT_LOCALES = LANDING_EXPERIMENT_LOCALES;

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
    if (new Set(config.locales).size !== config.locales.length) {
      // A repeated language would be written into the assignment cookie, which
      // refuses it, and then no visitor could ever be served the variant.
      context.addIssue({ code: "custom", message: "locales must be unique" });
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
