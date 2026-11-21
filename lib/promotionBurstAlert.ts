import "server-only";

import { sendManagedSlackMessage } from "@/lib/managedSlack";
import { prisma } from "@/lib/prisma";
import {
  PROMOTION_BURST_THRESHOLD,
  PROMOTION_BURST_WINDOW_MINUTES,
  promotionBurstAlertKey,
  promotionBurstBand,
} from "@/lib/promotionBurstAlertCore";

const appOrigin = () =>
  process.env.PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://tomverse.app";

const isUniqueViolation = (error: unknown) =>
  Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "P2002"
  );

/**
 * Claims the right to report one burst band. The first redemption to insert
 * the band's key reports it; every other one, concurrent or later, finds the
 * key taken. A short-lived `ChatRequestLease` row, as the promotion checkout
 * lease already uses, so no table is added for a dedupe key.
 */
async function claimBurstBand(key: string, now: Date) {
  const expiresAt = new Date(
    now.getTime() + 2 * PROMOTION_BURST_WINDOW_MINUTES * 60_000
  );
  await prisma.chatRequestLease.deleteMany({
    where: { id: key, expiresAt: { lte: now } },
  });
  try {
    await prisma.chatRequestLease.create({
      data: { id: key, subjectKey: key, expiresAt },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

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
  const band = promotionBurstBand(inWindow, PROMOTION_BURST_THRESHOLD);
  if (band === null) return { alerted: false as const, inWindow };
  if (!(await claimBurstBand(promotionBurstAlertKey(promotionId, band, now), now))) {
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
