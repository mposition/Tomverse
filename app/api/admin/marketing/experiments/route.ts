export const dynamic = "force-dynamic";

import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_EXPERIMENT_CONFIG_KEY,
  MARKETING_EXPERIMENT_REFUSAL_STATUS,
  MARKETING_EXPERIMENT_START_ACTION,
  MarketingExperimentRefusedError,
  experimentStartBodySchema,
} from "@/lib/marketingExperimentContract";
import { startMarketingExperiment } from "@/lib/marketingExperimentStore";

const schema = experimentStartBodySchema;

/**
 * POST: a person starts a landing experiment (policy 6.1 "실험 활성화", 9.1).
 *
 * The pre-registration is the body: hypothesis, primary metric, minimum
 * sample, stop rule, and the fixed duration. Without all of it nothing is
 * stored. The words of the variant are not in it, because they are not an
 * operator's to type here -- they are a bundle in the repository.
 *
 * It starts something that shows visitors different copy, so the kill switch
 * refuses it and the store asks the shared access resolver for the policy's
 * own row (switch on, spike on record, a person with `marketing:write` and a
 * recent sign-in). The audit entry records the whole pre-registration.
 */
export async function POST(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_EXPERIMENT_START_ACTION,
    targetType: "AppSetting",
    targetId: MARKETING_EXPERIMENT_CONFIG_KEY,
    summary: "Started a landing experiment.",
    gate: "account_control",
    bucket: "admin-marketing-experiment-start",
    schema,
    metadata: (body) => ({
      experimentId: body.experimentId,
      bundleId: body.bundleId,
      variantId: body.variantId,
      locales: body.locales,
      variantRatioPercent: body.variantRatioPercent,
      durationDays: body.durationDays,
      preregistration: body.preregistration,
    }),
    refusal: (error) =>
      error instanceof MarketingExperimentRefusedError
        ? {
            code: error.code,
            status: MARKETING_EXPERIMENT_REFUSAL_STATUS[error.code] ?? 409,
            message: error.message,
          }
        : null,
    run: async (tx, { body }) => {
      const started = await startMarketingExperiment(tx, body);
      return {
        experimentId: started.config.experimentId,
        startsAt: started.config.startsAt,
        endsAt: started.config.endsAt,
        version: started.version,
      };
    },
  });
}
