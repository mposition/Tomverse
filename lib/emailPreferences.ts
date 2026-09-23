import "server-only";

import { createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ensureBootstrapPolicyVersion } from "@/lib/emailTemplateRegistry";
import {
  BULK_UNSUBSCRIBE_PURPOSES,
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
import { CONSENT_CONFIRMATION_TTL_MS, consentAddressDigest } from "@/lib/emailConsentToken";
import {
  normalizeSuppressionAddress,
  recordSuppression,
  type SuppressionSource,
} from "@/lib/emailSuppression";
import { markCauseWriter, releaseSelectorCauses } from "@/lib/emailSuppressionCauses";
import { lockSuppressionAddress } from "@/lib/emailSuppressionAuthority";
import { isActiveCause } from "@/lib/emailSuppressionAuthorityCore";

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
  | "admin"
  /** A spam complaint about a message of this purpose (section 7.4 of the redesign draft). */
  | "provider_complaint";

export type PreferenceChangeResult =
  | { changed: true; purpose: EmailPurpose; enabled: boolean }
  | { changed: false; reason: PreferenceChangeRefusal["reason"] }
  | { changed: false; reason: "already_set" }
  /** The confirmation named a request that is no longer the latest one. */
  | { changed: false; reason: "superseded" }
  /** The account's address is not the one the confirmation link was sent to. */
  | { changed: false; reason: "address_changed" }
  /**
   * Switching on lifts only this purpose's own unsubscribe, and another active
   * cause still stops this mail
   * (docs/policy/email-product-news-redesign-draft.md, section 7.4).
   */
  | { changed: false; reason: "suppressed" };

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

/**
 * `ensureDefaultPreferences()` for a writer that is about to lock the account
 * and may find it deleted. Runs on its own, before that transaction: seeding
 * under the User row lock would take the lock and then the preference keys,
 * the reverse of every unlocked seeding path, and two such transactions can
 * deadlock. An account that no longer exists has nothing to seed, and the
 * writer finds that out under its lock.
 */
export async function seedPreferencesIfAccountExists(userId: string) {
  try {
    await ensureDefaultPreferences(userId);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== "P2003") throw error;
  }
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
export async function lockUserEmail(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ email: string | null }>>`SELECT "email" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  return rows[0]?.email ?? null;
}

/**
 * Takes the row lock for one preference inside a transaction. Every transition
 * of a consent-based preference goes through this, so reads and writes of the
 * confirmation state cannot interleave. Always after `lockUserEmail()`, so the
 * two locks are taken in one order everywhere.
 */
export async function lockEmailPreferenceRow(
  tx: Prisma.TransactionClient,
  userId: string,
  purpose: string
) {
  await tx.$queryRaw`SELECT "id" FROM "EmailPreference" WHERE "userId" = ${userId} AND "purpose" = ${purpose} FOR UPDATE`;
}

/**
 * Where a preference change came from. `privacy_request` and
 * `provider_complaint` are written only by the privacy intake and the complaint
 * handler, inside their own transactions
 * (docs/policy/email-product-news-redesign-draft.md, section 7.4).
 */
export type PreferenceSource =
  | "signup"
  | "preference_center"
  | "unsubscribe_link"
  | "admin"
  | "privacy_request"
  | "provider_complaint";

export type SetPreferenceInput = {
  userId: string;
  purpose: string;
  enabled: boolean;
  capturedVia: ConsentCapture;
  source: PreferenceSource;
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
    /** The mailbox the link was sent to, re-checked under the user row lock. */
    addressDigest: string;
  };
  now?: Date;
};

export async function setPreference(input: SetPreferenceInput): Promise<PreferenceChangeResult> {
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

  // Every transition of this row -- request, confirm, cancel, withdraw --
  // happens under one row lock, read and write together. Without it a double
  // click grants twice, a request racing a confirmation undoes it, and a cancel
  // racing a confirmation leaves `enabled` true with no confirmation.
  const outcome = await prisma.$transaction((tx) =>
    applyPreferenceChange(tx, { ...input, purpose, now, policyVersionId, confirmedCountry })
  );

  if (outcome === "no_address") return { changed: false, reason: "unknown_purpose" };
  if (outcome === "address_changed") return { changed: false, reason: "address_changed" };
  if (outcome === "superseded") return { changed: false, reason: "superseded" };
  if (outcome === "already_set") return { changed: false, reason: "already_set" };
  if (outcome === "suppressed") return { changed: false, reason: "suppressed" };
  if (outcome === "cancelled") return { changed: true, purpose, enabled: false };

  return { changed: true, purpose, enabled: input.enabled };
}

export type PreferenceChangeOutcome =
  | "no_address"
  | "address_changed"
  | "superseded"
  | "already_set"
  | "suppressed"
  | "cancelled"
  | "changed";

/**
 * One preference change inside the caller's transaction. `setPreference()` is
 * the entry point for requests; the privacy intake and the complaint handler
 * call this directly because the change has to commit with the suppression that
 * caused it. The caller has checked the purpose may change, created the
 * default rows, and resolved the policy version -- none of which belongs
 * inside a transaction already holding the address.
 *
 * Takes the User row, the address and the preference row in that order; a
 * caller that already holds some of them takes them again harmlessly.
 */
export async function applyPreferenceChange(
  tx: Prisma.TransactionClient,
  input: SetPreferenceInput & {
    purpose: EmailPurpose;
    now: Date;
    policyVersionId: string;
    confirmedCountry: string | null;
    /** Keys the withdrawal's cause to the event behind it rather than to the transition. */
    suppressionEventKey?: string;
    suppressionSource?: SuppressionSource;
  }
): Promise<PreferenceChangeOutcome> {
  const { purpose, now, policyVersionId, confirmedCountry } = input;
  const consentBased = recordsConsent(purpose);

  // The address is read under the user row lock and everything below uses
  // that value, so a confirmation cannot be recorded against an address that
  // changed after the link was checked, and a withdrawal suppresses the
  // address that actually withdrew.
  const email = await lockUserEmail(tx, input.userId);
  if (!email) return "no_address" as const;
  if (
    input.confirmation &&
    consentAddressDigest(email) !== input.confirmation.addressDigest
  ) {
    return "address_changed" as const;
  }
  // Every suppression write, release and blocker check for this address is
  // serialised here: no cause can appear between the blocker check below and
  // the release that follows it. After the user row and before the preference
  // row, the one order every writer takes
  // (docs/policy/email-product-news-redesign-draft.md, section 7.4).
  await lockSuppressionAddress(tx, normalizeSuppressionAddress(email));
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

  // Switching on lifts only this purpose's own unsubscribe. Any other active
  // cause for this purpose, for marketing as a whole, or for the address (a
  // soft bounce aside, which expires) still stops the mail, so the switch is
  // refused rather than shown as on.
  //
  // Turning a purpose on is refused while something other than this person's
  // own unsubscribe is stopping that mail: a hold or a privacy request on the
  // purpose, the marketing classification stop a deletion intake writes, or
  // anything global that is not a soft bounce.
  //
  // This used to have a second list for the entry era, which recognised only
  // privacy requests -- an entry read could not see a classification cause, so
  // the narrower list was all it could honour. Nothing reads entries now.
  if (input.enabled) {
    const blocking = await tx.suppressionCause.findMany({
      where: {
        emailAddress: normalizeSuppressionAddress(email),
        releasedAt: null,
        OR: [
          { scope: "purpose", purposeKey: purpose, reason: { not: "unsubscribe" } },
          ...(consentBased ? [{ scope: "classification", purposeKey: "marketing" }] : []),
          { scope: "global", reason: { not: "soft_bounce" } },
        ],
      },
      select: { id: true, expiresAt: true, releasedAt: true },
    });
    if (blocking.some((cause) => isActiveCause(cause, now))) {
      return "suppressed" as const;
    }
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

  let consentRecordId: string | null = null;
  // Switching off records a withdrawal only where there was consent to
  // withdraw. A row that was on without a confirmation -- from before the
  // confirmation step, or never confirmed -- consented to nothing, and a
  // withdrawal row would say it had. The transition and the hold are still
  // written below.
  if (consentBased && (input.enabled || wasEffectivelyEnabled)) {
    const consentRecord = await tx.consentRecord.create({
      data: {
        userId: input.userId,
        // The address as it is now. Consent attaches to a mailbox, so a later
        // address change must not rewrite what this row says
        // (docs/policy/email-notifications.md §13.4).
        emailAddress: normalizeSuppressionAddress(email),
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
    consentRecordId = consentRecord.id;
  }

  // Every change of the enabled state, append-only. The id keys the suppression
  // cause a withdrawal creates, including withdrawals that record no consent
  // (docs/policy/email-product-news-redesign-draft.md, section 7.4).
  const transition =
    existing.enabled !== input.enabled
      ? await tx.emailPreferenceTransition.create({
          data: {
            userId: input.userId,
            purpose,
            fromEnabled: existing.enabled,
            toEnabled: input.enabled,
            source: input.confirmation ? "consent_confirmation" : input.source,
            consentRecordId,
            occurredAt: now,
          },
          select: { id: true },
        })
      : null;

  if (!input.enabled) {
    await recordSuppression(
      {
        emailAddress: email,
        purposeKey: purpose,
        reason: "unsubscribe",
        source:
          input.suppressionSource ??
          (input.source === "unsubscribe_link" ? "unsubscribe_link" : "preference_center"),
        sourceDeliveryId: input.deliveryId ?? null,
        occurredAt: now,
        // A switch-off always changes the enabled state (an unchanged one
        // returned above), so the transition exists.
        sourceEventKey:
          input.suppressionEventKey ?? `preference:${transition?.id ?? "unchanged"}`,
      },
      tx
    );
  } else {
    // Re-enabling clears only this purpose's own hold. A global suppression --
    // a hard bounce, a complaint, an operator decision -- is not something a
    // preference toggle may lift (docs/policy/email-notifications.md §12.4).
    // deleteMany rather than delete: a missing row must not abort the
    // transaction.
    // The causes behind that hold are released with it, keyed to the
    // transition that lifted them.
    await markCauseWriter(tx);
    await releaseSelectorCauses(tx, {
      emailAddress: normalizeSuppressionAddress(email),
      scope: "purpose",
      purposeKey: purpose,
      // Only the unsubscribe the person asked for is theirs to lift. Turning a
      // purpose back on says nothing about a hard bounce or a complaint on the
      // same address, and releasing those because somebody flipped a switch is
      // how a suppression stops meaning anything.
      //
      // This used to depend on the read authority: entries decided in an older
      // build, where lifting the row lifted everything behind it. That build is
      // below this deploy's floor and the mirror is no longer written.
      onlyReason: "unsubscribe",
      releaseKind: "preference_enabled",
      releaseEvidence: { kind: "preference", transitionId: transition?.id ?? null },
      releasedAt: now,
    });
  }
  return "changed" as const;
}

/**
 * Turns every marketing purpose off in one action.
 *
 * Present because making somebody flip five switches to stop hearing from us
 * is the kind of friction the Australian rule against extra steps exists to
 * prevent, even where it is not literally prohibited.
 *
 * The scope comes from BULK_UNSUBSCRIBE_PURPOSES, which is derived from the
 * classification table rather than from the consent-required set. Those two
 * hold the same purposes today and are answers to different questions: one
 * asks what class of mail it is, the other whether an explicit consent is
 * needed before sending it. Reading the second here would mean that a country
 * rule making a marketing purpose sendable without consent would quietly drop
 * it out of "unsubscribe from everything" (invariant 5,
 * docs/policy/email-product-news-redesign-draft.md section 7.1).
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
  for (const purpose of BULK_UNSUBSCRIBE_PURPOSES) {
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
