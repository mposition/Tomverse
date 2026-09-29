import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { estimatedCountryFromHeader } from "@/lib/signupConsentCore";
import {
  normalizeCountry,
  resolveEmailJurisdiction,
  type ResolvedJurisdiction,
} from "@/lib/emailJurisdictionCore";

/**
 * Reads the signals and resolves them.
 *
 * Contract: docs/policy/email-notifications.md §6.
 *
 * The decision itself is pure and lives in emailJurisdictionCore; this only
 * gathers what it needs. Kept apart because the resolution rules are the part
 * that has to be exercised exhaustively, and the part most likely to be
 * quietly changed later.
 */

export type JurisdictionForUser = ResolvedJurisdiction & {
  /** What the person themselves entered, if anything. */
  selfDeclaredCountry: string | null;
};

export async function jurisdictionForUser(input: {
  userId: string;
  /** Observed for measurement only. Never reaches the decision. */
  ipCountry?: string | null;
  /**
   * A declaration being made in this request, before it is persisted.
   *
   * The preference route uses this to validate the exact country that will be
   * committed with consent in the same transaction.
   */
  countryConfirmation?: { country: string; confirmedAt: Date };
  /**
   * The transaction to read in, when the answer has to be the one true inside
   * it.
   *
   * Without it the country is read on the global client, which cannot see a
   * country the caller's transaction has just written. That is harmless for a
   * pure read and not harmless when the answer decides whether a permanent row
   * may be written in the same transaction -- the in-product notice records
   * `notice_shown` once per account, and asking a stale snapshot whether the
   * override will mail somebody let it record a promise the override broke
   * the moment the transaction committed.
   */
  client?: Prisma.TransactionClient;
}): Promise<JurisdictionForUser> {
  const db = input.client ?? prisma;
  const settings = await db.userSettings.findUnique({
    where: { userId: input.userId },
    select: {
      country: true,
      countrySource: true,
      countryUpdatedAt: true,
      billingCountry: true,
      billingCountryUpdatedAt: true,
      language: true,
      timeZone: true,
    },
  });

  // The jurisdiction resolved the last time they actually agreed to something.
  // Only a consent that still stands counts: a withdrawal says nothing about
  // where somebody is.
  const lastConsent = await db.consentRecord.findFirst({
    where: { userId: input.userId, action: { in: ["granted", "reconfirmed"] } },
    orderBy: { occurredAt: "desc" },
    select: { jurisdiction: true },
  });

  const confirmedCountry = normalizeCountry(input.countryConfirmation?.country);
  const confirmedAt = input.countryConfirmation?.confirmedAt;
  const storedSelfDeclaredCountry =
    settings?.countrySource === "self_declared"
      ? normalizeCountry(settings.country)
      : null;
  const selfDeclaredCountry = confirmedCountry ?? storedSelfDeclaredCountry;
  // Recorded from the IP at sign-up or sign-in, and a weaker source than a
  // declaration: read as an estimate, never as what the person said.
  const estimatedCountry =
    settings?.countrySource === "ip_estimated" ? normalizeCountry(settings.country) : null;

  const resolved = resolveEmailJurisdiction({
    billingCountry: settings?.billingCountry ?? null,
    billingCountryUpdatedAt: settings?.billingCountryUpdatedAt ?? null,
    // Only a country the person entered is a declaration. One this system
    // inferred and wrote back would otherwise be read as high confidence on
    // the next pass -- a guess laundered into a fact by a round trip.
    selfDeclaredCountry,
    selfDeclaredCountryUpdatedAt: confirmedCountry
      ? confirmedAt
      : settings?.countryUpdatedAt ?? null,
    consentCountry:
      lastConsent?.jurisdiction && lastConsent.jurisdiction !== "ZZ"
        ? lastConsent.jurisdiction
        : null,
    estimatedCountry,
    language: settings?.language ?? null,
    timeZone: settings?.timeZone ?? null,
    ipCountry: input.ipCountry ?? null,
  });

  return {
    ...resolved,
    selfDeclaredCountry,
  };
}

/**
 * Records the country estimated from a request's IP address, when nothing
 * stronger is recorded.
 *
 * Only into an empty country or over an earlier estimate: a declaration, a
 * billing country or any other source is never overwritten, because a weaker
 * signal must not silently replace a stronger one (the column's own contract).
 * An invalid or unknown IP country (`XX`, `T1`, empty) records nothing.
 *
 * Contract: docs/policy/email-notifications.md §6.1 and §6.2 step 4.
 */
export async function recordEstimatedCountry(input: {
  userId: string;
  ipCountry: string | null | undefined;
  now?: Date;
  client?: Prisma.TransactionClient;
}): Promise<{ recorded: boolean; country: string | null }> {
  // One list of codes that name no country (Cloudflare's `XX` and `T1`, this
  // system's `ZZ`, and the rest), shared with the sign-up screen.
  const country = estimatedCountryFromHeader(input.ipCountry);
  if (!country) return { recorded: false, country: null };
  const db = input.client ?? prisma;
  const now = input.now ?? new Date();
  const existing = await db.userSettings.findUnique({
    where: { userId: input.userId },
    select: { country: true, countrySource: true },
  });
  if (existing?.country && existing.countrySource !== "ip_estimated") {
    return { recorded: false, country: null };
  }
  if (existing?.country === country && existing.countrySource === "ip_estimated") {
    return { recorded: false, country };
  }
  if (existing) {
    // Conditional, so a declaration committed between the read and this write
    // is not replaced by the estimate.
    const updated = await db.userSettings.updateMany({
      where: {
        userId: input.userId,
        OR: [{ country: null }, { countrySource: "ip_estimated" }],
      },
      data: { country, countrySource: "ip_estimated", countryUpdatedAt: now },
    });
    return { recorded: updated.count > 0, country: updated.count > 0 ? country : null };
  }
  await db.userSettings.create({
    data: { userId: input.userId, country, countrySource: "ip_estimated", countryUpdatedAt: now },
  });
  return { recorded: true, country };
}

/**
 * Records what the person says about themselves.
 *
 * Marked `self_declared`, which is what makes it outrank an inference on the
 * next read. Nothing else in this system writes that source.
 */
export async function setSelfDeclaredCountry(input: {
  userId: string;
  country: string;
  now?: Date;
}) {
  const country = normalizeCountry(input.country);
  if (!country) return { updated: false as const };

  await prisma.userSettings.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      country,
      countrySource: "self_declared",
      countryUpdatedAt: input.now ?? new Date(),
    },
    update: {
      country,
      countrySource: "self_declared",
      countryUpdatedAt: input.now ?? new Date(),
    },
  });
  return { updated: true as const, country };
}

/**
 * Records what a payment method reported.
 *
 * Written from the Stripe webhook, never from anything a visitor controls, and
 * stored separately from the declaration so a disagreement between the two
 * stays visible (§6.2 step 3). It does not overwrite the declaration: a person
 * paying with a card registered elsewhere has not moved.
 */
export async function recordBillingCountry(input: {
  userId: string;
  country: string | null | undefined;
  now?: Date;
}) {
  const country = normalizeCountry(input.country);
  if (!country) return { updated: false as const };

  // An upsert, not an update. `UserSettings` is created lazily, and an account
  // that never opened settings has no row -- an update would match nothing,
  // report success, and drop the signal. Dropping it is not neutral: without a
  // billing country the resolver falls back to the consent-time country, so an
  // older consent from an allowlisted country would keep sending after a
  // payment method said the person lives somewhere marketing may not reach.
  const at = input.now ?? new Date();
  try {
    await prisma.userSettings.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, billingCountry: country, billingCountryUpdatedAt: at },
      update: { billingCountry: country, billingCountryUpdatedAt: at },
    });
  } catch (error) {
    // The account is gone (a webhook can outlive a deletion). Nothing to record
    // against, which is the one case where not recording is correct.
    if ((error as { code?: string })?.code === "P2003") {
      return { updated: false as const };
    }
    throw error;
  }
  return { updated: true as const, country };
}
