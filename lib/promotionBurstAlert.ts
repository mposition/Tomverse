import "server-only";

import { sendManagedSlackMessage } from "@/lib/managedSlack";
import { prisma } from "@/lib/prisma";
import {
  PROMOTION_BURST_THRESHOLD,
  PROMOTION_BURST_WINDOW_MINUTES,
  promotionBurstAlertDue,
} from "@/lib/promotionBurstAlertCore";

const appOrigin = () =>
  process.env.PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://tomverse.app";

/**
 * Tells the team on Slack when one promotion is being redeemed in a burst
 * (`lib/promotionBurstAlertCore.ts`). Called after every recorded redemption,
 * refused ones included: a card or region refusal running hot is the same
 * signal as a burst that got through.
 *
 * Best effort and never in the caller's way -- callers catch and log. It
 * blocks nothing: the per-card limit and the country restriction are what
 * refuse; this only makes sure someone looks.
 */
export async function alertOnPromotionBurst(
  promotionId: string,
  now: Date = new Date()
) {
  const since = new Date(
    now.getTime() - PROMOTION_BURST_WINDOW_MINUTES * 60_000
  );
  const inWindow = await prisma.billingPromotionRedemption.count({
    where: { promotionId, redeemedAt: { gte: since } },
  });
  if (!promotionBurstAlertDue(inWindow, PROMOTION_BURST_THRESHOLD)) {
    return { alerted: false as const, inWindow };
  }
  const [flagged, promotion] = await Promise.all([
    prisma.billingPromotionRedemption.count({
      where: { promotionId, redeemedAt: { gte: since }, riskFlags: { not: "[]" } },
    }),
    prisma.billingPromotion.findUnique({
      where: { id: promotionId },
      select: { code: true, redeemedCount: true, maxRedemptions: true },
    }),
  ]);
  if (!promotion) return { alerted: false as const, inWindow };
  await sendManagedSlackMessage({
    key: "promotion_alert",
    variables: {
      code: promotion.code,
      count: inWindow,
      windowMinutes: PROMOTION_BURST_WINDOW_MINUTES,
      flagged,
      used: promotion.redeemedCount,
      cap: promotion.maxRedemptions ?? "none",
      adminUrl: `${appOrigin()}/admin/billing?tab=promotions`,
    },
    webhookUrl:
      process.env.OPS_ALERT_SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL,
    targetType: "BillingPromotion",
    targetId: promotionId,
  });
  return { alerted: true as const, inWindow };
}
