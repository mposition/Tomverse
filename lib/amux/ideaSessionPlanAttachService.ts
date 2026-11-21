import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
  AMUX_SESSION_PLAN_ATTACHED_ACTION,
  AMUX_SESSION_PLAN_ATTACHED_TARGET,
} from "@/lib/adminAuditSystemActors";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";
import type { AmuxContentKeyIdentity } from "./ideaKeyStore.ts";
import { commitAmuxSessionAnalysisPlanInTx } from "./ideaSessionAnalysisPlanService.ts";
import { AMUX_SESSION_PLAN_MODEL_ID, amuxSessionPlanAutoRegisterEnabled,
  type AmuxSessionPlanRegistration } from "./ideaSessionPlanCore.ts";
import { inspectAmuxIdeaSessionPlan,
  type AmuxIdeaSessionPlan } from "./ideaSessionSubmissionCore.ts";
import { amuxV19RegistrationFailureLog } from "./ideaSystemRegistrationFailureLogCore.ts";
import { AmuxV19SystemRegistrationError,
  registerAttachedSessionPlanFromSystem } from "./ideaSystemRegistrationService.ts";

export class AmuxSessionPlanAttachError extends Error {
  constructor(readonly code: "plan_rejected" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxSessionPlanAttachError";
  }
}

/** The plan page's own identities: its preview, freeform text and one draft
 * key per unit. Created with the idea's key before the intake transaction. */
export function amuxSessionPlanKeyIdentities(input: { ideaId: string;
  previewId: string; unitIds: readonly string[] }): AmuxContentKeyIdentity[] {
  return [
    { ideaId: input.ideaId, purpose: "transfer_payload", subjectId: input.previewId },
    { ideaId: input.ideaId, purpose: "analysis_freeform",
      subjectId: amuxAnalysisFreeformSubjectId(input.ideaId, input.previewId) },
    ...input.unitIds.map((subjectId) => ({ ideaId: input.ideaId,
      purpose: "analysis_draft" as const, subjectId })),
  ];
}

/**
 * Inside the intake transaction, after the idea and its queue receipt are
 * written: the session-written plan takes the box analysis's place. One
 * content-free system audit records that a session wrote it with no record of
 * files read; it stands in for the result audit the plan writer binds the page
 * to. The idea starts its analysis, and the same plan writer the box result
 * route uses turns the plan into the same source plan, page and proposal rows,
 * leaving the idea `awaiting_owner`. That state takes it out of the box queue
 * (ideaSessionAnalysisQueueWhereCore.ts), so the box never analyses it. A plan
 * that does not close here rolls the whole intake back.
 */
export async function attachAmuxSessionPlanInTx(tx: Prisma.TransactionClient,
  input: { ideaId: string; requestId: string; submissionAuditId: string;
    previewId: string; plan: AmuxIdeaSessionPlan; unitIds: readonly string[];
    keys: AmuxContentKeys }): Promise<{ auditId: string; planId: string;
    unitCount: number }> {
  if (input.unitIds.length !== input.plan.unitCount) {
    throw new AmuxSessionPlanAttachError("integrity_unavailable");
  }
  // The same check the route ran, again here: the writer's own refusal record
  // is bound to a box claim, which a session plan never has, so a plan that
  // does not pass is refused before anything is written.
  let parsed: unknown;
  try { parsed = JSON.parse(input.plan.raw); }
  catch { throw new AmuxSessionPlanAttachError("plan_rejected"); }
  const checked = inspectAmuxIdeaSessionPlan(parsed, input.previewId);
  if (!checked.ok || checked.plan.raw !== input.plan.raw ||
      checked.plan.unitCount !== input.plan.unitCount) {
    throw new AmuxSessionPlanAttachError("plan_rejected");
  }
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
    action: AMUX_SESSION_PLAN_ATTACHED_ACTION,
    targetType: AMUX_SESSION_PLAN_ATTACHED_TARGET,
    targetId: input.ideaId,
    summary: "Attached one session-written plan in place of the box analysis; no record of files read.",
    metadata: { policyVersion: 19, requestId: input.requestId, ideaId: input.ideaId,
      submissionAuditId: input.submissionAuditId, previewId: input.previewId,
      planAuthor: "session", readEvidence: "none",
      modelId: AMUX_SESSION_PLAN_MODEL_ID, unitCount: input.plan.unitCount },
  });
  const started = await tx.amuxIdeaSubmission.updateMany({
    where: { id: input.ideaId, state: "submitted", submissionOrigin: "session",
      cancelledAt: null, analysisCompletedAt: null, currentSourcePlanRevisionId: null },
    data: { state: "analyzing" },
  });
  if (started.count !== 1) throw new AmuxSessionPlanAttachError("integrity_unavailable");
  const planned = await commitAmuxSessionAnalysisPlanInTx(tx, { ideaId: input.ideaId,
    claimId: input.previewId, resultAuditId: auditId,
    modelId: AMUX_SESSION_PLAN_MODEL_ID, rawModelOutput: input.plan.raw,
    keys: input.keys, unitIds: input.unitIds });
  if (planned.state !== "plan_ready") throw new AmuxSessionPlanAttachError("plan_rejected");
  return { auditId, planId: planned.planId, unitCount: planned.unitCount };
}

/**
 * After the intake committed: with the default-off switch, the attached plan
 * goes straight to the system registration Guard the box plans use; without
 * it, it waits for the owner's one plan approval in the Admin idea. The
 * outcome never changes the committed intake, and nothing here retries.
 */
export async function registerAttachedAmuxSessionPlan(ideaId: string,
  env: NodeJS.ProcessEnv = process.env): Promise<AmuxSessionPlanRegistration> {
  if (!amuxSessionPlanAutoRegisterEnabled(env)) return { state: "awaiting_approval" };
  try {
    const registered = await registerAttachedSessionPlanFromSystem(ideaId);
    return registered.state === "committed" ? { state: "registered" }
      : { state: "registration_incomplete", code: registered.state };
  } catch (error) {
    console.error(JSON.stringify(amuxV19RegistrationFailureLog(ideaId, error)));
    return { state: "registration_incomplete",
      code: error instanceof AmuxV19SystemRegistrationError ? error.code : "outcome_unknown" };
  }
}
