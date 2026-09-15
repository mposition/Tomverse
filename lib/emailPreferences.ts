import "server-only";

import { createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ensureBootstrapPolicyVersion } from "@/lib/emailTemplateRegistry";
import {
  EMAIL_PURPOSES,
  LOCKED_EMAIL_PURPOSES,
  consentActionFor,
  consentConfirmationState,
  defaultPreferenceEnabled,
  preferenceChangeDecision,
  recordsConsent,
  type ConsentConfirmationState,
  type EmailPurpose,
  type PreferenceChangeRefusal,
} from "@/lib/emailPreferenceCore";
import { normalizeCountry } from "@/lib/emailJurisdictionCore";
import { CONSENT_CONFIRMATION_TTL_MS } from "@/lib/emailConsentToken";
import {
  normalizeSuppressionAddress,
  recordSuppression,
} from "@/lib/emailSuppression";

/**
 * What a person currently receives, and the append-only record of how it got
 * that way.
 *
 * Contract: docs/policy/email-notifications.md §10.2, §11.2, §17.1.
 *
 * The two tables answer different questions and neither substitutes for the
 * other. `EmailPreference` says what is true now and is overwritten on every
 * change; `ConsentRecord` says when somebody agreed, under which policy version
 * and on what evidence, and is never updated. CASL and the Australian Spam Act
 * both put the burden of proving consent on the sender, and a row that gets
 * overwritten proves nothing -- which is the whole reason this is two tables.
 */

/**
 * Hashes an identifier that is evidence rather than data.
 *
 * The raw IP proves nothing about a consent event that its hash does not, and
 * storing it would collect more than the purpose needs (§10.2). Salted with a
 * server secret so the hash cannot be tested against a guessed address either.
 */
const evidenceHash = (namespace: string, value: string | null | undefined) => {
  if (!value) return null;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(`consent-evidence:${namespace}:${value}`)
    .digest("hex");
};

export type ConsentCapture =
  | "signup_form"
  | "preference_center"
  | "unsubscribe_page"
  | "import"
  | "admin";

export type PreferenceChangeResult =
  | { changed: true; purpose: EmailPurpose; enabled: boolean }
  | { changed: false; reason: PreferenceChangeRefusal["reason"] }
  | { changed: false; reason: "already_set" }
  /** The confirmation named a request that is no longer the latest one. */
  | { changed: false; reason: "superseded" };

/**
 * Creates the rows a new account starts with.
 *
 * **No consent records.** Nobody agreed to anything at signup, and writing a
 * `granted` row for a default would put a false statement in the one table
 * whose purpose is to be true about consent. §17.1 says the same about the
 * existing accounts this backfills for.
 *
 * Runs in the caller's transaction when one is passed, so an account and its
 * preferences appear together.
 */
export async function ensureDefaultPreferences(
  userId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
) {
  await client.emailPreference.createMany({
    data: EMAIL_PURPOSES.map((purpose) => ({
      userId,
      purpose,
      enabled: defaultPreferenceEnabled(purpose),
      source: "system_default",
      ...(defaultPreferenceEnabled(purpose) ? { grantedAt: new Date() } : {}),
    })),
    // An account that already has them keeps them: this runs on every settings
    // read, and re-seeding would silently reset somebody's choices.
    skipDuplicates: true,
  });
}

export type PreferenceState = {
  purpose: EmailPurpose;
  enabled: boolean;
  locked: boolean;
  grantedAt: Date | null;
  nextConfirmationNoticeAt: Date | null;
  /**
   * The double opt-in state for a consent-based purpose, null otherwise
   * (docs/policy/email-double-opt-in.md §4.1).
   */
  confirmation: ConsentConfirmationState | null;
  /** When the latest confirmation link stops working, while one is pending. */
  confirmationExpiresAt: Date | null;
};

export async function readPreferences(userId: string): Promise<PreferenceState[]> {
  await ensureDefaultPreferences(userId);
  const rows = await prisma.emailPreference.findMany({
    where: { userId },
    select: {
      purpose: true,
      enabled: true,
      grantedAt: true,
      nextConfirmationNoticeAt: true,
      confirmedAt: true,
      confirmationRequestedAt: true,
    },
  });
  const byPurpose = new Map(rows.map((row) => [row.purpose, row]));

  // Ordered by the constant rather than by the query, so the preference centre
  // cannot end up listing them in insertion order.
  return EMAIL_PURPOSES.map((purpose) => {
    const row = byPurpose.get(purpose);
    const enabled = row?.enabled ?? defaultPreferenceEnabled(purpose);
    const confirmation = recordsConsent(purpose)
      ? consentConfirmationState({
          enabled,
          confirmedAt: row?.confirmedAt ?? null,
          confirmationRequestedAt: row?.confirmationRequestedAt ?? null,
        })
      : null;
    return {
      purpose,
      enabled,
      locked: LOCKED_EMAIL_PURPOSES.has(purpose),
      grantedAt: row?.grantedAt ?? null,
      nextConfirmationNoticeAt: row?.nextConfirmationNoticeAt ?? null,
      confirmation,
      confirmationExpiresAt:
        confirmation === "pending" && row?.confirmationRequestedAt
          ? new Date(row.confirmationRequestedAt.getTime() + CONSENT_CONFIRMATION_TTL_MS)
          : null,
    };
  });
}

/**
 * Applies one change and records it.
 *
 * The preference write and the consent entry happen in one transaction. Split
 * apart, a crash between them leaves either a setting nothing accounts for or
 * an account of a setting that was never applied, and the second is worse:
 * it is evidence of a consent that does not exist.
 *
 * A withdrawal also writes a purpose-scoped suppression. That looks redundant
 * next to the preference itself, and is not: suppression is keyed by address
 * and survives the account, so somebody who unsubscribes, deletes their
 * account and signs up again does not quietly start receiving newsletters
 * because a fresh preference row defaulted them back on.
 */
/**
 * Takes the row lock for one preference inside a transaction. Every transition
 * of a consent-based preference goes through this, so reads and writes of the
 * confirmation state cannot interleave.
 */
export async function lockEmailPreferenceRow(
  tx: Prisma.TransactionClient,
  userId: string,
  purpose: string
) {
  await tx.$queryRaw`SELECT "id" FROM "EmailPreference" WHERE "userId" = ${userId} AND "purpose" = ${purpose} FOR UPDATE`;
}

export async function setPreference(input: {
  userId: string;
  purpose: string;
  enabled: boolean;
  capturedVia: ConsentCapture;
  source: "signup" | "preference_center" | "unsubscribe_link" | "admin";
  viaToken?: boolean;
  jurisdiction?: string | null;
  jurisdictionSource?: string | null;
  deliveryId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  consentWording?: string | null;
  /** The country the person confirmed in the same opt-in action. */
  confirmedCountry?: string | null;
  /**
   * The checked confirmation that authorises switching a consent-based purpose
   * on (docs/policy/email-double-opt-in.md §5 step 5).
   *
   * Only `confirmConsent()` in lib/emailConsentConfirmation.ts passes this, and
   * only after it has opened a confirmation token. It is honoured only while
   * `requestId` is still the row's `confirmationRequestId`, checked under the
   * row lock below, so a token superseded by a newer request -- or cancelled by
   * switching the purpose off -- confirms nothing. `policyVersionId` is the
   * policy the request was made under, and it is what the consent record
   * names: the person agreed under the policy they were shown, not whichever
   * one is active when they click.
   */
  confirmation?: {
    tokenVersion: string;
    requestedAt: Date;
    requestId: string;
    policyVersionId: string;
  };
  now?: Date;
}): Promise<PreferenceChangeResult> {
  const decision = preferenceChangeDecision({
    purpose: input.purpose,
    enabled: input.enabled,
    ...(input.viaToken === undefined ? {} : { viaToken: input.viaToken }),
    confirmed: Boolean(input.confirmation),
  });
  if (!decision.allowed) return { changed: false, reason: decision.reason };

  const purpose = input.purpose as EmailPurpose;
  const now = input.now ?? new Date();
  const confirmedCountry = normalizeCountry(input.confirmedCountry);
  if (input.confirmedCountry !== undefined && !confirmedCountry) {
    throw new Error("A confirmed country must be a two-letter country code.");
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  });
  if (!user?.email) return { changed: false, reason: "unknown_purpose" };

  const policyVersionId =
    input.confirmation?.policyVersionId ?? (await ensureBootstrapPolicyVersion());
  await ensureDefaultPreferences(input.userId);

  const consentBased = recordsConsent(purpose);

  // Every transition of this row -- request, confirm, cancel, withdraw --
  // happens under one row lock, read and write together. Without it a double
  // click grants twice, a request racing a confirmation undoes it, and a cancel
  // racing a confirmation leaves `enabled` true with no confirmation.
  const outcome = await prisma.$transaction(async (tx) => {
    await lockEmailPreferenceRow(tx, input.userId, purpose);
    const existing = await tx.emailPreference.findUnique({
      where: { userId_purpose: { userId: input.userId, purpose } },
      select: { enabled: true, confirmedAt: true, confirmationRequestId: true },
    });
    if (!existing) throw new Error("The preference row was not created.");

    if (input.confirmation) {
      if (existing.confirmationRequestId !== input.confirmation.requestId) {
        return "superseded" as const;
      }
      // A second click on the link that already worked.
      if (existing.enabled && existing.confirmedAt) return "already_set" as const;
    } else if (existing.enabled === input.enabled) {
      // Switching off while only a confirmation is pending: nothing was ever
      // consented to, so there is nothing to withdraw and no history to write.
      // Clearing the request is what makes the mailed link stop working.
      if (!input.enabled && existing.confirmationRequestId) {
        await tx.emailPreference.update({
          where: { userId_purpose: { userId: input.userId, purpose } },
          data: {
            confirmationRequestedAt: null,
            confirmationRequestId: null,
            confirmedAt: null,
          },
        });
        return "cancelled" as const;
      }
      // Idempotent: the unsubscribe link is followed twice, the form is
      // double-submitted, the one-click header and the confirmation page both
      // fire. None of those should add a second entry to the history.
      return "already_set" as const;
    }

    // For a consent-based purpose, "was it on" means "was it confirmed". A row
    // switched on before the confirmation step existed was never consent in the
    // sense the send gate uses, so confirming it is the grant, not a re-grant.
    const wasEffectivelyEnabled = consentBased
      ? existing.enabled && existing.confirmedAt !== null
      : existing.enabled;

    if (confirmedCountry) {
      await tx.userSettings.upsert({
        where: { userId: input.userId },
        create: {
          userId: input.userId,
          country: confirmedCountry,
          countrySource: "self_declared",
          countryUpdatedAt: now,
        },
        update: {
          country: confirmedCountry,
          countrySource: "self_declared",
          countryUpdatedAt: now,
        },
      });
    }

    await tx.emailPreference.update({
      where: { userId_purpose: { userId: input.userId, purpose } },
      data: {
        enabled: input.enabled,
        source: input.source,
        grantedAt: input.enabled ? now : null,
        ...(input.enabled
          ? consentBased
            ? { confirmedAt: now }
            : {}
          : {
              nextConfirmationNoticeAt: null,
              // docs/policy/email-double-opt-in.md §8: switching back on after
              // switching off needs a fresh confirmation.
              confirmedAt: null,
              confirmationRequestedAt: null,
              confirmationRequestId: null,
            }),
      },
    });

    if (consentBased) {
      await tx.consentRecord.create({
        data: {
          userId: input.userId,
          // The address as it is now. Consent attaches to a mailbox, so a later
          // address change must not rewrite what this row says
          // (docs/policy/email-notifications.md §13.4).
          emailAddress: normalizeSuppressionAddress(user.email!),
          purpose,
          action: consentActionFor({
            wasEnabled: wasEffectivelyEnabled,
            nowEnabled: input.enabled,
          }),
          occurredAt: now,
          // Unresolved rather than guessed. Marketing needs a confirmed
          // jurisdiction before it sends (docs/policy/email-notifications.md
          // §6.3), and recording a guess here would launder it into evidence.
          jurisdiction: input.jurisdiction ?? "ZZ",
          jurisdictionSource: input.jurisdictionSource ?? "unresolved",
          policyVersionId,
          capturedVia: input.capturedVia,
          evidence: {
            ...(input.consentWording
              ? { wordingHash: evidenceHash("wording", input.consentWording) }
              : {}),
            ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
            ...(input.confirmation
              ? {
                  confirmedVia: "link",
                  tokenVersion: input.confirmation.tokenVersion,
                  requestedAt: input.confirmation.requestedAt.toISOString(),
                  requestId: input.confirmation.requestId,
                }
              : {}),
            via: input.source,
          },
          ipHash: evidenceHash("ip", input.ip),
          userAgentHash: evidenceHash("ua", input.userAgent),
        },
      });
    }
    return "changed" as const;
  });

  if (outcome === "superseded") return { changed: false, reason: "superseded" };
  if (outcome === "already_set") return { changed: false, reason: "already_set" };
  if (outcome === "cancelled") return { changed: true, purpose, enabled: false };

  if (!input.enabled) {
    await recordSuppression({
      emailAddress: user.email,
      purposeKey: purpose,
      reason: "unsubscribe",
      source:
        input.source === "unsubscribe_link" ? "unsubscribe_link" : "preference_center",
      sourceDeliveryId: input.deliveryId ?? null,
      occurredAt: now,
    });
  } else {
    // Re-enabling clears only this purpose's own hold. A global suppression --
    // a hard bounce, a complaint, an operator decision -- is not something a
    // preference toggle may lift, and §12.4 requires dual approval to remove.
    await prisma.suppressionEntry
      .delete({
        where: {
          emailAddress_scope_purposeKey: {
            emailAddress: normalizeSuppressionAddress(user.email),
            scope: "purpose",
            purposeKey: purpose,
          },
        },
      })
      .catch(() => undefined);
  }

  return { changed: true, purpose, enabled: input.enabled };
}

/**
 * Turns every consent-based purpose off in one action.
 *
 * Present because making somebody flip five switches to stop hearing from us
 * is the kind of friction the Australian rule against extra steps exists to
 * prevent, even where it is not literally prohibited.
 */
export async function withdrawAllMarketing(input: {
  userId: string;
  capturedVia: ConsentCapture;
  source: "preference_center" | "unsubscribe_link" | "admin";
  deliveryId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}) {
  const results: PreferenceChangeResult[] = [];
  for (const purpose of EMAIL_PURPOSES) {
    if (!recordsConsent(purpose)) continue;
    results.push(
      await setPreference({
        ...input,
        purpose,
        enabled: false,
        viaToken: input.source === "unsubscribe_link",
      })
    );
  }
  return results;
}
