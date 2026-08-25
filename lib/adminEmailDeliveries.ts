import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ADDRESS_REVEAL_MAX_IDS,
  maskEmailAddress,
  type AddressRevealKind,
} from "@/lib/emailAddressMaskingCore";
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
      template: {
        select: { key: true, classification: true, purpose: true },
      },
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
          template: {
            ...(filters.classifications.length > 0
              ? { classification: { in: filters.classifications } }
              : {}),
            ...(filters.templateKey ? { key: filters.templateKey } : {}),
          },
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
      templateVersion: { template: { classification: "legal" } },
    },
  });
}

const SUPPRESSION_SELECT = {
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
} satisfies Prisma.SuppressionEntrySelect;

type AdminSuppressionRecord = Prisma.SuppressionEntryGetPayload<{
  select: typeof SUPPRESSION_SELECT;
}>;

/** Masked for the same reason, and by the same rule, as a delivery row. */
export type AdminSuppressionRow = Omit<
  AdminSuppressionRecord,
  "emailAddress"
> & { emailAddressMasked: string | null };

export async function listSuppressions(input: {
  emailAddress: string | null;
  limit: number;
}): Promise<AdminSuppressionRow[]> {
  const rows = await prisma.suppressionEntry.findMany({
    where: input.emailAddress ? { emailAddress: input.emailAddress } : {},
    select: SUPPRESSION_SELECT,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: input.limit,
  });
  return rows.map(({ emailAddress, ...rest }) => ({
    ...rest,
    emailAddressMasked: maskEmailAddress(emailAddress),
  }));
}

/**
 * The addresses behind a set of rows, for the audited reveal.
 *
 * Separate from the list reads on purpose: those can never return an address,
 * and this can never be reached without the route having checked the role and
 * written the audit entry first. Two functions rather than a flag, because a
 * flag is a thing somebody passes wrongly.
 */
export async function revealEmailAddresses(input: {
  kind: AddressRevealKind;
  ids: readonly string[];
}): Promise<Record<string, string | null>> {
  const ids = Array.from(new Set(input.ids)).slice(0, ADDRESS_REVEAL_MAX_IDS);
  if (ids.length === 0) return {};
  const rows =
    input.kind === "delivery"
      ? await prisma.emailDelivery.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, emailAddress: true },
        })
      : await prisma.suppressionEntry.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, emailAddress: true },
        });
  return Object.fromEntries(rows.map((row) => [row.id, row.emailAddress]));
}
