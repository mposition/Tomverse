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
import {
  noticeStateForUser,
  recordNoticeObjection,
  recordNoticeShown,
} from "@/lib/inProductConsentNotice";
import { noticeCandidatesFor } from "@/lib/inProductConsentNoticeCore";

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
 * - **Accepting is not consent.** "Yes" takes the person to the email settings,
 *   where turning a purpose on asks for their country and sends a
 *   confirmation (docs/policy/email-double-opt-in.md). The notice collects
 *   nothing a confirmation has not confirmed.
 * - **Refusing is an objection**, recorded against the mailbox.
 */

const SURFACE = "in_product_notice";

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
  return offer.offered
    ? { offered: true, copyVersion: CURRENT_CONSENT_COPY_VERSION }
    : { offered: false };
}

const copyLanguage = (value: string | null | undefined): ConsentCopyLanguage =>
  (CONSENT_COPY_LANGUAGES as readonly string[]).includes(value ?? "")
    ? (value as ConsentCopyLanguage)
    : "en";

export type ConsentNoticeActionResult =
  | { recorded: true }
  | { recorded: false; reason: "disabled" | "not_offered" | "unknown_version" | "no_address" };

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
  action: "shown" | "object";
  language: string | null | undefined;
  copyVersion: string;
}): Promise<ConsentNoticeActionResult> {
  if (!(await consentNoticeCollectionReady())) return { recorded: false, reason: "disabled" };
  if (!consentCopyVersion(input.copyVersion)) return { recorded: false, reason: "unknown_version" };

  // A render is recorded only while the notice is actually offered. A refusal
  // is also accepted right after the render recorded itself -- the screen is
  // still open, and `already_shown` is the render's own trace.
  const offer = await noticeStateForUser({ userId: input.userId });
  const refusalAfterRender =
    input.action === "object" && !offer.offered && offer.refusal === "already_shown";
  if (!offer.offered && !refusalAfterRender) return { recorded: false, reason: "not_offered" };

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

  if (input.action === "shown") {
    await recordNoticeShown(record);
    return { recorded: true };
  }
  await prisma.$transaction(async (tx) => {
    // The render normally recorded itself already; its row is permanent, and
    // re-describing it here could only disagree with it.
    if (!refusalAfterRender) await recordNoticeShown({ ...record, client: tx });
    await recordNoticeObjection({ ...record, client: tx });
  });
  return { recorded: true };
}
