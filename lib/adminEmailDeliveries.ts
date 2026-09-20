import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { maskEmailAddress } from "@/lib/emailAddressMaskingCore";
import {
  DELIVERY_STATUSES,
  type DeliveryFilters,
} from "@/lib/adminEmailDeliveryFilters";

/**
 * Reading the outbox, for an operator.
 *
 * Contract: docs/policy/email-notifications.md §9.5, §13.7.
 *
 * §9.5 makes `EmailDelivery.status = "abandoned"` the dead-letter table rather
 * than moving rows somewhere else, on the grounds that moving them scatters the
 * context -- how many attempts, which error. That only pays off if something
 * can actually read them back with that context attached, which until now
 * nothing could: no admin surface touched this table at all.
 *
 * ## The allowlist is the design
 *
 * `select` below names every column that leaves this module. Two are
 * deliberately absent:
 *
 *  - `renderDataSnapshot`, the encrypted personalisation inputs. Decrypting
 *    them here would make this a screen for reading other people's mail.
 *  - `renderedHash` and its key version. They exist so a message can be
 *    attested to later; on the credential lane the body they attest to contains
 *    a six-digit code, and publishing the hash beside the template that
 *    produced it is the attack §10.3-7 keyed them against.
 */

const LIST_SELECT = {
  id: true,
  lane: true,
  status: true,
  skipReason: true,
  deferReason: true,
  emailAddress: true,
  language: true,
  jurisdictionCountry: true,
  jurisdictionProfileKey: true,
  attempts: true,
  lastErrorKind: true,
  lastAttemptAt: true,
  nextAttemptAt: true,
  providerMessageId: true,
  renderedSubject: true,
  sentAt: true,
  deliveredAt: true,
  createdAt: true,
  userId: true,
  templateVersion: {
    select: {
      version: true,
      language: true,
      // Classification and purpose from the version the message was sent
      // under; the template row is history and supplies only the key.
      classification: true,
      purpose: true,
      template: { select: { key: true } },
    },
  },
} satisfies Prisma.EmailDeliverySelect;

type AdminEmailDeliveryRecord = Prisma.EmailDeliveryGetPayload<{
  select: typeof LIST_SELECT;
}>;

/**
 * What a screen gets: the address masked, never the address (D10,
 * .github/audits/model-lifecycle-email-2026-08-22.md §21).
 *
 * The type is the guarantee. `emailAddress` is gone rather than optional, so a
 * panel cannot render it by forgetting to check something -- the field it would
 * reach for does not exist, and the compiler says so.
 */
export type AdminEmailDeliveryRow = Omit<
  AdminEmailDeliveryRecord,
  "emailAddress"
> & { emailAddressMasked: string | null };

const maskDeliveryRow = ({
  emailAddress,
  ...rest
}: AdminEmailDeliveryRecord): AdminEmailDeliveryRow => ({
  ...rest,
  emailAddressMasked: maskEmailAddress(emailAddress),
});

const whereFor = (filters: DeliveryFilters): Prisma.EmailDeliveryWhereInput => ({
  ...(filters.statuses.length > 0 ? { status: { in: filters.statuses } } : {}),
  ...(filters.lane ? { lane: filters.lane } : {}),
  ...(filters.emailAddress ? { emailAddress: filters.emailAddress } : {}),
  ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
  ...(filters.classifications.length > 0 || filters.templateKey
    ? {
        templateVersion: {
          ...(filters.classifications.length > 0
            ? { classification: { in: filters.classifications } }
            : {}),
          ...(filters.templateKey ? { template: { key: filters.templateKey } } : {}),
        },
      }
    : {}),
});

export async function listEmailDeliveries(filters: DeliveryFilters): Promise<{
  rows: AdminEmailDeliveryRow[];
  nextCursor: string | null;
}> {
  const rows = await prisma.emailDelivery.findMany({
    where: whereFor(filters),
    select: LIST_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: filters.limit + 1,
    ...(filters.cursor
      ? { cursor: { id: filters.cursor }, skip: 1 }
      : {}),
  });
  const page = rows.slice(0, filters.limit);
  return {
    rows: page.map(maskDeliveryRow),
    nextCursor: rows.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/**
 * How many rows sit in each status, unfiltered.
 *
 * Shown beside the filters so the default view says what it is leaving out.
 * A screen that opens on four statuses without saying how many rows the other
 * five hold is a screen that reads as a total.
 */
export async function emailDeliveryStatusCounts(): Promise<
  Record<string, number>
> {
  const grouped = await prisma.emailDelivery.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const status of DELIVERY_STATUSES) counts[status] = 0;
  for (const row of grouped) counts[row.status] = row._count._all;
  return counts;
}

/**
 * Abandoned legal notices, for the sidebar badge.
 *
 * §9.5 asks for this one specifically, and it is the only email count that
 * earns a badge: an abandoned legal notice is work -- §9.4 asks for manual
 * follow-up on an alternate channel -- while an abandoned promotion is a
 * promotion nobody missed.
 */
export async function abandonedLegalEmailCount(): Promise<number> {
  return prisma.emailDelivery.count({
    where: {
      status: "abandoned",
      templateVersion: { classification: "legal" },
    },
  });
}

const SUPPRESSION_CAUSE_SELECT = {
  id: true,
  emailAddress: true,
  scope: true,
  purposeKey: true,
  reason: true,
  source: true,
  sourceStream: true,
  sourceClassification: true,
  occurredAt: true,
  expiresAt: true,
  createdAt: true,
} satisfies Prisma.SuppressionCauseSelect;

type AdminSuppressionCauseRecord = Prisma.SuppressionCauseGetPayload<{
  select: typeof SUPPRESSION_CAUSE_SELECT;
}>;

/** One active cause, as the console shows it. */
export type AdminSuppressionCause = Omit<
  AdminSuppressionCauseRecord,
  "emailAddress" | "scope" | "purposeKey"
>;

/**
 * One suppressed selector -- an address, a scope and a purpose -- and every
 * active cause on it.
 *
 * Masked for the same reason, and by the same rule, as a delivery row.
 */
export type AdminSuppressionRow = {
  /**
   * The newest active cause on this selector, and the handle the lift uses.
   *
   * A cause id rather than an entry id: `SuppressionEntry` is the mirror the
   * contraction stops writing, and a console keyed on it would go blind to
   * every new hard bounce the moment that happened
   * (docs/policy/email-product-news-redesign-draft.md, section 7.4). Which
   * cause it is does not matter to the lift, which resolves the selector and
   * acts on all of them; it matters to the reveal, which reads an address by
   * this id.
   */
  id: string;
  emailAddressMasked: string | null;
  scope: string;
  purposeKey: string;
  /** Newest first, and never empty -- a selector with none is not listed. */
  causes: AdminSuppressionCause[];
};

/**
 * What we will not mail, and why, read from the causes that decide it.
 *
 * `SuppressionCause` is append-only and one selector can carry several at once
 * -- a soft bounce that hardened, an unsubscribe on top of a complaint -- and
 * the block is their sum. So this groups rather than lists: one row per
 * selector, every active cause on it, newest first. Listing a row per cause
 * would show one address three times and invite an operator to lift a third of
 * a block.
 *
 * Expiry is applied here rather than left to the reader. A soft bounce whose
 * `expiresAt` has passed stops mail nowhere, and a screen that still lists it
 * is a screen that asks somebody to lift something that is not there.
 */
export async function listSuppressions(input: {
  emailAddress: string | null;
  limit: number;
  now?: Date;
}): Promise<AdminSuppressionRow[]> {
  const now = input.now ?? new Date();
  const causes = await prisma.suppressionCause.findMany({
    where: {
      ...(input.emailAddress ? { emailAddress: input.emailAddress } : {}),
      releasedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: SUPPRESSION_CAUSE_SELECT,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    // One selector can hold several causes, so the row limit is not the cause
    // limit. Read enough causes to fill the rows and cut the rows below.
    take: input.limit * SUPPRESSION_CAUSES_PER_ROW_BUDGET,
  });

  const rows = new Map<string, AdminSuppressionRow>();
  for (const { emailAddress, scope, purposeKey, ...cause } of causes) {
    const key = [emailAddress, scope, purposeKey].join("\u0000");
    const existing = rows.get(key);
    if (existing) {
      existing.causes.push(cause);
      continue;
    }
    rows.set(key, {
      // The first cause of a selector in this order is its newest, which is
      // also the one an operator is most likely to have come here about.
      id: cause.id,
      emailAddressMasked: maskEmailAddress(emailAddress),
      scope,
      purposeKey,
      causes: [cause],
    });
  }

  return Array.from(rows.values()).slice(0, input.limit);
}

/**
 * How many causes one selector is assumed to be able to hold, for sizing the
 * read behind the row limit.
 *
 * A guess, and it only ever costs rows: if a page of addresses each carried
 * more than this many active causes, the last rows would be missing rather than
 * wrong. Four is already an address that hard-bounced, complained,
 * unsubscribed and was suppressed by hand.
 */
const SUPPRESSION_CAUSES_PER_ROW_BUDGET = 4;
