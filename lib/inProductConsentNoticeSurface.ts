import "server-only";

import { prisma } from "@/lib/prisma";
import {
  isEmailConsentConfirmationEnabled,
  isEmailSignupConsentEnabled,
} from "@/lib/appSettings";
import {
  CONSENT_COPY_LANGUAGES,
  CURRENT_CONSENT_COPY_VERSION,
  consentCopyVersion,
  type ConsentCopyLanguage,
} from "@/lib/emailConsentCopy";
import { consentCopyHash } from "@/lib/emailConsentCopyHash";
import { readConsentKeyring } from "@/lib/emailConsentToken";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import { marketingJurisdictionVerdict } from "@/lib/emailJurisdictionCore";
import { requestConsentConfirmation } from "@/lib/emailConsentConfirmation";
import { CONSENT_CONFIRMATION_TTL_MS } from "@/lib/emailConsentToken";
import {
  noticeStateForUser,
  recordNoticeObjection,
  recordNoticeShown,
} from "@/lib/inProductConsentNotice";
import { noticeCandidatesFor, noticePurposes } from "@/lib/inProductConsentNoticeCore";

/**
 * The in-product consent notice as a screen: when it is offered, and what a
 * render, a refusal and a dismissal leave behind (S8).
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 5.4 --
 * existing accounts are asked once, in the product, never by email. The facts
 * and their rules are lib/inProductConsentNotice.ts; this file only decides
 * when the screen exists and records what it rendered.
 *
 * - **Shown is recorded when it renders**, not when it is closed: that is what
 *   stops it reappearing, and a dismissal leaves nothing else (5.4 -- "닫은
 *   사실은 notice_shown으로 남되 동의도 거부도 아닙니다").
 * - **Accepting requests the confirmations the wording promises.** The
 *   approved body says turning it on sends product updates, newsletters and
 *   promotions, so "Yes" requests a confirmation for each of the three
 *   (docs/policy/email-double-opt-in.md: one confirmation per purpose). Nothing
 *   is consent until each link is used. The notice is therefore offered only
 *   where marketing may be sent under the account's resolved country -- where
 *   it cannot, a "Yes" could not be honoured.
 * - **Refusing is an objection**, recorded against the mailbox.
 */

const SURFACE = "in_product_notice";
const CONFIRMATION_UNAVAILABLE = Symbol("confirmation_unavailable");

/**
 * Whether the notice may appear at all.
 *
 * The collection gate the sign-up screen uses, and a confirmation that can
 * actually be sent: the notice's "Yes" leads to a switch that requests one,
 * and a notice whose yes cannot be honoured is a promise the screen breaks.
 */
export async function consentNoticeCollectionReady(): Promise<boolean> {
  if (!readConsentKeyring(process.env)) return false;
  const [collection, confirmation] = await Promise.all([
    isEmailSignupConsentEnabled(),
    isEmailConsentConfirmationEnabled(),
  ]);
  return collection && confirmation;
}

export type ConsentNoticeView = { offered: false } | { offered: true; copyVersion: string };

/** Whether this account is shown the notice now, and in which approved wording. */
export async function consentNoticeForViewer(userId: string): Promise<ConsentNoticeView> {
  if (!(await consentNoticeCollectionReady())) return { offered: false };
  const offer = await noticeStateForUser({ userId });
  if (!offer.offered) return { offered: false };
  // The "Yes" requests confirmations under the resolved country; where
  // marketing may not go, it could not be honoured.
  const resolved = await jurisdictionForUser({ userId });
  if (!marketingJurisdictionVerdict(resolved).allowed) return { offered: false };
  return { offered: true, copyVersion: CURRENT_CONSENT_COPY_VERSION };
}

const copyLanguage = (value: string | null | undefined): ConsentCopyLanguage =>
  (CONSENT_COPY_LANGUAGES as readonly string[]).includes(value ?? "")
    ? (value as ConsentCopyLanguage)
    : "en";

export type ConsentNoticeActionResult =
  | { recorded: true; requested?: string[] }
  | {
      recorded: false;
      reason:
        | "disabled"
        | "not_offered"
        | "unknown_version"
        | "no_address"
        | "country_not_allowed"
        | "confirmation_unavailable";
    };

/**
 * Records what the screen did: `shown` when it rendered, `object` when the
 * refusal was used (with the render, in one transaction, in case the render's
 * own request was lost).
 *
 * The jurisdiction and the candidates are resolved here, never taken from the
 * client: the row says which rule the screen rendered under, and it can never
 * be corrected.
 */
export async function recordConsentNoticeAction(input: {
  userId: string;
  action: "shown" | "object" | "accept";
  language: string | null | undefined;
  copyVersion: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ConsentNoticeActionResult> {
  if (!(await consentNoticeCollectionReady())) return { recorded: false, reason: "disabled" };
  if (!consentCopyVersion(input.copyVersion)) return { recorded: false, reason: "unknown_version" };

  // A render is recorded only while the notice is actually offered. A refusal
  // is also accepted right after the render recorded itself -- the screen is
  // still open, and `already_shown` is the render's own trace.
  const offer = await noticeStateForUser({ userId: input.userId });
  const alreadyShown = !offer.offered && offer.refusal === "already_shown";
  // The render is one fact per account: another tab, or a response that was
  // lost, may have recorded it already, and that is the render recorded.
  if (input.action === "shown" && alreadyShown) return { recorded: true };
  const answerAfterRender = input.action !== "shown" && alreadyShown;
  if (!offer.offered && !answerAfterRender) return { recorded: false, reason: "not_offered" };

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  });
  if (!user?.email) return { recorded: false, reason: "no_address" };

  const language = copyLanguage(input.language);
  const copyHash = consentCopyHash("noticeBody", language, input.copyVersion);
  if (!copyHash) return { recorded: false, reason: "unknown_version" };

  const resolved = await jurisdictionForUser({ userId: input.userId });
  const involved = [
    ...new Set(
      resolved.confidence === "conflict"
        ? resolved.conflicts
        : resolved.countryCode === "ZZ"
          ? []
          : [resolved.countryCode]
    ),
  ];
  const rules =
    involved.length === 0
      ? []
      : await prisma.releaseNotesCountryRule.findMany({
          where: { countryCode: { in: involved }, policyVersion: { status: "active" } },
          select: { countryCode: true, ruleVersion: true },
        });
  const ruleVersion = new Map(rules.map((rule) => [rule.countryCode, rule.ruleVersion]));
  const candidates = noticeCandidatesFor({
    resolved,
    ruleVersionOf: (country) => ruleVersion.get(country) ?? 0,
    copyHash,
  });

  const record = {
    userId: input.userId,
    emailAddress: user.email,
    surface: SURFACE,
    copyHash,
    candidates,
    resolved: {
      countryCode: resolved.countryCode,
      profileKey: resolved.profileKey,
      confidence: resolved.confidence,
      source: resolved.source,
      conflicts: resolved.conflicts,
    },
  };

  // The render first, on the root client: that path survives a concurrent
  // render request (it re-reads the row on a unique conflict), where a write
  // inside a transaction would abort it and take the answer with it. Skipped
  // when the render already recorded itself -- that row is permanent, and
  // re-describing it could only disagree with it.
  if (input.action === "shown" || !answerAfterRender) await recordNoticeShown(record);
  if (input.action === "shown") return { recorded: true };

  if (input.action === "object") {
    await recordNoticeObjection(record);
    return { recorded: true };
  }

  // Accept: one confirmation per purpose the approved wording names, under the
  // country the account resolves to.
  if (!marketingJurisdictionVerdict(resolved).allowed) {
    return { recorded: false, reason: "country_not_allowed" };
  }
  const countrySource =
    resolved.source === "self_declared"
      ? ("self_declared" as const)
      : resolved.source === "ip_estimated"
        ? ("ip_estimated" as const)
        : ("resolved" as const);
  // Only what is neither confirmed nor waiting on a live link. A new request
  // replaces the pending one's id and kills the link already in the inbox
  // (docs/policy/email-double-opt-in.md), so a pending purpose is left alone.
  const now = Date.now();
  const rows = await prisma.emailPreference.findMany({
    where: { userId: input.userId, purpose: { in: noticePurposes() } },
    select: {
      purpose: true,
      enabled: true,
      confirmedAt: true,
      confirmationRequestId: true,
      confirmationRequestedAt: true,
    },
  });
  const toRequest = noticePurposes().filter((purpose) => {
    const row = rows.find((entry) => entry.purpose === purpose);
    if (!row) return true;
    if (row.enabled && row.confirmedAt) return false;
    const pending =
      row.confirmationRequestId !== null &&
      row.confirmationRequestedAt !== null &&
      now - row.confirmationRequestedAt.getTime() < CONSENT_CONFIRMATION_TTL_MS;
    return !pending;
  });

  // One commit for all of them: a partial "Yes" would leave some mail queued
  // under a screen that says nothing was saved, and the retry that screen
  // invites would then replace those links.
  try {
    await prisma.$transaction(async (tx) => {
      for (const purpose of toRequest) {
        const result = await requestConsentConfirmation({
          userId: input.userId,
          purpose,
          capturedVia: "preference_center",
          evidenceVia: "in_product_notice",
          confirmedCountry: resolved.countryCode,
          jurisdiction: resolved.countryCode,
          jurisdictionSource: resolved.source,
          countrySource,
          language,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          client: tx,
        });
        if (!result.requested) throw CONFIRMATION_UNAVAILABLE;
      }
    });
  } catch (error) {
    // Its own refusals too (already confirmed by a concurrent click, address
    // moved): the transaction rolled back, nothing was queued.
    if (error === CONFIRMATION_UNAVAILABLE || typeof error === "symbol") {
      return { recorded: false, reason: "confirmation_unavailable" };
    }
    throw error;
  }
  return { recorded: true, requested: toRequest };
}
