import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { consentAddressDigest } from "@/lib/emailConsentToken";
import {
  normalizeSuppressionAddress,
  suppressionCheck,
} from "@/lib/emailSuppression";
import { EMAIL_ADDRESS_NORMALIZATION_VERSION } from "@/lib/emailSuppressionCore";
import type { EmailClassification } from "@/lib/emailTemplateDefinitions";
import { releaseNotesSendAuthorization } from "@/lib/releaseNotesSendAuthorization";
import { evidenceOf, recordSendDecision } from "@/lib/releaseNotesSendDecision";
import type { SendVerdict } from "@/lib/releaseNotesSendVerdictCore";

/**
 * The enqueue-phase verdict: the first of section 7.6's two snapshots, and the
 * pin the second one is compared against.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6.
 *
 * ## Why this is its own module
 *
 * Two paths write release-notes deliveries, and they are not the same code.
 * `createStandardDeliveryRows()` writes one row for one person;
 * `expandEmailEvent()` fans a campaign out across an audience with
 * `createManyAndReturn`. Both have to pin the contract, and a second
 * implementation of the pin is a second answer to the question section 7.6
 * exists to have one answer to.
 *
 * The fan-out path was written before this existed and pinned nothing. The
 * consequence was not a missing column: an unpinned row is
 * `display_contract_changed` at send -- a pin that cannot be confirmed is the
 * same refusal as one that no longer matches -- so every fanned-out message
 * would have been skipped on its first drain and replaced, and the whole
 * campaign would have arrived as nothing at all.
 *
 * ## Two halves, because the row does not exist yet
 *
 * `releaseNotesEnqueueDecision()` runs *before* the insert, because the hash it
 * produces is a column of the row. `recordEnqueueDecision()` runs after, inside
 * the writer's transaction, because the snapshot binds to a delivery id. A
 * caller that did only the first would pin without recording what the pin
 * rested on.
 *
 * ## It does not refuse
 *
 * The send does that, with the verdict taken at send time. A row refused here
 * would leave no record of what was true when the message was owed, which is
 * the thing an enqueue snapshot is for.
 */

export type EnqueueDecision = {
  verdict: SendVerdict;
  normalizedAddress: string;
  suppressionCheckedAt: Date;
  /** The contract to pin on the row, or null where none could be composed. */
  displayContractHash: string | null;
};

export async function releaseNotesEnqueueDecision(input: {
  userId: string | null;
  purpose: string;
  classification: EmailClassification;
  emailAddress: string;
  policyVersionId: string;
  templateVersionId: string;
}): Promise<EnqueueDecision> {
  const now = new Date();
  const normalizedAddress = normalizeSuppressionAddress(input.emailAddress);
  // The account's address as it is now, alongside the one this row is addressed
  // to. A member whose account address has moved since an approval was sealed
  // is not the person that approval named (section 5.6).
  const account = input.userId
    ? await prisma.user.findUnique({
        where: { id: input.userId },
        select: { email: true },
      })
    : null;

  // Asked here, unlike at send, because nothing above has asked: neither enqueue
  // path has a suppression gate, and a snapshot reporting `suppressed: false`
  // because nobody looked would be a record of a check that did not happen.
  const suppression = await suppressionCheck({
    emailAddress: input.emailAddress,
    classification: input.classification,
    purpose: input.purpose,
    now,
  });

  const verdict = await releaseNotesSendAuthorization({
    userId: input.userId,
    purpose: input.purpose,
    deliveryAddressDigest: consentAddressDigest(normalizedAddress),
    currentAddressDigest: account?.email
      ? consentAddressDigest(normalizeSuppressionAddress(account.email))
      : null,
    pinnedPolicyVersionId: input.policyVersionId,
    // Nothing to compare against yet: this call is what produces the pin. The
    // pure verdict skips the comparison at this phase for that reason, and
    // passing the value it is about to produce would make every first enqueue
    // report its own contract as unchanged, which says nothing.
    pinnedDisplayContractHash: null,
    templateVersionId: input.templateVersionId,
    suppressed: !suppression.allowed,
    normalizedAddress,
    phase: "enqueue",
    now,
  });

  return {
    verdict,
    normalizedAddress,
    suppressionCheckedAt: now,
    displayContractHash: verdict.displayContract.requiredDisplayContractHash,
  };
}

/** Writes the enqueue snapshot for a row that now exists. */
export async function recordEnqueueDecision(
  tx: Prisma.TransactionClient,
  input: {
    decision: EnqueueDecision;
    deliveryId: string;
    userId: string | null;
    purpose: string;
    classification: EmailClassification;
  }
) {
  return recordSendDecision(tx, {
    deliveryId: input.deliveryId,
    userId: input.userId,
    phase: "enqueue",
    purpose: input.purpose,
    classification: input.classification,
    emailAddress: input.decision.normalizedAddress,
    addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
    verdict: input.decision.verdict,
    countryCandidates: input.decision.verdict.countries,
    suppressionCheckedAt: input.decision.suppressionCheckedAt,
    providerSubmittedAt: null,
    evidence: evidenceOf(input.decision.verdict),
  });
}
