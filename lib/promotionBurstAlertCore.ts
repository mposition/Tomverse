/**
 * When a promotion's redemption rate is worth waking someone for.
 *
 * OZBFREE (2026-11-20) was farmed by 41 accounts in nine hours, about fifteen
 * in the first; genuine OzBargain sign-ups ran at roughly eleven a day. Ten in
 * one rolling hour separates the two.
 *
 * A burst is reported once per band of ten -- 10-19, 20-29, ... -- so one that
 * keeps going is reported again as it grows, and one that stays at 11 is
 * reported once. Bands, not exact multiples: two redemptions committing at the
 * same moment can take the count from 9 straight to 11, and an "exactly 10"
 * rule would then never fire. Which redemption reports a band is settled by the
 * caller claiming the band's key (`promotionBurstAlertKey`).
 */
export const PROMOTION_BURST_WINDOW_MINUTES = 60;
export const PROMOTION_BURST_THRESHOLD = 10;

/** The band a count falls in, or null below the threshold. */
export const promotionBurstBand = (
  redemptionsInWindow: number,
  threshold: number = PROMOTION_BURST_THRESHOLD
): number | null =>
  Number.isSafeInteger(threshold) &&
  threshold > 0 &&
  redemptionsInWindow >= threshold
    ? Math.floor(redemptionsInWindow / threshold)
    : null;

/**
 * One key per promotion, band and window-length slot of time, so a band is
 * reported once per slot rather than once ever.
 */
export const promotionBurstAlertKey = (
  promotionId: string,
  band: number,
  now: Date,
  windowMinutes: number = PROMOTION_BURST_WINDOW_MINUTES
) =>
  `promo-burst:${promotionId}:${Math.floor(
    now.getTime() / (windowMinutes * 60_000)
  )}:${band}`;
