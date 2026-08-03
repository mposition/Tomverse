import "server-only";

import { APP_DEFAULTS } from "@/lib/appDefaults";
import {
  getBillingPlanByTier,
  type BillingPlanConfig,
} from "@/lib/billingConfig";
import { planAllowsImageGeneration } from "@/lib/imageGenerationAccess";
import type { ModelTier } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { effectivePlanForAccess } from "@/lib/foundingTesterPassCore";

export type BillingFeature =
  | "attachments"
  | "sharing"
  | "downloads"
  | "imageGeneration";

const normalizePlanTier = (value: unknown): ModelTier =>
  value === "Pro" || value === "Max" || value === "Free" ? value : "Free";

export const getUserBillingPlan = async (
  userId: string
): Promise<BillingPlanConfig> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      plan: true,
      subscriptionStatus: true,
      subscriptionCurrentPeriodEnd: true,
    },
  });
  return getBillingPlanByTier(
    normalizePlanTier(
      effectivePlanForAccess({
        plan: user?.plan,
        subscriptionStatus: user?.subscriptionStatus,
        subscriptionCurrentPeriodEnd: user?.subscriptionCurrentPeriodEnd,
      })
    )
  );
};

export const effectivePlanModelLimit = (plan: BillingPlanConfig) =>
  Math.max(
    1,
    Math.min(APP_DEFAULTS.maxSelectedModels, Math.trunc(plan.maxModels))
  );

// Exhaustive on purpose. The previous if-chain fell through to
// `allowDownloads` (true on every plan) for any feature it did not know
// about, which would have silently opened a newly added feature to Free the
// moment someone extended the union without touching this function. The
// `never` check makes that mistake a compile error; the runtime `false` is
// the fail-closed answer for an unrecognised value from stale callers.
export const planAllowsFeature = (
  plan: BillingPlanConfig,
  feature: BillingFeature
): boolean => {
  switch (feature) {
    case "attachments":
      return plan.allowAttachments;
    case "sharing":
      return plan.allowSharing;
    case "downloads":
      return plan.allowDownloads;
    case "imageGeneration":
      return planAllowsImageGeneration(plan.tier);
    default: {
      const unhandled: never = feature;
      void unhandled;
      return false;
    }
  }
};

export const featureNotIncludedResponse = (feature: BillingFeature) =>
  Response.json(
    {
      error: `Your plan does not include ${feature}.`,
      code: "PLAN_FEATURE_NOT_INCLUDED",
      feature,
    },
    {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    }
  );

export const modelLimitResponse = (maxModels: number) =>
  Response.json(
    {
      error: `Your plan allows up to ${maxModels} models per conversation.`,
      code: "PLAN_MODEL_LIMIT_EXCEEDED",
      maxModels,
    },
    {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    }
  );
