import "server-only";

import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  MARKETING_HALT_SETTING_KEY,
  MARKETING_HEALTH_WINDOW_DAYS,
  marketingSendHealth,
  parseMarketingHalt,
  type MarketingHaltState,
  type MarketingSendCounts,
} from "@/lib/marketingSendHealthCore";

/**
 * The kill switch §14.5 asks for, wired to the rows the webhook already writes.
 *
 * Contract: docs/policy/email-notifications.md §14.5,
 * .github/audits/model-lifecycle-email-2026-08-22.md EM-09.
 *
 * Marketing only, and that boundary is the important half. Provider suppression
 * is account-wide (§5.3.1), so the failure this guards against ends with login
 * codes not arriving -- and a kill switch that could stop transactional mail
 * would be a second way to reach the same place.
 */

const windowStart = (now: Date) =>
  new Date(now.getTime() - MARKETING_HEALTH_WINDOW_DAYS * 86_400_000);

/**
 * Marketing messages the provider accepted in the window, and how many went
 * wrong.
 *
 * Counted from delivery rows rather than from suppression entries because a
 * suppression is per address and survives the message: an address suppressed
 * last month would keep counting against this month's sends.
 */
export const marketingSendCounts = async (
  now: Date = new Date()
): Promise<MarketingSendCounts> => {
  const since = windowStart(now);
  const rows = await prisma.emailDelivery.groupBy({
    by: ["status"],
    where: {
      templateVersion: { template: { classification: "marketing" } },
      status: { in: ["sent", "delivered", "bounced", "complained"] },
      sentAt: { gte: since },
    },
    _count: { _all: true },
  });

  const count = (status: string) =>
    rows.find((row) => row.status === status)?._count._all ?? 0;

  const bounced = count("bounced");
  const complained = count("complained");
  return {
    // Everything that reached the provider, including what came back badly:
    // a bounced message was still sent, and leaving it out of the denominator
    // would inflate every rate by exactly the thing being measured.
    sent: count("sent") + count("delivered") + bounced + complained,
    bounced,
    complained,
  };
};

/** The stored halt. Unreadable values count as halted -- see the core. */
export const readMarketingHalt = async (): Promise<{
  halted: boolean;
  state: MarketingHaltState | null;
}> => {
  const row = await prisma.appSetting.findUnique({
    where: { key: MARKETING_HALT_SETTING_KEY },
    select: { value: true },
  });
  return parseMarketingHalt(row?.value ?? null);
};

/**
 * Evaluates the window and trips the halt if it is over.
 *
 * Idempotent: an already-halted stream is left exactly as it was, so the stored
 * reason stays the one that caused the halt rather than being overwritten by
 * whatever the numbers say on the next pass.
 *
 * Returns whether marketing may send, which is what the caller actually needs.
 */
export const evaluateMarketingSendHealth = async (
  now: Date = new Date()
): Promise<{ halted: boolean; state: MarketingHaltState | null }> => {
  const existing = await readMarketingHalt();
  if (existing.halted) return existing;

  const counts = await marketingSendCounts(now);
  const verdict = marketingSendHealth(counts);
  if (verdict.level === "ok") return { halted: false, state: null };

  if (verdict.level === "warning") {
    // A log line, not an incident: the warning thresholds are meant to be
    // crossed occasionally and paging on them would train somebody to ignore
    // the halt as well.
    console.warn(
      JSON.stringify({
        event: "marketing_send_health_warning",
        metric: verdict.metric,
        rate: verdict.rate,
        observed: verdict.observed,
        sent: verdict.sent,
        windowDays: MARKETING_HEALTH_WINDOW_DAYS,
      })
    );
    return { halted: false, state: null };
  }

  const state: MarketingHaltState = {
    haltedAt: now.toISOString(),
    metric: verdict.metric ?? "complaint",
    rate: verdict.rate,
    observed: verdict.observed,
    sent: verdict.sent,
    reason: verdict.reason ?? "Marketing sending halted.",
  };

  // `create` rather than `upsert`: losing the race means another pass halted
  // first, and its reason is the one that should survive.
  await prisma.appSetting
    .create({
      data: { key: MARKETING_HALT_SETTING_KEY, value: JSON.stringify(state) },
    })
    .catch(() => undefined);

  await reportOperationalIncident({
    code: "EMAIL_MARKETING_HALTED",
    title: "Marketing sending halted itself",
    error: state.reason,
    severity: "error",
    context: {
      component: "marketing-send-health",
      metric: state.metric,
      observed: state.observed,
      sent: state.sent,
      windowDays: MARKETING_HEALTH_WINDOW_DAYS,
      // Named so the operator does not have to find out how to undo it. It is
      // deliberately a person's decision: the window rolls, and a halt that
      // lifted on its own would resume into the reputation it was protecting.
      clearWith: `DELETE the AppSetting row "${MARKETING_HALT_SETTING_KEY}" once the cause is understood`,
    },
  });

  return await readMarketingHalt();
};
