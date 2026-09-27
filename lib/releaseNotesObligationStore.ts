import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { obligationsFor } from "@/lib/releaseNotesObligationCore";

/**
 * Linking a sealed waiver to the duty it waives.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.8.
 *
 * ## Why this exists separately from the seed
 *
 * The seed writes the duty states that are settled without anybody deciding
 * anything -- implemented, with the readiness check that confirms it, or deferred
 * with a date. It cannot write `waived`, because a waiver is a person's act and a
 * seed is not a person.
 *
 * Which left `waived` as a state the verdict reads, the table can hold, and
 * nothing in the build could produce: a review pointed out that an owner could
 * seal a waiver in the ledger and have no way to attach it. This is that way.
 * It is one function rather than a screen because the screen is section 8.7's
 * admin surface and belongs with it; what could not wait is that the state has a
 * writer, and that the writer is the only thing that can produce it.
 *
 * ## What it does not decide
 *
 * Whether the waiver is any good. Sealing, scope and revocation are the ledger's,
 * and the database refuses the write when the approval is unsealed or waives
 * something else -- the same comparison `obligationsVerdict()` makes at send
 * time, one layer earlier. This function passes the caller's ids to it and reports
 * what it said.
 */

export type ObligationWaiverRefusal =
  | "rule_not_found"
  | "unknown_obligation"
  | "approval_not_found"
  | "approval_not_sealed"
  | "approval_scope_mismatch";

export type ObligationWaiverResult =
  | { ok: true; obligationKey: string; countryRuleId: string }
  | { ok: false; refusal: ObligationWaiverRefusal; detail: string };

/**
 * Record that one duty of one country rule is waived by one sealed approval.
 *
 * Idempotent on `(countryRuleId, obligationKey)`: recording the same waiver
 * twice is the same row, and recording a *different* approval for a duty already
 * waived replaces the link, which is what an owner replacing a withdrawn waiver
 * with a new one is doing. Both are visible in the ledger, which is where the
 * history of the decision lives.
 */
export async function recordObligationWaiver(input: {
  countryRuleId: string;
  obligationKey: string;
  approvalId: string;
  /** Why, in the operator's words. Stored on the duty row beside the link. */
  notes: string;
}): Promise<ObligationWaiverResult> {
  const rule = await prisma.releaseNotesCountryRule.findUnique({
    where: { id: input.countryRuleId },
    select: { countryCode: true },
  });
  if (!rule) {
    return {
      ok: false,
      refusal: "rule_not_found",
      detail: `No country rule ${input.countryRuleId}.`,
    };
  }
  // A duty this country does not have is a typo, not a waiver. The declared
  // list is the one the verdict iterates, so a row outside it would be a state
  // nothing ever reads.
  if (!obligationsFor(rule.countryCode).includes(input.obligationKey)) {
    return {
      ok: false,
      refusal: "unknown_obligation",
      detail: `${rule.countryCode} declares no duty ${input.obligationKey}.`,
    };
  }

  const approval = await prisma.emailSendApproval.findUnique({
    where: { id: input.approvalId },
    select: { approvalType: true, sealedAt: true },
  });
  if (!approval || approval.approvalType !== "obligation_waiver") {
    return {
      ok: false,
      refusal: "approval_not_found",
      detail: `No obligation_waiver approval ${input.approvalId}.`,
    };
  }
  if (approval.sealedAt === null) {
    return {
      ok: false,
      refusal: "approval_not_sealed",
      detail: `Approval ${input.approvalId} is not sealed, so it has decided nothing yet.`,
    };
  }

  const data = {
    state: "waived" as const,
    readinessCheck: null,
    dueBy: null,
    warnDaysBefore: null,
    waiverApprovalId: input.approvalId,
    waiverApprovalType: "obligation_waiver" as const,
    notes: input.notes,
  };

  try {
    await prisma.releaseNotesRuleObligation.upsert({
      where: {
        countryRuleId_obligationKey: {
          countryRuleId: input.countryRuleId,
          obligationKey: input.obligationKey,
        },
      },
      create: {
        countryRuleId: input.countryRuleId,
        obligationKey: input.obligationKey,
        ...data,
      },
      update: data,
    });
  } catch (error) {
    // The scope comparison is the trigger's, and it raises `check_violation`.
    // Reported rather than rethrown: an operator attaching the wrong approval
    // has made a mistake this can name, and the two refusals above cover the
    // cases that can be named without asking the database.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError
    ) {
      return {
        ok: false,
        refusal: "approval_scope_mismatch",
        detail:
          `Approval ${input.approvalId} does not waive ${input.obligationKey} of ` +
          `${rule.countryCode}'s rule on this policy version.`,
      };
    }
    throw error;
  }

  return {
    ok: true,
    obligationKey: input.obligationKey,
    countryRuleId: input.countryRuleId,
  };
}
