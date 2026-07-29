export type ManualPlanTier = "Free" | "Pro" | "Max";

/** How long a manually adjusted paid plan lasts when no end date is given. */
export const MANUAL_PLAN_ACCESS_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type PlanAdjustPayload = {
  plan: ManualPlanTier;
  reason: string;
  confirmText: string;
  subscriptionStatus: string;
  billingInterval: "monthly" | null;
};

/**
 * The exact body the admin console sends to
 * `PATCH /api/admin/users/:id/plan-adjust`.
 *
 * High-risk admin actions are gated on a second administrator approving the
 * *specific payload*, and `lib/adminApproval.ts` matches an existing approval
 * by `payloadHash`. The requester therefore has to re-send a byte-identical
 * body after approval, or the retry is treated as a brand-new request and goes
 * back into the queue.
 *
 * The console used to fold a click-time value into that body:
 *
 *     periodEnd: adjustPeriodEnd || new Date(Date.now() + 30 * DAY).toISOString()
 *
 * with the generated value memoised in component state so a second click could
 * reuse it. That state does not survive a remount -- and the workflow pushes
 * the requester straight into one, because checking whether the approval landed
 * means navigating to the Approvals panel. Coming back produced a fresh
 * millisecond-precision timestamp, a different hash, and another pending
 * request. Two-person approval could not be completed through the UI at all.
 *
 * So the payload carries only what the administrator actually chose. Nothing
 * here is derived from the clock, which makes "re-send the same request" true
 * by construction rather than by remembering to hold state. The end date is
 * settled server-side instead -- see `resolveManualPlanPeriodEnd`.
 */
export const buildPlanAdjustPayload = ({
  plan,
  reason,
  confirmText,
}: {
  plan: ManualPlanTier;
  reason: string;
  confirmText: string;
}): PlanAdjustPayload => ({
  plan,
  reason,
  confirmText,
  subscriptionStatus: "manually_adjusted",
  billingInterval: plan === "Free" ? null : "monthly",
});

/**
 * The access period a manual plan adjustment should write.
 *
 * - `Free` never carries a period end.
 * - An explicit date is honoured.
 * - An explicit `null` means "paid, with no end date" and is honoured too.
 * - Omitted means the caller had no opinion, so the default window applies.
 *
 * Deciding this here rather than in the browser is what lets the request body
 * stay free of clock-derived values. It runs at execution time, so a request
 * that waited for approval gets its window measured from when it actually took
 * effect.
 */
export const resolveManualPlanPeriodEnd = (
  plan: ManualPlanTier,
  periodEnd: string | null | undefined,
  now: Date = new Date()
): Date | null => {
  if (plan === "Free") return null;
  if (periodEnd === undefined) {
    return new Date(now.getTime() + MANUAL_PLAN_ACCESS_DAYS * DAY_MS);
  }
  return periodEnd ? new Date(periodEnd) : null;
};
