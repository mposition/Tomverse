import "server-only";

import type { Prisma } from "@prisma/client";

import type { SendVerdict } from "@/lib/releaseNotesSendVerdictCore";

/**
 * Writing one send verdict down, sealed, in the caller's transaction.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6.
 *
 * ## Two snapshots, one per phase
 *
 * A message is rendered and authorised at enqueue, and authorised again just
 * before it is handed to the provider. Section 7.6 asks for both to be kept,
 * because the interesting question afterwards is not what was decided but what
 * *changed* between the two -- a consent withdrawn, a suppression that arrived,
 * a display contract that moved. One snapshot answers neither.
 *
 * `(deliveryId, phase)` is unique, so each phase is recorded once.
 *
 * ## Sealed, and what that costs
 *
 * The verdict and every row it cites are written together and then sealed;
 * afterwards no evidence may be added, because a verdict that can acquire
 * support after the fact is the same defect as an editable approval.
 *
 * Which means a second attempt at the same phase cannot rewrite the first. That
 * is reported rather than papered over: `recorded: false` with the row that is
 * already there, and it is the caller's business what to do about a send-phase
 * verdict that differs from the one already recorded. The answer that keeps the
 * record honest is to refuse the send -- a message must not go out under a
 * verdict nobody wrote down, and the recorded one is the one an operator will
 * read.
 *
 * ## In the caller's transaction
 *
 * Takes a `Prisma.TransactionClient` and never opens its own. Section 7.6 says
 * the skip and its replacement are one transaction, and a snapshot written
 * outside it would survive a rollback of the thing it describes.
 */

/** A row the verdict rested on, as the join table holds it. */
export type DecisionEvidence = {
  authority: string;
  /** Exactly one of these two. */
  eventId?: string;
  consentRecordId?: string;
};

export type RecordedDecision =
  | { recorded: true; decisionId: string }
  | { recorded: false; decisionId: string; existingAllowed: boolean; differs: boolean };

export async function recordSendDecision(
  tx: Prisma.TransactionClient,
  input: {
    deliveryId: string | null;
    userId: string | null;
    phase: "enqueue" | "send";
    purpose: string;
    classification: string;
    emailAddress: string;
    addressNormalizationVersion: string;
    verdict: SendVerdict;
    /** The candidates as they were persisted, for the record (section 5.3). */
    countryCandidates: unknown;
    suppressionCheckedAt: Date | null;
    providerSubmittedAt: Date | null;
    evidence: readonly DecisionEvidence[];
  }
): Promise<RecordedDecision> {
  if (input.deliveryId !== null) {
    const existing = await tx.emailPermissionDecision.findUnique({
      where: {
        deliveryId_phase: { deliveryId: input.deliveryId, phase: input.phase },
      },
      select: { id: true, allowed: true, blockers: true },
    });
    if (existing) {
      // Compared on the two things a caller acts on. Not the whole row: the
      // evaluation time differs by construction, and reporting that as a
      // difference would make every retry look like a changed verdict.
      const blockers = Array.isArray(existing.blockers) ? existing.blockers : [];
      const differs =
        existing.allowed !== input.verdict.allowed ||
        blockers.join(",") !== [...input.verdict.blockers].sort().join(",");
      return {
        recorded: false,
        decisionId: existing.id,
        existingAllowed: existing.allowed,
        differs,
      };
    }
  }

  const decision = await tx.emailPermissionDecision.create({
    data: {
      deliveryId: input.deliveryId,
      userId: input.userId,
      phase: input.phase,
      purpose: input.purpose,
      classification: input.classification,
      emailAddress: input.emailAddress,
      addressNormalizationVersion: input.addressNormalizationVersion,
      authorities: input.verdict.authorities.map((entry) => ({
        authority: entry.authority,
        country: entry.country,
        basis: entry.basis,
        verdict: entry.verdict,
        reason: entry.reason,
      })),
      legalAllowed: input.verdict.legalAllowed,
      overrideApprovalId: input.verdict.overrideApplied?.approvalId ?? null,
      overrideType: input.verdict.overrideApplied?.type ?? null,
      // Sorted, so two verdicts that refuse for the same reasons compare equal
      // however the reasons were found.
      blockers: [...input.verdict.blockers].sort(),
      allowed: input.verdict.allowed,
      pinnedDisplayContractHash: input.verdict.displayContract.pinnedDisplayContractHash,
      requiredDisplayContractHash: input.verdict.displayContract.requiredDisplayContractHash,
      displayContractSatisfied: input.verdict.displayContract.satisfied,
      countryCandidates: input.countryCandidates as Prisma.InputJsonValue,
      ruleVersions: input.verdict.ruleVersions,
      policyVersionId: input.verdict.policyVersionId,
      suppressionCheckedAt: input.suppressionCheckedAt,
      providerSubmittedAt: input.providerSubmittedAt,
      evaluatedAt: input.verdict.evaluatedAt,
    },
    select: { id: true },
  });

  // Every row the verdict cited, then the seal. Deduplicated on the pair the
  // unique indexes name, because two authorities citing the same consent is one
  // row per authority and the same authority citing it twice is one row.
  const seen = new Set<string>();
  const rows = input.evidence
    .filter((item) => {
      const key = `${item.authority}:${item.eventId ?? ""}:${item.consentRecordId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({
      decisionId: decision.id,
      authority: item.authority,
      eventId: item.eventId ?? null,
      consentRecordId: item.consentRecordId ?? null,
    }));
  if (rows.length > 0) {
    await tx.emailPermissionDecisionEvidence.createMany({ data: rows });
  }

  // Sealed last, in the same transaction: the row and its evidence are one fact,
  // and a seal written before the evidence would close a set that was still
  // being written.
  await tx.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { sealedAt: new Date() },
  });

  return { recorded: true, decisionId: decision.id };
}

/**
 * The evidence a verdict cites, taken from the verdict itself.
 *
 * The authorities carry the `ConsentRecord` ids they rested on, and this is the
 * one place that turns them into rows -- a caller assembling the list by hand
 * would be able to cite something the verdict did not use, which is the shape of
 * a record that proves the wrong thing.
 */
export const evidenceOf = (verdict: SendVerdict): DecisionEvidence[] =>
  verdict.authorities.flatMap((entry) =>
    entry.evidenceIds.map((consentRecordId) => ({
      authority: entry.authority,
      consentRecordId,
    }))
  );
