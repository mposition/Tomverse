import * as Sentry from "@sentry/nextjs";
import { isNextNoFallbackError } from "@/lib/operationalMonitoringCore";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    await reportCostConfigurationIssues();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Startup half of the pricing/guardrail configuration guard (the other half is
// `npm run check:model-pricing` in CI). Deliberately warns rather than refusing
// to boot: an instance that will not start cannot serve the models that *are*
// priced correctly, and every problem here already fails the PR gate.
async function reportCostConfigurationIssues() {
  try {
    const [{ AVAILABLE_MODELS }, { findUnpricedModels }, guardrails] =
      await Promise.all([
        import("@/lib/models"),
        import("@/lib/modelPricing"),
        import("@/lib/chatCostGuardrails"),
      ]);

    const unpricedPremium = findUnpricedModels(AVAILABLE_MODELS).filter(
      (entry) => entry.costClass === "premium"
    );
    if (unpricedPremium.length > 0) {
      console.warn(
        JSON.stringify({
          event: "model_pricing_fallback_in_use",
          severity: "warning",
          modelIds: unpricedPremium.map((entry) => entry.modelId),
          message:
            "Enabled premium models have no explicit billing profile and are internally priced at the conservative generic premium rate.",
        })
      );
    }

    const retired = guardrails.findRetiredCostLimitEnvNames();
    if (retired.length > 0) {
      console.warn(
        JSON.stringify({
          event: "retired_cost_limit_env_ignored",
          severity: "warning",
          names: retired,
          message:
            "These environment variables held the old per-user USD entitlement ceiling and are no longer read. Configure CHAT_COST_GUARDRAIL_* instead.",
        })
      );
    }
  } catch (error) {
    console.warn("Cost configuration check failed to run:", error);
  }
}

export const onRequestError: typeof Sentry.captureRequestError = (
  error,
  request,
  context
) => {
  // Next.js uses this as an internal route-fallback control signal. It is not
  // an application failure and should not be reported as an incident.
  if (isNextNoFallbackError(error)) {
    return;
  }
  Sentry.captureRequestError(error, request, context);
};
