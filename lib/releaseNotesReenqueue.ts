import "server-only";

import type { Prisma } from "@prisma/client";

import { displayIdempotencyKey } from "@/lib/releaseNotesDisplayContractCore";

/**
 * Skipping a message whose display contract moved, and enqueueing the one that
 * replaces it.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6 (C16,
 * C33).
 *
 * ## One transaction, and why it has to be
 *
 * The message is not refused. Its footer was rendered under obligations that have
 * since changed, so what it needs is to be rendered again -- and the two halves of
 * that are a skip and an insert. Section 7.6 says one transaction, and the reason
 * is what each half looks like on its own: a skip that committed alone is a
 * message silently dropped, and an insert that committed alone is two messages for
 * one recipient, one of them with the wrong footer.
 *
 * So this takes a `Prisma.TransactionClient` and never opens its own, the same way
 * `recordSendDecision()` does -- and the drain writes the verdict snapshot in the
 * same transaction, so the record and the replacement cannot disagree.
 *
 * ## What the replacement carries
 *
 * Its own generation, its predecessor's root, and the current template version,
 * policy version, profile and contract. Not the predecessor's: re-rendering under
 * the contract that failed would produce the same failure, and the idempotency key
 * would be the same too, so the provider would drop the second message and nobody
 * would be told.
 *
 * The key is `rootDeliveryId:g<generation>:<hash prefix>`, which section 7.6 fixes
 * exactly. Deterministic, so a crash between this transaction and the send does
 * not produce a second message, and the generation is in it because a replacement
 * is a different message with the same root.
 *
 * ## What it does not do
 *
 * Decide. Whether the contract moved is `releaseNotesSendVerdict()`'s answer, and
 * this is what the drain does with a `display_contract_changed` blocker. It does
 * not re-read the verdict, and it does not look at the other blockers: a message
 * that is also suppressed is not re-enqueued, because the skip is then about the
 * suppression and a replacement would be a second message to somebody who asked
 * for none. The caller checks that; `reenqueueIsRight()` is that check, so the two
 * callers section 7.6 shares cannot answer it differently.
 */

/** The blockers that mean "render again" rather than "do not send". */
const REENQUEUE_BLOCKER = "display_contract_changed";

/**
 * Whether a refused send should be re-enqueued rather than left skipped.
 *
 * Exactly one blocker, and no others alongside it. A message whose contract moved
 * *and* whose recipient has since been suppressed is not a message to re-render --
 * the replacement would be refused for the second reason, and it would be a second
 * row addressed to somebody who asked for nothing.
 */
export const reenqueueIsRight = (blockers: readonly string[]): boolean =>
  blockers.length === 1 && blockers[0] === REENQUEUE_BLOCKER;

export type ReenqueueResult =
  | { reenqueued: true; deliveryId: string; generation: number; idempotencyKey: string }
  | { reenqueued: false; reason: "already_superseded" | "not_pending" };

export async function skipAndReenqueue(
  tx: Prisma.TransactionClient,
  input: {
    /** The row being skipped, read in this transaction. */
    delivery: {
      id: string;
      eventId: string;
      recipientKey: string;
      userId: string | null;
      emailAddress: string;
      language: string;
      lane: string;
      generation: number;
      rootDeliveryId: string;
      attempts: number;
    };
    /** The current values the replacement is rendered under. */
    current: {
      templateVersionId: string;
      policyVersionId: string;
      /** Non-null: a message with no resolved country is refused rather than re-rendered. */
      jurisdictionCountry: string;
      jurisdictionProfileKey: string;
      displayContractHash: string;
    };
  }
): Promise<ReenqueueResult> {
  // The predecessor is claimed by this drain, so `status` is still `pending`; a
  // conditional update rather than a read, so a second drain that got the same row
  // cannot produce a second replacement. `supersedesDeliveryId` is unique as well,
  // which is the backstop -- this is the part that reports rather than throws.
  const skipped = await tx.emailDelivery.updateMany({
    where: { id: input.delivery.id, status: "pending" },
    data: {
      status: "skipped",
      skipReason: REENQUEUE_BLOCKER,
      attempts: input.delivery.attempts,
      nextAttemptAt: null,
      claimedAt: null,
    },
  });
  if (skipped.count === 0) return { reenqueued: false, reason: "not_pending" };

  const existing = await tx.emailDelivery.findUnique({
    where: { supersedesDeliveryId: input.delivery.id },
    select: { id: true },
  });
  if (existing) return { reenqueued: false, reason: "already_superseded" };

  const generation = input.delivery.generation + 1;
  const idempotencyKey = displayIdempotencyKey({
    rootDeliveryId: input.delivery.rootDeliveryId,
    generation,
    displayContractHash: input.current.displayContractHash,
  });

  const replacement = await tx.emailDelivery.create({
    data: {
      eventId: input.delivery.eventId,
      recipientKey: input.delivery.recipientKey,
      userId: input.delivery.userId,
      emailAddress: input.delivery.emailAddress,
      language: input.delivery.language,
      lane: input.delivery.lane,
      generation,
      supersedesDeliveryId: input.delivery.id,
      rootDeliveryId: input.delivery.rootDeliveryId,
      templateVersionId: input.current.templateVersionId,
      policyVersionId: input.current.policyVersionId,
      jurisdictionCountry: input.current.jurisdictionCountry,
      jurisdictionProfileKey: input.current.jurisdictionProfileKey,
      displayContractHash: input.current.displayContractHash,
      idempotencyKey,
    },
    select: { id: true },
  });

  return { reenqueued: true, deliveryId: replacement.id, generation, idempotencyKey };
}
