import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  markCauseWriter,
  recordSuppressionCause,
} from "@/lib/emailSuppressionCauses";
import {
  holdSuppressionFence,
  lockSuppressionAddress,
  readSuppressionAuthority,
} from "@/lib/emailSuppressionAuthority";
import {
  isActiveCause,
  releasableBy,
  removalNeedsApproval,
} from "@/lib/emailSuppressionAuthorityCore";
import {
  suppressionVerdict,
  type SendClassification,
  type SuppressionReason,
  type SuppressionVerdict,
} from "@/lib/emailSuppressionCore";

/**
 * The suppression list, and the gate every send passes through.
 *
 * Contract: docs/policy/email-notifications.md §13.3, §14.4.
 *
 * Keyed by address rather than by account, because a spam complaint follows the
 * mailbox: deleting an account and signing up again must not clear it. That is
 * also why `ConsentRecord` and this table are the two that survive account
 * deletion, and why the data domain registry records them as retained rather
 * than anonymised.
 *
 * **This list is the gate, and the provider has its own.** Resend suppresses at
 * the account level across every domain in a region (§5.3.1), so a marketing
 * complaint can refuse a login code no matter what this table says. Ours is
 * therefore not a second line of defence behind the provider's -- it is a
 * separate, earlier filter, and the provider's sits *in front of* the send we
 * decided to make. Detecting that is what `EMAIL_PROVIDER_SUPPRESSED` exists
 * for.
 */

export const normalizeSuppressionAddress = (value: string) =>
  value.trim().toLowerCase();

/** The scope-carrying key. `*` for a global entry; never NULL (§10.2). */
export const GLOBAL_PURPOSE_KEY = "*";

export type SuppressionSource =
  | "provider_webhook"
  | "unsubscribe_link"
  | "preference_center"
  | "admin";

export type RecordSuppressionInput = {
  emailAddress: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  purposeKey?: string;
  /**
   * `classification` records a cause that stops every message of that
   * classification (only `marketing`, named by `purposeKey`). It has no entry:
   * the entry table knows only global and purpose scopes, so the cause is the
   * whole record and it decides once causes are the read authority
   * (docs/policy/email-product-news-redesign-draft.md, section 7.4).
   */
  scope?: "classification";
  expiresAt?: Date | null;
  sourceStream?: string | null;
  sourceDomain?: string | null;
  sourceClassification?: string | null;
  sourceDeliveryId?: string | null;
  sourceMessageId?: string | null;
  evidence?: Prisma.InputJsonValue;
  occurredAt?: Date;
  /**
   * Stable per writer, so a retried event records one cause
   * (docs/policy/email-product-news-redesign-draft.md, section 7.4):
   * webhook:<eventId>, softbounce:<deliveryId>, preference:<transitionId>,
   * admin:<idempotency key>, privacy:<requestId>:intake|completed.
   */
  sourceEventKey: string;
  sourceRequestId?: string | null;
  providerAccount?: string | null;
};

/**
 * Records one suppression cause.
 *
 * ## What used to be here
 *
 * This wrote two records: a cause, and a `SuppressionEntry` that merged the
 * causes down to one row per selector. That merge carried rules -- a
 * `privacy_request` is never overwritten, a permanent reason is never
 * downgraded by a transient one -- because one row had to stand for several
 * facts and choosing wrongly meant a suppression that quietly stopped
 * suppressing.
 *
 * Those rules are gone with the entry, and not because they stopped mattering.
 * They are inherent once every cause is its own row: the verdict reads all of
 * them, so a soft bounce arriving after a complaint does not replace the
 * complaint, it sits beside it. A rule that has to be written down is a rule
 * that can be written down wrongly.
 *
 * The contraction (deploy C) stopped writing entries; `suppressionCheck` reads
 * causes and nothing else.
 */
export async function recordSuppression(
  input: RecordSuppressionInput,
  // A transaction when the suppression must commit with the change that caused
  // it -- a withdrawal and its hold are one fact.
  client?: Prisma.TransactionClient
): Promise<{ id: string; changed: boolean; duplicate?: true }> {
  if (!client) {
    return prisma.$transaction((tx) => recordSuppression(input, tx));
  }
  const emailAddress = normalizeSuppressionAddress(input.emailAddress);
  const purposeKey = input.purposeKey ?? GLOBAL_PURPOSE_KEY;
  const scope =
    input.scope === "classification"
      ? "classification"
      : purposeKey === GLOBAL_PURPOSE_KEY
        ? "global"
        : "purpose";
  if (scope === "classification" && purposeKey !== "marketing") {
    throw new Error("A classification suppression names the marketing classification.");
  }
  const occurredAt = input.occurredAt ?? new Date();

  // Shared fence first: no suppression write may straddle the read-authority
  // cutover (docs/policy/email-product-news-redesign-draft.md, section 7.4).
  await holdSuppressionFence(client);
  await lockSuppressionAddress(client, emailAddress);

  // Every event is its own fact. Still marked as a cause writer while the
  // mirroring trigger exists in databases that have not run the contraction's
  // drop yet; the mark costs one `set_config` and stops a second cause being
  // written for the same event there.
  await markCauseWriter(client);
  const cause = await recordSuppressionCause(client, {
    emailAddress,
    scope,
    purposeKey,
    reason: input.reason,
    source: input.source,
    sourceEventKey: input.sourceEventKey,
    sourceStream: input.sourceStream ?? null,
    sourceDomain: input.sourceDomain ?? null,
    sourceClassification: input.sourceClassification ?? null,
    sourceDeliveryId: input.sourceDeliveryId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    sourceRequestId: input.sourceRequestId ?? null,
    providerAccount: input.providerAccount ?? null,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    occurredAt,
    expiresAt: input.expiresAt ?? null,
  });

  return cause.recorded
    ? { id: cause.id, changed: true }
    : // The same event again -- a redelivered webhook, a retried admin request.
      // The cause is already there and says what it said the first time; the
      // caller is told so rather than being handed a second identity for one
      // event.
      { id: cause.id, changed: false, duplicate: true };
}

/**
 * Entries an operator may not lift from this screen.
 *
 * A suppression created by a privacy request is the record of someone
 * exercising a legal right. Lifting it re-enables mail to them, and the process
 * that would be entitled to do that is the privacy process that created it --
 * not a button on an operations screen. Refused here rather than gated behind
 * approval, because there is no operational reason that would make it correct.
 */
export const UNLIFTABLE_SUPPRESSION_REASONS = ["privacy_request"] as const;

/**
 * Entries whose removal needs a second administrator.
 *
 * §13.3 calls these permanent: the provider, or the person, has said stop.
 * Removing one starts mail to an address that said stop, and the cost is not
 * only to them -- complaints and hard bounces are what a receiver measures a
 * sending domain by (§14.5), and a domain's reputation is the part of this
 * system that recovers slowest.
 */
export const APPROVAL_REQUIRED_SUPPRESSION_REASONS = [
  "hard_bounce",
  "complaint",
] as const;

/**
 * `authority_changed`: the read authority moved between choosing a lift path
 * and taking the fence. Nothing was released; asking again takes the other path.
 */
export type SuppressionRemovalRefusal = "not_found" | "unliftable" | "authority_changed";

/** Address plus scope plus purpose: what a suppression is actually about. */
export type SuppressionSelector = {
  emailAddress: string;
  scope: string;
  purposeKey: string;
};

/**
 * A fixed-size name for a set of active causes.
 *
 * The lift has to be bound to the set the operator saw, and the first attempt
 * at that carried the ids themselves in the request. That works until a
 * selector holds more of them than a request body can carry -- and causes are
 * append-only with nothing bounding how many a selector accumulates, so "more
 * than fits" is a state the system reaches on its own. At that point the
 * selector is *visible and permanently unliftable*: send them all and the body
 * limit refuses, send fewer and the set does not match, and there is no request
 * in between. Raising the limit moves the wall rather than removing it.
 *
 * So the request carries this instead. Sorted first, because the set is what
 * matters and neither side may depend on the other's ordering -- one comes back
 * in PostgreSQL's order and the other in whatever order a caller sent. The
 * separator is a character a cuid cannot contain, so no two different sets can
 * spell the same string.
 *
 * Not a secret and not a signature: it names a set, and the server recomputes
 * it from the database under the address lock before releasing anything.
 */
export const causeSetDigest = (ids: readonly string[]): string =>
  createHash("sha256")
    .update([...ids].sort().join(String.fromCharCode(0)))
    .digest("hex");

/**
 * The active causes on the selector one cause belongs to, for deciding how an
 * administrator may lift them.
 *
 * **Keyed on a cause, not on an entry.** The operator console lists causes, so
 * the handle it hands back is a cause id; an entry id would be a handle to a
 * row that the contraction stops writing
 * (docs/policy/email-product-news-redesign-draft.md, section 7.4). The cause is
 * only a way in -- what is read, approved and lifted is every active cause on
 * its selector, because the block is their sum and lifting one of several
 * changes nothing a sender would notice.
 *
 * **The handle has to be active itself.** A released or expired cause still
 * names a real selector, and following it would read whatever is live there
 * now -- which may be a different cause entirely. An operator looking at a row
 * showing one `soft_bounce`, released and replaced by an `unsubscribe` while
 * the page sat open, would click lift and release the unsubscribe they never
 * saw, and we would start mailing somebody who asked us to stop. So a stale
 * handle does not resolve.
 *
 * **"No such cause" and "that cause is no longer active" are different
 * answers**, and the caller says different things about them: the first is a
 * handle that never existed, the second is a row somebody was looking at a
 * moment ago. Collapsing them into `null` told an operator whose page had gone
 * stale that their suppression had vanished.
 */
export type ActiveCausesForSelector =
  | { found: false }
  | { found: true; stale: true }
  | {
      found: true;
      stale: false;
      selector: SuppressionSelector;
      causeIds: string[];
      /** `causeSetDigest(causeIds)`, which is what a lift request carries. */
      digest: string;
      reasons: string[];
      needsApproval: boolean;
    };

export async function activeCausesForSelector(
  causeId: string,
  now: Date = new Date()
): Promise<ActiveCausesForSelector> {
  const cause = await prisma.suppressionCause.findUnique({
    where: { id: causeId },
    select: {
      emailAddress: true,
      scope: true,
      purposeKey: true,
      expiresAt: true,
      releasedAt: true,
    },
  });
  if (!cause) return { found: false };
  if (!isActiveCause(cause, now)) return { found: true, stale: true };
  const selector: SuppressionSelector = {
    emailAddress: cause.emailAddress,
    scope: cause.scope,
    purposeKey: cause.purposeKey,
  };
  const causes = await prisma.suppressionCause.findMany({
    where: { ...selector, releasedAt: null },
    select: { id: true, reason: true, expiresAt: true, releasedAt: true },
    orderBy: { id: "asc" },
  });
  const active = causes.filter((row) => isActiveCause(row, now));
  const causeIds = active.map((row) => row.id);
  return {
    found: true,
    stale: false,
    selector,
    causeIds,
    digest: causeSetDigest(causeIds),
    reasons: active.map((row) => row.reason),
    needsApproval: removalNeedsApproval(active.map((row) => row.reason)),
  };
}

export type CauseLiftResult =
  | {
      removed: true;
      selector: SuppressionSelector;
      released: Array<{ id: string; reason: string }>;
      remaining: Array<{ id: string; reason: string }>;
    }
  | { removed: false; refusal: SuppressionRemovalRefusal | "approval_stale" };

/**
 * Lifts a selector's causes by the release matrix, once causes decide.
 *
 * Reached by a cause id, for the reason `activeCausesForSelector` gives: the
 * console's handles are causes now.
 *
 * Run inside the approved operation. Everything is re-read under the fence and
 * compared with the cause set the approval was granted for: a cause that
 * appeared since -- a soft bounce strengthened to a hard bounce -- was not
 * approved, so the lift is refused and has to be asked for again. The audit
 * entry and the release are one transaction, so a rolled-back lift leaves no
 * record of a release that did not happen.
 *
 * `approvedDigest` has to name the set the *operator saw*, carried in from the
 * request, and not a set the server read for itself a moment ago. Read it here
 * and the comparison compares a value with itself: whatever is live at this
 * instant is approved by definition, and a cause added since the screen was
 * drawn is released without anyone having looked at it. The handle must be in
 * that set too -- a lift is of the row that was on the screen, and a row whose
 * own handle is no longer active is not that row.
 *
 * A digest rather than the ids, because the ids are unbounded and a request
 * body is not; see `causeSetDigest`. It is recomputed here, from the rows read
 * under the address lock, so the comparison is against what is true at the
 * moment of the release and not against what the caller said was true.
 *
 * The mirrored entry is removed only when no cause remains active; while an
 * older build may still read entries, an entry with a live cause behind it
 * keeps blocking there too. It goes by selector rather than by id, and deleting
 * none of them is not a failure -- once the contraction stops writing entries
 * there will be nothing there to delete, and this is the path that has to keep
 * working across that change.
 */
export async function liftSuppressionCauses(input: {
  causeId: string;
  approvedDigest: string;
  action: "admin" | "approved_admin";
  evidence:
    | { kind: "admin" }
    | { kind: "dual_approval"; approvalId: string; authorizationAuditLogId: string }
    | { kind: "sole_admin"; authorizationAuditLogId: string };
  /**
   * Writes the audit entry inside this transaction, and is told what the
   * release actually came to rather than what was asked for.
   */
  writeReleaseAudit: (
    tx: Prisma.TransactionClient,
    outcome: {
      released: Array<{ id: string; reason: string }>;
      remaining: Array<{ id: string; reason: string }>;
    }
  ) => Promise<string>;
  now?: Date;
}): Promise<CauseLiftResult> {
  return prisma.$transaction(async (tx) => {
    await holdSuppressionFence(tx);
    if ((await readSuppressionAuthority(tx)) !== "causes") {
      return { removed: false as const, refusal: "authority_changed" as const };
    }
    const found = await tx.suppressionCause.findUnique({
      where: { id: input.causeId },
      select: { emailAddress: true, scope: true, purposeKey: true },
    });
    if (!found) return { removed: false as const, refusal: "not_found" as const };
    // The address lock before the causes are read, so no cause can appear
    // between the read and the decision.
    await lockSuppressionAddress(tx, found.emailAddress);
    const selector: SuppressionSelector = found;

    // And the clock after the lock, not before it. Waiting for the lock takes
    // as long as it takes, and a soft bounce that expired during the wait is
    // expired at the moment of the release -- reading it as active because the
    // request was made earlier would release a selector whose handle is no
    // longer live, which is the thing the handle rule exists to refuse.
    const now = input.now ?? new Date();

    const causes = (
      await tx.suppressionCause.findMany({
        where: { ...selector, releasedAt: null },
        select: { id: true, reason: true, expiresAt: true, releasedAt: true },
        orderBy: { id: "asc" },
      })
    ).filter((cause) => isActiveCause(cause, now));
    if (causes.length === 0 || !causes.some((cause) => cause.id === input.causeId)) {
      // Either nothing is active on this selector any more, or the handle
      // itself is not among what is. Both mean the row the operator acted on is
      // not the row that is there now -- released by somebody else, expired on
      // its own, or replaced by a cause they never saw -- so this is a stale
      // approval rather than a missing record.
      return { removed: false as const, refusal: "approval_stale" as const };
    }

    if (causeSetDigest(causes.map((cause) => cause.id)) !== input.approvedDigest) {
      return { removed: false as const, refusal: "approval_stale" as const };
    }

    const releasable = causes.filter((cause) => releasableBy(input.action, cause.reason));
    const remaining = causes.filter((cause) => !releasableBy(input.action, cause.reason));
    if (releasable.length === 0 && causes.length > 0) {
      return { removed: false as const, refusal: "unliftable" as const };
    }

    // The audit entry is written with the outcome rather than before it. What
    // the approval was asked for and what is actually released are different
    // sets whenever the matrix keeps one back -- a `manual` lifted beside a
    // `privacy_request` that stays -- and an immutable record naming only the
    // set it was asked about reads as though the privacy request had been
    // removed.
    const releaseAuditLogId = await input.writeReleaseAudit(tx, {
      released: releasable.map(({ id, reason }) => ({ id, reason })),
      remaining: remaining.map(({ id, reason }) => ({ id, reason })),
    });
    await markCauseWriter(tx);
    if (releasable.length > 0) {
      await tx.suppressionCause.updateMany({
        where: { id: { in: releasable.map((cause) => cause.id) }, releasedAt: null },
        data: {
          releasedAt: now,
          releaseKind: input.action,
          releaseEvidence: { ...input.evidence, releaseAuditLogId },
        },
      });
    }
    return {
      removed: true as const,
      selector,
      released: releasable.map(({ id, reason }) => ({ id, reason })),
      remaining: remaining.map(({ id, reason }) => ({ id, reason })),
    };
  });
}

/**
 * Whether this message may go out.
 *
 * Reads every active cause for the address -- global, per-classification and
 * per-purpose -- and hands them to the pure decision in emailSuppressionCore.
 * The split exists so the table in §13.3 can be exercised exhaustively without
 * a database, which matters because it is the table most likely to be quietly
 * inverted later.
 */
export async function suppressionCheck(input: {
  emailAddress: string;
  classification: SendClassification;
  purpose?: string | null;
  now?: Date;
  /**
   * The transaction to read in, when the caller holds the address lock and the
   * answer has to be the one true inside it. A read on the global client would
   * be a read outside those locks, which is the race sendWithAddressLock()
   * exists to close (docs/policy/email-notifications.md 9.8).
   */
  client?: Prisma.TransactionClient;
}): Promise<SuppressionVerdict> {
  const emailAddress = normalizeSuppressionAddress(input.emailAddress);
  const db = input.client ?? prisma;

  // Causes, whatever the setting says.
  //
  // This is the change deploy C makes to the send path, and it is not a
  // simplification. Nothing writes `SuppressionEntry` any more, so that table
  // is a snapshot of the moment entry writes stopped: reading it would miss
  // every hard bounce, complaint and privacy request recorded since, and the
  // messages it would let through are messages to people who have told us to
  // stop. Honouring a setting that selects it would mean honouring a request to
  // be wrong.
  //
  // The setting is read anyway, so that finding it set to `entry` is loud
  // rather than silent -- it means somebody rolled the authority back below
  // this build's floor and is expecting a behaviour that no longer exists.
  // Deploy D removes the setting and this read with it.
  const authority = await readSuppressionAuthority(db);
  if (authority !== "causes") {
    await reportOperationalIncident({
      code: "EMAIL_SUPPRESSION_AUTHORITY_BELOW_FLOOR",
      title: "The suppression read authority is set to entries",
      error:
        "This build does not write SuppressionEntry, so entries are a stale snapshot; causes decided this send regardless. Put the setting back to causes.",
      severity: "error",
      cooldownMs: 30 * 60 * 1_000,
      context: { component: "email-suppression", authority },
    });
  }

  const records = await db.suppressionCause.findMany({
    where: {
      emailAddress,
      releasedAt: null,
      OR: [
        { scope: "global" },
        // A classification-scope cause stops every message of that
        // classification, whatever its purpose.
        { scope: "classification", purposeKey: input.classification },
        ...(input.purpose ? [{ scope: "purpose", purposeKey: input.purpose }] : []),
      ],
    },
    // Expired soft bounces are filtered by the verdict itself.
    select: { reason: true, sourceStream: true, expiresAt: true },
  });

  return suppressionVerdict({
    classification: input.classification,
    records: records as Parameters<typeof suppressionVerdict>[0]["records"],
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * Raised when the provider refuses a message our own gate allowed.
 *
 * The gap this covers is specific to §5.3.1: Resend's suppression is
 * account-wide, so a complaint about a newsletter can silently stop a login
 * code even though this table says the send was fine. Without a signal the
 * symptom is "sign-in emails do not arrive for one person" with nothing in our
 * logs to explain it.
 */
export async function reportProviderSuppression(input: {
  emailAddress: string;
  classification: string;
  deliveryId: string;
}) {
  await reportOperationalIncident({
    code: "EMAIL_PROVIDER_SUPPRESSED",
    title: "The provider refused a message our own suppression list allowed",
    error:
      `A ${input.classification} message was refused for an address we consider ` +
      "sendable. Resend suppression is account-wide across a region, so a " +
      "marketing complaint can refuse transactional mail.",
    severity: "error",
    cooldownMs: 30 * 60 * 1_000,
    context: {
      component: "email-suppression",
      classification: input.classification,
      deliveryId: input.deliveryId,
    },
  });
}
