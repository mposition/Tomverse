/**
 * When a promotion's redemption rate is worth waking someone for.
 *
 * OZBFREE (2026-11-20) was farmed by 41 accounts in nine hours, about fifteen
 * in the first; genuine OzBargain sign-ups ran at roughly eleven a day. Ten in
 * one rolling hour separates the two.
 *
 * The alert fires when the count *reaches* a multiple of the threshold -- 10,
 * 20, 30 -- so a burst that keeps going is reported again as it grows, and one
 * that stays at 11 is reported once rather than on every redemption.
 */
export const PROMOTION_BURST_WINDOW_MINUTES = 60;
export const PROMOTION_BURST_THRESHOLD = 10;

export const promotionBurstAlertDue = (
  redemptionsInWindow: number,
  threshold: number = PROMOTION_BURST_THRESHOLD
) =>
  Number.isSafeInteger(threshold) &&
  threshold > 0 &&
  redemptionsInWindow >= threshold &&
  redemptionsInWindow % threshold === 0;
