import "server-only";

import { createHmac, randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isEmailConsentConfirmationEnabled } from "@/lib/appSettings";
import {
  consentAddressDigest,
  readConsentKeyring,
  readConsentToken,
  type ConsentTokenResult,
  CONSENT_CONFIRMATION_TTL_MS,
} from "@/lib/emailConsentToken";
import { jurisdictionForUser, recordEstimatedCountry } from "@/lib/emailJurisdiction";
import { prepareProcessingResultNotice } from "@/lib/processingResultNotice";
import {
  marketingJurisdictionVerdict,
  normalizeCountry,
  profileForCountry,
  type ResolvedJurisdiction,
} from "@/lib/emailJurisdictionCore";
import {
  CONSENT_REQUIRED_PURPOSES,
  addressProofCovers,
  isEmailPurpose,
  preferenceChangeDecision,
} from "@/lib/emailPreferenceCore";
import {
  ensureDefaultPreferences,
  lockEmailPreferenceRow,
  lockUserEmail,
  sealVerifiedSessionConfirmation,
  setPreference,
  type ConsentCapture,
  type ConsentRecordedHook,
  type VerifiedSessionConfirmation,
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
        | "pending"
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
  /**
   * Where the country came from. `self_declared` (the default) is the settings
   * screen, where the person picks it. `ip_estimated` is the sign-up screen
   * (S4), where the country is the IP estimate the screen rendered under: it is
   * recorded as an estimate, never as something the person said, and never over
   * a stronger source. `resolved` is the in-product notice (S8), which asks
   * under the country the account already resolves to and writes none.
   */
  countrySource?: "self_declared" | "ip_estimated" | "resolved";
  /**
   * The screen, for the consent record's evidence. Defaults to the settings
   * screen. `in_product_notice` is the one-time notice (S8): its record's
   * `capturedVia` stays `preference_center`, the closed list the ledger
   * accepts, and the evidence names the screen.
   */
  evidenceVia?: "preference_center" | "signup_form" | "in_product_notice";
  /**
   * The caller's transaction, when this request has to commit with the caller's
   * own writes -- the sign-up consumption records the choice, the notice and
   * this request as one fact (draft section 5.2). A refusal found inside it
   * (already confirmed, address moved) is then thrown rather than returned, so
   * the caller's transaction does not commit half of it.
   */
  client?: Prisma.TransactionClient;
  /**
   * The caller seeded the account's preference rows before opening
   * `client`'s transaction. Required when one transaction requests several
   * purposes: seeding on the global client (an INSERT ... ON CONFLICT on the
   * same rows) would wait on the row the first request locked and updated,
   * and the transaction waits on it -- until the interactive timeout.
   */
  preferencesSeeded?: boolean;
  /**
   * Leave a purpose alone that is already waiting on a live link, decided under
   * the row lock: a new request would replace its id and kill the link in the
   * inbox. Answered as `{ requested: false, reason: "pending" }`, not thrown.
   */
  skipIfPending?: boolean;
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

  if (!input.preferencesSeeded) await ensureDefaultPreferences(input.userId);
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

  const countrySource = input.countrySource ?? "self_declared";
  let skippedPending = false;
  const write = async (tx: Prisma.TransactionClient) => {
      // Same lock order as setPreference(): user, then preference. The address
      // the mail goes to is the one read under the lock.
      const lockedEmail = await lockUserEmail(tx, input.userId);
      if (!lockedEmail || consentAddressDigest(lockedEmail) !== stored.request.addressDigest) {
        throw ADDRESS_MOVED;
      }
      await lockEmailPreferenceRow(tx, input.userId, purpose);
      const existing = await tx.emailPreference.findUnique({
        where: { userId_purpose: { userId: input.userId, purpose } },
        select: {
          enabled: true,
          confirmedAt: true,
          confirmationRequestId: true,
          confirmationRequestedAt: true,
        },
      });
      if (existing?.enabled && existing.confirmedAt) throw ALREADY_CONFIRMED;
      if (
        input.skipIfPending &&
        existing &&
        !existing.enabled &&
        existing.confirmationRequestId !== null &&
        existing.confirmationRequestedAt !== null &&
        now.getTime() - existing.confirmationRequestedAt.getTime() < CONSENT_CONFIRMATION_TTL_MS
      ) {
        skippedPending = true;
        return;
      }

      if (countrySource === "self_declared") {
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
      } else if (countrySource === "ip_estimated") {
        await recordEstimatedCountry({ userId: input.userId, ipCountry: country, now, client: tx });
      }
      // `resolved`: the country is the resolution's own -- billing, an earlier
      // consent -- and is already recorded where it came from. Writing it again
      // as something else would turn a billing country into a declaration.

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
          evidence: { via: input.evidenceVia ?? "preference_center", requestId },
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
  };

  if (input.client) {
    await write(input.client);
    if (skippedPending) return { requested: false, reason: "pending" };
    return { requested: true, purpose, requestedAt: now };
  }

  try {
    await prisma.$transaction(write);
  } catch (error) {
    if (error === ALREADY_CONFIRMED) return { requested: false, reason: "already_confirmed" };
    // The address changed between the read and the lock; nothing was written.
    if (error === ADDRESS_MOVED) return { requested: false, reason: "no_address" };
    throw error;
  }

  if (skippedPending) return { requested: false, reason: "pending" };
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

  // Korea's 14-day result notice, queued in the transaction that records the
  // consent (docs/policy/email-product-news-redesign-draft.md 7.7). Prepared
  // here because preparing may insert template rows.
  const onConsentRecorded = await prepareProcessingResultNotice(payload.userId);
  const result = await setPreference({
    userId: payload.userId,
    purpose: payload.purpose,
    enabled: true,
    onConsentRecorded,
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

/* ---------------------- consent from a proven session (docs/policy/email-double-opt-in.md §14) */

export type VerifiedSessionGrant = {
  confirmation: VerifiedSessionConfirmation;
  /**
   * Queues Korea's result notice in the transaction that records the grant --
   * once per transaction, however many purposes it grants. One answer is one
   * consent, and the notice names marketing email rather than a purpose
   * (docs/policy/email-double-opt-in.md §14.8).
   */
  onConsentRecorded: ConsentRecordedHook;
  jurisdiction: { countryCode: string; source: string };
  /** The active policy version, resolved before the caller's transaction. */
  policyVersionId: string;
};

export type VerifiedSessionGrantRefusal =
  | "no_proof"
  | "disabled"
  | "not_consent_purpose"
  | "country_not_allowed"
  | "no_address";

/**
 * Everything a consent from a proven session needs, checked before the
 * caller's transaction (docs/policy/email-double-opt-in.md §14.6).
 *
 * The collection flag, the purposes, the proof against the account's current
 * address and the jurisdiction are decided here; the address is decided again
 * under the user row lock by `applyPreferenceChange()`, which honours only
 * the sealed confirmation this returns. A refusal is not an error: the caller
 * falls back to the confirmation mail, which makes its own checks.
 *
 * `jurisdiction` is for a caller that has resolved it already and whose user
 * row does not hold it yet -- the sign-up, whose estimated country is recorded
 * in the same transaction as the grant.
 */
export async function prepareVerifiedSessionGrant(input: {
  userId: string;
  proof: unknown;
  purposes: readonly string[];
  jurisdiction?: ResolvedJurisdiction;
}): Promise<{ ok: true; grant: VerifiedSessionGrant } | { ok: false; reason: VerifiedSessionGrantRefusal }> {
  for (const purpose of input.purposes) {
    if (!isEmailPurpose(purpose) || !CONSENT_REQUIRED_PURPOSES.has(purpose)) {
      return { ok: false, reason: "not_consent_purpose" };
    }
    if (!preferenceChangeDecision({ purpose, enabled: true, confirmed: true }).allowed) {
      return { ok: false, reason: "not_consent_purpose" };
    }
  }
  if (!(await isEmailConsentConfirmationEnabled())) return { ok: false, reason: "disabled" };

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  });
  if (!user?.email) return { ok: false, reason: "no_address" };
  if (!addressProofCovers(input.proof, user.email)) return { ok: false, reason: "no_proof" };

  const resolved = input.jurisdiction ?? (await jurisdictionForUser({ userId: input.userId }));
  if (!marketingJurisdictionVerdict(resolved).allowed) {
    return { ok: false, reason: "country_not_allowed" };
  }

  // Before any transaction: both may insert rows (docs/policy/email-double-opt-in.md §13.1 item 16).
  await ensureDefaultPreferences(input.userId);
  const confirmation = await sealVerifiedSessionConfirmation({
    proof: input.proof,
    purposes: input.purposes,
    jurisdiction: resolved,
  });
  if (!confirmation) return { ok: false, reason: "disabled" };
  const queueNotice = await prepareProcessingResultNotice(input.userId, {
    jurisdiction: resolved,
  });
  // Keyed by the transaction rather than a flag: a rolled-back attempt queued
  // nothing, and another transaction with this grant must still queue one.
  const noticeQueued = new WeakSet<object>();
  const onConsentRecorded: ConsentRecordedHook = async (tx, record) => {
    if (noticeQueued.has(tx)) return;
    noticeQueued.add(tx);
    await queueNotice(tx, record);
  };
  const policyVersionId = await ensureBootstrapPolicyVersion();

  return {
    ok: true,
    grant: {
      confirmation,
      onConsentRecorded,
      jurisdiction: { countryCode: resolved.countryCode, source: resolved.source },
      policyVersionId,
    },
  };
}

/**
 * Switches one consent purpose on from a proven session, in its own
 * transaction -- the logged-in settings screen (docs/policy/email-double-opt-in.md §14.2). Returns
 * `granted: false` with the reason when the session cannot consent this way,
 * so the caller can send the confirmation mail instead.
 */
export async function grantConsentWithVerifiedSession(input: {
  userId: string;
  purpose: string;
  proof: unknown;
  capturedVia: ConsentCapture;
  jurisdiction?: ResolvedJurisdiction;
  confirmedCountry?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  now?: Date;
}): Promise<
  | { granted: true; alreadyConfirmed: boolean }
  | { granted: false; reason: VerifiedSessionGrantRefusal | "address_changed" | "suppressed" }
> {
  const prepared = await prepareVerifiedSessionGrant({
    userId: input.userId,
    proof: input.proof,
    purposes: [input.purpose],
    ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
  });
  if (!prepared.ok) return { granted: false, reason: prepared.reason };
  const { grant } = prepared;
  const result = await setPreference({
    userId: input.userId,
    purpose: input.purpose,
    enabled: true,
    capturedVia: input.capturedVia,
    source: "preference_center",
    jurisdiction: grant.jurisdiction.countryCode,
    jurisdictionSource: grant.jurisdiction.source,
    // Only a country the person confirmed in this action; setPreference reads
    // any value it is given, null included, as one to validate.
    ...(input.confirmedCountry ? { confirmedCountry: input.confirmedCountry } : {}),
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    confirmation: grant.confirmation,
    onConsentRecorded: grant.onConsentRecorded,
    ...(input.now ? { now: input.now } : {}),
  });
  if (result.changed) return { granted: true, alreadyConfirmed: false };
  if (result.reason === "already_set") return { granted: true, alreadyConfirmed: true };
  if (result.reason === "address_changed") return { granted: false, reason: "address_changed" };
  if (result.reason === "suppressed") return { granted: false, reason: "suppressed" };
  return { granted: false, reason: "no_proof" };
}

