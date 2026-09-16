import "server-only";

import { createHmac, randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { isEmailConsentConfirmationEnabled } from "@/lib/appSettings";
import {
  consentAddressDigest,
  readConsentKeyring,
  readConsentToken,
  type ConsentTokenResult,
} from "@/lib/emailConsentToken";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import {
  marketingJurisdictionVerdict,
  normalizeCountry,
  profileForCountry,
} from "@/lib/emailJurisdictionCore";
import {
  CONSENT_REQUIRED_PURPOSES,
  isEmailPurpose,
} from "@/lib/emailPreferenceCore";
import {
  ensureDefaultPreferences,
  lockEmailPreferenceRow,
  lockUserEmail,
  setPreference,
  type ConsentCapture,
} from "@/lib/emailPreferences";
import { normalizeSuppressionAddress } from "@/lib/emailSuppression";
import {
  ensureBootstrapPolicyVersion,
  ensureTemplateVersion,
} from "@/lib/emailTemplateRegistry";
import { isLanguage } from "@/lib/language";
import { MARKETING_CONSENT_CONFIRMATION_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import type {
  MarketingConsentPurpose,
  StoredConsentConfirmationPayload,
} from "@/lib/marketingConsentConfirmationEmail";
import { createStandardDeliveryRows } from "@/lib/standardEmailLane";

/**
 * The double opt-in: asking for a marketing consent confirmation, and applying
 * one.
 *
 * Contract: docs/policy/email-double-opt-in.md §5, §8, §13.
 *
 * Kept beside lib/emailPreferences.ts rather than inside it. The request has to
 * enqueue a message, which pulls in the whole standard lane, and the preference
 * module is imported by paths -- the unsubscribe route among them -- that must
 * not depend on the sender to do their one job.
 *
 * ## The two halves
 *
 * `requestConsentConfirmation()` records the request and queues the mail in one
 * transaction, under the preference row's lock
 * (docs/policy/email-double-opt-in.md §5 steps 2-3). `enabled` stays false.
 *
 * `confirmConsent()` opens the token and applies it through `setPreference()`
 * with the checked confirmation, which re-checks the request id under the same
 * lock.
 *
 * ## The link is never stored
 *
 * The delivery snapshot holds the request's non-secret fields; the token is
 * built from them at send time (`prepareForSend` on the template definition)
 * and the lane keeps it out of the audit hash. The link carries the token in
 * the URL fragment, which no server, proxy or error reporter ever receives.
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

const ALREADY_CONFIRMED = Symbol("already_confirmed");
const ADDRESS_MOVED = Symbol("address_moved");

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
  // Checked here so the request is refused up front; the token itself is built
  // at send time, where a missing key fails the delivery rather than storing a
  // link.
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
  const now = input.now ?? new Date();
  const policyVersionId = await ensureBootstrapPolicyVersion();
  const requestId = randomUUID();

  const stored: StoredConsentConfirmationPayload = {
    purpose,
    request: {
      userId: input.userId,
      requestedAt: now.toISOString(),
      requestId,
      policyVersionId,
      addressDigest: consentAddressDigest(user.email),
    },
    tokenKeyVersion: keyring.activeVersion,
  };

  // Everything the delivery rows need is resolved before the transaction, so
  // the transaction holds one connection and does nothing but its own writes.
  // Resolving these with the global client while the row locks are held would
  // take a second connection per request and can starve the pool.
  const requested = input.language ?? user.settings?.language ?? null;
  const language = isLanguage(requested) ? requested : "en";
  const template = await ensureTemplateVersion({
    templateKey: MARKETING_CONSENT_CONFIRMATION_TEMPLATE,
    language,
  });

  try {
    await prisma.$transaction(async (tx) => {
      // Same lock order as setPreference(): user, then preference. The address
      // the mail goes to is the one read under the lock.
      const lockedEmail = await lockUserEmail(tx, input.userId);
      if (!lockedEmail || consentAddressDigest(lockedEmail) !== stored.request.addressDigest) {
        throw ADDRESS_MOVED;
      }
      await lockEmailPreferenceRow(tx, input.userId, purpose);
      const existing = await tx.emailPreference.findUnique({
        where: { userId_purpose: { userId: input.userId, purpose } },
        select: { enabled: true, confirmedAt: true },
      });
      if (existing?.enabled && existing.confirmedAt) throw ALREADY_CONFIRMED;

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

      // enabled is left exactly as it is: false for an ordinary request, and
      // true only for a row switched on before this step existed, which the send
      // gate already refuses. The request never turns anything on.
      await tx.emailPreference.update({
        where: { userId_purpose: { userId: input.userId, purpose } },
        data: {
          confirmationRequestedAt: now,
          confirmationRequestId: requestId,
          confirmedAt: null,
        },
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
          evidence: { via: "preference_center", requestId },
          ipHash: evidenceHash("ip", input.ip),
          userAgentHash: evidenceHash("ua", input.userAgent),
        },
      });

      // Same transaction as the request (docs/policy/email-notifications.md
      // §9.1): split, an account could be left "requested" with no mail on its
      // way, pending forever. The jurisdiction is the one this request just
      // confirmed, not a fresh read that could not see this transaction.
      await createStandardDeliveryRows(tx, {
        templateKey: MARKETING_CONSENT_CONFIRMATION_TEMPLATE,
        emailAddress: lockedEmail,
        userId: input.userId,
        language,
        payload: stored,
        ...template,
        policyVersionId,
        jurisdictionCountry: country,
        jurisdictionProfileKey: profileForCountry(country),
      });
    });
  } catch (error) {
    if (error === ALREADY_CONFIRMED) return { requested: false, reason: "already_confirmed" };
    // The address changed between the read and the lock; nothing was written.
    if (error === ADDRESS_MOVED) return { requested: false, reason: "no_address" };
    throw error;
  }

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
        | "suppressed"
        | "disabled"
        | "keys_missing";
    };

/**
 * Applies a confirmation link (docs/policy/email-double-opt-in.md §5 steps
 * 4-5). Called from the page's `POST`, never from a `GET`: a mail scanner's
 * prefetch must not be able to create consent.
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

  // Off means consent is not being collected -- including through links that
  // were mailed before somebody switched it off (docs/policy/email-double-opt-in.md
  // §13.1). Turning it back on within the link's lifetime lets them work again.
  if (!(await isEmailConsentConfirmationEnabled())) {
    return { confirmed: false, reason: "disabled" };
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

  // The policy the request was made under must still exist; the consent record
  // names it rather than whichever version is active now.
  const policy = await prisma.emailPolicyVersion.findUnique({
    where: { id: payload.policyVersionId },
    select: { id: true },
  });
  if (!policy) return { confirmed: false, reason: "invalid" };

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
    confirmation: {
      tokenVersion: read.version,
      requestedAt: new Date(payload.requestedAt),
      requestId: payload.requestId,
      policyVersionId: payload.policyVersionId,
      addressDigest: payload.addressDigest,
    },
    now,
  });

  if (result.changed) {
    return { confirmed: true, purpose: payload.purpose, alreadyConfirmed: false };
  }
  if (result.reason === "already_set") {
    return { confirmed: true, purpose: payload.purpose, alreadyConfirmed: true };
  }
  if (result.reason === "address_changed") return { confirmed: false, reason: "address_changed" };
  if (result.reason === "suppressed") return { confirmed: false, reason: "suppressed" };
  return { confirmed: false, reason: "superseded" };
}
