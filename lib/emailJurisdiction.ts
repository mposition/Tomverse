import "server-only";

import { prisma } from "@/lib/prisma";
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
}): Promise<JurisdictionForUser> {
  const settings = await prisma.userSettings.findUnique({
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
  const lastConsent = await prisma.consentRecord.findFirst({
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
