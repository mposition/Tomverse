import "server-only";

import type { Prisma } from "@prisma/client";

import { EMAIL_PURPOSES, recordsConsent } from "@/lib/emailPreferenceCore";
import {
  applyPreferenceChange,
  ensureDefaultPreferences,
  lockUserEmail,
} from "@/lib/emailPreferences";
import { normalizeSuppressionAddress, recordSuppression } from "@/lib/emailSuppression";
import {
  holdSuppressionFence,
  lockSuppressionAddress,
  readSuppressionAuthority,
} from "@/lib/emailSuppressionAuthority";
import { ensureBootstrapPolicyVersion } from "@/lib/emailTemplateRegistry";

/**
 * The suppressions a deletion request writes.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
 * (privacy request).
 *
 * Intake stops marketing and withdraws it; completion, once no legal hold stands
 * in the way, stops every mail to the address. Both are keyed to the request, so
 * saving the same state twice records nothing new.
 */

/**
 * The policy version a withdrawal names, resolved before the intake
 * transaction opens: it may create a row, and nothing may start before the
 * fence.
 */
export async function preparePrivacyIntake() {
  return { policyVersionId: await ensureBootstrapPolicyVersion() };
}

/**
 * Takes the fence and the User row, in the one order every writer uses, and
 * returns the account's address as locked. Called first in the intake
 * transaction, before the request row is written: the request records that
 * address, and the foreign key's share lock on the User row comes after the row
 * lock rather than before it.
 */
export async function lockPrivacyIntake(
  tx: Prisma.TransactionClient,
  input: { userId: string | null }
) {
  await holdSuppressionFence(tx);
  return input.userId ? lockUserEmail(tx, input.userId) : null;
}

/**
 * Intake of a deletion request, in the transaction that creates it.
 *
 * A withdrawal alone is not enough: a preference that is already off writes no
 * row, and an account in the `risk_accepted` cohort has no consent to withdraw,
 * so the cohort override would keep sending. A suppression is a blocker the
 * override cannot pass.
 */
export async function recordPrivacyIntake(
  tx: Prisma.TransactionClient,
  input: {
    requestId: string;
    userId: string | null;
    emailAddress: string;
    policyVersionId: string;
    now: Date;
  }
) {
  const userEmail = await lockPrivacyIntake(tx, { userId: input.userId });
  // The account's address as locked, so the stop lands on the mailbox the
  // withdrawal below also records against and only one address is locked.
  const emailAddress = normalizeSuppressionAddress(userEmail ?? input.emailAddress);
  await lockSuppressionAddress(tx, emailAddress);
  if (input.userId && userEmail) await ensureDefaultPreferences(input.userId, tx);

  await recordSuppression(
    {
      emailAddress,
      scope: "classification",
      purposeKey: "marketing",
      reason: "privacy_request",
      source: "admin",
      sourceEventKey: `privacy:${input.requestId}:intake`,
      sourceRequestId: input.requestId,
      occurredAt: input.now,
    },
    tx
  );

  // While entries still decide, a classification cause is invisible to the send
  // check, which reads only global and purpose entries. The same stop is written
  // per marketing purpose so it holds today; once causes decide these are
  // redundant beside the classification cause and harmless.
  if ((await readSuppressionAuthority(tx)) === "entry") {
    for (const purpose of EMAIL_PURPOSES) {
      if (!recordsConsent(purpose)) continue;
      await recordSuppression(
        {
          emailAddress,
          purposeKey: purpose,
          reason: "privacy_request",
          source: "admin",
          sourceEventKey: `privacy:${input.requestId}:intake:${purpose}`,
          sourceRequestId: input.requestId,
          occurredAt: input.now,
        },
        tx
      );
    }
  }

  // The account's own marketing preferences, switched off under the same locks.
  if (!input.userId || !userEmail) return;
  for (const purpose of EMAIL_PURPOSES) {
    if (!recordsConsent(purpose)) continue;
    await applyPreferenceChange(tx, {
      userId: input.userId,
      purpose,
      enabled: false,
      capturedVia: "admin",
      source: "privacy_request",
      suppressionSource: "admin",
      now: input.now,
      policyVersionId: input.policyVersionId,
      confirmedCountry: null,
    });
  }
}

/**
 * Called on every update of a deletion request, inside its transaction. Decided
 * by the state after the update, not by the transition into it: a completed
 * request whose legal hold is lifted later suppresses then.
 */
export async function recordPrivacyCompletion(
  tx: Prisma.TransactionClient,
  request: {
    id: string;
    email: string;
    requestType: string;
    status: string;
    legalHold: boolean;
  },
  now: Date
) {
  if (request.requestType !== "deletion") return false;
  if (request.status !== "completed" || request.legalHold) return false;
  await recordSuppression(
    {
      emailAddress: request.email,
      reason: "privacy_request",
      source: "admin",
      sourceEventKey: `privacy:${request.id}:completed`,
      sourceRequestId: request.id,
      occurredAt: now,
    },
    tx
  );
  return true;
}
