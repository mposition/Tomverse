export const dynamic = "force-dynamic";

import { runMarketingAdminMutation } from "@/lib/marketingAdminMutations";
import {
  MARKETING_EXPERIMENT_CONFIG_KEY,
  MARKETING_EXPERIMENT_REFUSAL_STATUS,
  MARKETING_EXPERIMENT_STOP_ACTION,
  MarketingExperimentRefusedError,
  experimentStopBodySchema,
} from "@/lib/marketingExperimentContract";
import { stopMarketingExperiment } from "@/lib/marketingExperimentStore";

const schema = experimentStopBodySchema;

/**
 * POST: a person stops the running landing experiment and keeps its figures.
 *
 * Gated on nothing but the person: a stop that the experiments switch or the
 * kill switch could refuse is not a stop. The counters at this moment become
 * the two `experiment_result` reports, one per arm, in the same transaction as
 * the audit entry. Visitors who still hold an assignment cookie return to the
 * default copy on their next landing view, when the route deletes it.
 */
export async function POST(req: Request) {
  return runMarketingAdminMutation({
    request: req,
    action: MARKETING_EXPERIMENT_STOP_ACTION,
    targetType: "AppSetting",
    targetId: MARKETING_EXPERIMENT_CONFIG_KEY,
    summary: "Stopped the landing experiment.",
    gate: "operator_restriction",
    bucket: "admin-marketing-experiment-stop",
    schema,
    metadata: () => ({}),
    refusal: (error) =>
      error instanceof MarketingExperimentRefusedError
        ? {
            code: error.code,
            status: MARKETING_EXPERIMENT_REFUSAL_STATUS[error.code] ?? 409,
            message: error.message,
          }
        : null,
    run: async (tx, { body }) => {
      const stopped = await stopMarketingExperiment(tx, body);
      return { counts: stopped.counts, reportIds: stopped.reportIds };
    },
  });
}
