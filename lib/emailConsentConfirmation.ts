import "server-only";

import { prisma } from "@/lib/prisma";
import { appUrl } from "@/lib/accountEmails";
import { isEmailConsentConfirmationEnabled } from "@/lib/appSettings";
import {
  consentAddressDigest,
  createConsentToken,
  readConsentKeyring,
  readConsentToken,
  type ConsentTokenResult,
} from "@/lib/emailConsentToken";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import {
  marketingJurisdictionVerdict,
  normalizeCountry,
} from "@/lib/emailJurisdictionCore";
import {
  CONSENT_REQUIRED_PURPOSES,
  isEmailPurpose,
} from "@/lib/emailPreferenceCore";
import {
  ensureDefaultPreferences,
  setPreference,
  type ConsentCapture,
} from "@/lib/emailPreferences";
import { normalizeSuppressionAddress } from "@/lib/emailSuppression";
import { ensureBootstrapPolicyVersion } from "@/lib/emailTemplateRegistry";
import { MARKETING_CONSENT_CONFIRMATION_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import type { MarketingConsentPurpose } from "@/lib/marketingConsentConfirmationEmail";
import { enqueueRefused, enqueueStandardEmail } from "@/lib/standardEmailLane";
import { createHmac } from "node:crypto";

/**
 * The double opt-in: asking for a marketing consent confirmation, and applying
 * one.
 *
 * Contract: docs/policy/email-double-opt-in.md §5, §8.
 *
 * Kept beside lib/emailPreferences.ts rather than inside it. The request has to
 * enqueue a message, which pulls in the whole standard lane, and the preference
 * module is imported by paths -- the unsubscribe route among them -- that must
 * not depend on the sender to do their one job.
 *
 * ## The two halves
 *
 * `requestConsentConfirmation()` records the request and queues the mail in one
 * transaction (§5 steps 2-3). `enabled` stays false; nothing is sendable yet.
 *
 * `confirmConsent()` opens the token and applies it through `setPreference()`
 * with the checked confirmation. That write is conditional on the request still
 * being the latest one, so a superseded or cancelled link confirms nothing.
 *
 * Neither is reachable from an unsubscribe token: those are a different prefix
 * under a different keyring and `setPreference()` still refuses `viaToken` with
 * `enabled`.
 */

const evidenceHash = (namespace: string, value: string | null | undefined) => {
  if (!value) return null;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(`consent-evidence:${namespace}:${value}`)
    .digest("hex");
};

export type ConsentConfirmationRequestResult =
  | { requested: true; purpose: MarketingConsentPurpose; requestedAt: Date }
  | {
      requested: false;
      reason:
        | "not_consent_purpose"
        | "no_address"
        | "already_confirmed"
        | "disabled"
        | "keys_missing";
    };

/**
 * Records a confirmation request and queues the confirmation mail.
 *
 * The caller has already decided the country (the route checks the opt-in
 * allowlist and the jurisdiction verdict); this writes what it was told
 * together with the request, so the confirmed country and the consent history
 * cannot disagree.
 */
export async function requestConsentConfirmation(input: {
  userId: string;
  purpose: string;
  capturedVia: ConsentCapture;
  confirmedCountry: string;
  jurisdiction: string;
  jurisdictionSource: string;
  language?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}): Promise<ConsentConfirmationRequestResult> {
  if (!isEmailPurpose(input.purpose) || !CONSENT_REQUIRED_PURPOSES.has(input.purpose)) {
    return { requested: false, reason: "not_consent_purpose" };
  }
  const purpose = input.purpose as MarketingConsentPurpose;

  // The flag first: off means consent cannot be collected yet. It never means
  // collecting it without a confirmation (lib/emailFeatureFlags.ts).
  if (!(await isEmailConsentConfirmationEnabled())) {
    return { requested: false, reason: "disabled" };
  }
  const keyring = readConsentKeyring(process.env);
  if (!keyring) return { requested: false, reason: "keys_missing" };

  const country = normalizeCountry(input.confirmedCountry);
  if (!country) throw new Error("A confirmed country must be a two-letter country code.");

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true, settings: { select: { language: true } } },
  });
  if (!user?.email) return { requested: false, reason: "no_address" };

  await ensureDefaultPreferences(input.userId);
  const existing = await prisma.emailPreference.findUnique({
    where: { userId_purpose: { userId: input.userId, purpose } },
    select: { enabled: true, confirmedAt: true },
  });
  if (existing?.enabled && existing.confirmedAt) {
    return { requested: false, reason: "already_confirmed" };
  }

  const now = input.now ?? new Date();
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const token = createConsentToken(
    {
      userId: input.userId,
      purpose,
      requestedAt: now.toISOString(),
      policyVersionId,
      addressDigest: consentAddressDigest(user.email),
    },
    keyring
  );
  const confirmUrl = `${appUrl()}/consent/confirm?t=${encodeURIComponent(token)}`;

  await prisma.$transaction(async (tx) => {
    await tx.userSettings.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        country,
        countrySource: "self_declared",
        countryUpdatedAt: now,
      },
      update: {
        country,
        countrySource: "self_declared",
        countryUpdatedAt: now,
      },
    });

    // enabled is left exactly as it is: false for an ordinary request, and true
    // only for a row switched on before this step existed, which the send gate
    // already refuses. The request never turns anything on.
    await tx.emailPreference.update({
      where: { userId_purpose: { userId: input.userId, purpose } },
      data: { confirmationRequestedAt: now, confirmedAt: null },
    });

    await tx.consentRecord.create({
      data: {
        userId: input.userId,
        emailAddress: normalizeSuppressionAddress(user.email!),
        purpose,
        action: "confirmation_requested",
        occurredAt: now,
        jurisdiction: input.jurisdiction,
        jurisdictionSource: input.jurisdictionSource,
        policyVersionId,
        capturedVia: input.capturedVia,
        evidence: { via: "preference_center", tokenVersion: keyring.activeVersion },
        ipHash: evidenceHash("ip", input.ip),
        userAgentHash: evidenceHash("ua", input.userAgent),
      },
    });

    // Same transaction as the request (§5, §9.1 of the ADR): split, an account
    // could be left "requested" with no mail on its way, pending forever.
    const queued = await enqueueStandardEmail({
      tx,
      templateKey: MARKETING_CONSENT_CONFIRMATION_TEMPLATE,
      emailAddress: user.email,
      userId: input.userId,
      language: input.language ?? user.settings?.language ?? null,
      payload: { purpose, confirmUrl },
    });
    if (enqueueRefused(queued)) {
      // Transactional templates are never refused for the marketing flag, so
      // this is the no-address case racing the read above. Roll the request
      // back rather than leave it pending with nothing sent.
      throw new Error(`Consent confirmation could not be queued: ${queued.refused}`);
    }
  });

  return { requested: true, purpose, requestedAt: now };
}

export type ConsentConfirmResult =
  | { confirmed: true; purpose: string; alreadyConfirmed: boolean }
  | {
      confirmed: false;
      reason:
        | "invalid"
        | "expired"
        | "superseded"
        | "address_changed"
        | "country_not_allowed"
        | "keys_missing";
    };

/**
 * Applies a confirmation link (§5 steps 4-5). Called from the page's `POST`,
 * never from a `GET`: a mail scanner's prefetch must not be able to create
 * consent (§3 rule 4).
 */
export async function confirmConsent(input: {
  token: string;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}): Promise<ConsentConfirmResult & { tokenReason?: ConsentTokenResult }> {
  const keyring = readConsentKeyring(process.env);
  if (!keyring) return { confirmed: false, reason: "keys_missing" };

  const now = input.now ?? new Date();
  const read = readConsentToken(input.token, keyring, now);
  if (!read.valid) {
    return {
      confirmed: false,
      reason: read.reason === "expired" ? "expired" : "invalid",
      tokenReason: read,
    };
  }
  const { payload } = read;
  if (!isEmailPurpose(payload.purpose) || !CONSENT_REQUIRED_PURPOSES.has(payload.purpose)) {
    return { confirmed: false, reason: "invalid" };
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { email: true },
  });
  if (!user?.email) return { confirmed: false, reason: "invalid" };
  // The click proves ownership of the mailbox the message went to. If the
  // account's address is a different one now, it proves nothing about it.
  if (consentAddressDigest(user.email) !== payload.addressDigest) {
    return { confirmed: false, reason: "address_changed" };
  }

  const preference = await prisma.emailPreference.findUnique({
    where: { userId_purpose: { userId: payload.userId, purpose: payload.purpose } },
    select: { enabled: true, confirmedAt: true, confirmationRequestedAt: true },
  });
  const requestedAt = new Date(payload.requestedAt);

  // A second click on the link that already worked is a success, not an error.
  if (
    preference?.enabled &&
    preference.confirmedAt &&
    preference.confirmationRequestedAt?.getTime() === requestedAt.getTime()
  ) {
    return { confirmed: true, purpose: payload.purpose, alreadyConfirmed: true };
  }
  if (preference?.confirmationRequestedAt?.getTime() !== requestedAt.getTime()) {
    return { confirmed: false, reason: "superseded" };
  }

  // Re-read the jurisdiction at the moment consent is created. The request was
  // checked, but a later billing signal could have moved or conflicted it, and
  // consent stored against a country marketing may not reach is consent nobody
  // can use (docs/policy/email-eea-marketing-review-2026-09-14.md §7).
  const jurisdiction = await jurisdictionForUser({ userId: payload.userId });
  if (!marketingJurisdictionVerdict(jurisdiction).allowed) {
    return { confirmed: false, reason: "country_not_allowed" };
  }

  const result = await setPreference({
    userId: payload.userId,
    purpose: payload.purpose,
    enabled: true,
    capturedVia: "preference_center",
    source: "preference_center",
    jurisdiction: jurisdiction.countryCode,
    jurisdictionSource: jurisdiction.source,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    confirmation: { tokenVersion: read.version, requestedAt },
    now,
  });

  if (result.changed) {
    return { confirmed: true, purpose: payload.purpose, alreadyConfirmed: false };
  }
  if (result.reason === "already_set") {
    return { confirmed: true, purpose: payload.purpose, alreadyConfirmed: true };
  }
  return { confirmed: false, reason: "superseded" };
}
