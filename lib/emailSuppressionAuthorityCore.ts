import type { SuppressionReason, SuppressionRecord } from "@/lib/emailSuppressionCore";

/**
 * What may lift a cause, and when a cause is still deciding.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
 * (deploy B), as amended by deploy D. Pure: every rule here is exercised
 * without a database.
 *
 * The name is a fossil. This module held the read authority -- the setting that
 * chose between `SuppressionEntry` and `SuppressionCause` -- along with the
 * fence around switching it and the parity report that had to agree before it
 * could be switched. Deploy D removed all three, because after deploy C there
 * is one record and nothing left to choose between. What remains was never
 * about which record decides: the release matrix, and the test for a cause that
 * is still in force.
 *
 * The file keeps its name because both authority paths are pinned by
 * `PROMPT_REFINER_RUNTIME_SOURCE_PATHS` and by the CHECK constraint in
 * 20260918130000_prompt_refiner_stage_admission. A rename is an edit to a
 * durable approval contract, which is a larger decision than a better name is
 * worth.
 */

/**
 * What an action may release, per cause (the release matrix).
 *
 * Not an ordering: each cell is its own condition. An action releases only the
 * causes it may; the others stay active.
 */
export type ReleaseAction =
  | "admin"
  | "approved_admin"
  | "preference_enabled"
  | "delivered"
  | "expiry";

const RELEASE_MATRIX: Record<SuppressionReason, ReadonlySet<ReleaseAction>> = {
  privacy_request: new Set(),
  hard_bounce: new Set(["approved_admin"]),
  complaint: new Set(["approved_admin"]),
  manual: new Set(["admin", "approved_admin"]),
  unsubscribe: new Set(["preference_enabled"]),
  soft_bounce: new Set(["admin", "approved_admin", "delivered", "expiry"]),
};

export const releasableBy = (action: ReleaseAction, reason: string): boolean =>
  RELEASE_MATRIX[reason as SuppressionReason]?.has(action) ?? false;

/**
 * Whether an administrator lifting these causes needs a second administrator
 * (or the audited sole-administrator path). True when any cause an approved
 * lift would release is one a single administrator may not.
 */
export const removalNeedsApproval = (activeReasons: readonly string[]): boolean =>
  activeReasons.some(
    (reason) => releasableBy("approved_admin", reason) && !releasableBy("admin", reason)
  );

/** A cause as the send decision reads it. */
export type ActiveCause = SuppressionRecord & { id?: string };

export const isActiveCause = (
  cause: { releasedAt?: Date | null; expiresAt?: Date | null },
  now: Date
) =>
  !cause.releasedAt && (!cause.expiresAt || cause.expiresAt.getTime() > now.getTime());
