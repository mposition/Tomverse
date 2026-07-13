import "server-only";

import { APP_DEFAULTS } from "@/lib/appDefaults";
import {
  getBillingPlanByTier,
  type BillingPlanConfig,
} from "@/lib/billingConfig";
import type { ModelTier } from "@/lib/models";
import { prisma } from "@/lib/prisma";

export type BillingFeature =
  | "attachments"
  | "sharing"
  | "downloads";

const normalizePlanTier = (value: unknown): ModelTier =>
  value === "Pro" || value === "Max" || value === "Free" ? value : "Free";

export const getUserBillingPlan = async (
  userId: string
): Promise<BillingPlanConfig> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true },
  });
  return getBillingPlanByTier(normalizePlanTier(user?.plan));
};

export const effectivePlanModelLimit = (plan: BillingPlanConfig) =>
  Math.max(
    1,
    Math.min(APP_DEFAULTS.maxSelectedModels, Math.trunc(plan.maxModels))
  );

export const planAllowsFeature = (
  plan: BillingPlanConfig,
  feature: BillingFeature
) => {
  if (feature === "attachments") return plan.allowAttachments;
  if (feature === "sharing") return plan.allowSharing;
  return plan.allowDownloads;
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
