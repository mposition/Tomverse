import "server-only";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import type { z } from "zod";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { readMarketingAutomationSettings } from "@/lib/appSettings";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { MarketingStoreRefusedError } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";

/**
 * The one predicate every marketing mutation route passes through.
 *
 * Reading the console takes ordinary admin authentication and nothing else
 * (docs/policy/marketing-automation.md §6.1, 기록 열람). *Changing* marketing
 * state takes `marketing:write` and a recent sign-in, and that is what this
 * enforces -- once, here, rather than once per route, because sixteen copies
 * of a permission check is sixteen chances for one of them to be written
 * differently.
 *
 * It also owns the ordering the policy asks for. The audit entry and the state
 * change commit together (§6, and the foundation's fourth rule): the entry is
 * written first because the store functions *verify* it -- an approval that
 * cannot point at a chain-valid human entry is refused -- and a store refusal
 * rolls the whole transaction back, so a conditional write that matched
 * nothing leaves no audit row behind.
 */

export type MarketingMutationGate = "manual_approval" | "account_control";

export type MarketingMutationRefusal = { code: string; status: number; message: string };

/** What the refusal codes the store raises mean to an HTTP caller. */
const STORE_REFUSAL_STATUS: Record<string, number> = {
  approval_conflict: 409,
  approval_expiry_invalid: 400,
  requeue_conflict: 409,
  requeue_without_failure: 409,
  mark_reusable_conflict: 409,
  legal_hold_conflict: 409,
  cap_override_invalid: 400,
  cap_change_raises_limit: 409,
  cap_change_is_a_no_op: 409,
  manual_channel_has_no_caps: 409,
  resume_reason_invalid: 400,
  resume_autonomous_not_allowed: 409,
  resume_evidence_reused: 409,
  edit_conflict: 409,
  reject_conflict: 409,
  schedule_conflict: 409,
  unpublish_conflict: 409,
  outcome_resolution_conflict: 409,
  channel_conflict: 409,
};

const refusalStatus = (code: string) =>
  STORE_REFUSAL_STATUS[code] ?? (code.startsWith("resume_evidence_") ? 409 : 422);

/**
 * Whether the capability behind this action is switched on.
 *
 * Only the gate §6.1 actually names for these actions. Manual approval needs
 * the draft switch and no kill switch; it is explicitly independent of the LLM
 * budget. Account controls -- pausing, disconnecting, lowering a cap, holding a
 * post -- are gated on *nothing*, because they are how an operator stops
 * things, and a stop that a switch can refuse is not a stop.
 *
 * The full `resolveMarketingAutomationAccess()` composition is not assembled
 * here. It needs publishing, webhook and graduation inputs that later slices
 * own, and half-building it would leave a decision function that answers about
 * capabilities nothing has yet.
 */
async function gateRefusal(gate: MarketingMutationGate): Promise<MarketingMutationRefusal | null> {
  if (gate === "account_control") return null;
  const killSwitch = process.env.MARKETING_AUTOPUBLISH_KILL_SWITCH;
  if (typeof killSwitch === "string" && killSwitch.trim() !== "") {
    return {
      code: "MARKETING_KILL_SWITCH",
      status: 409,
      message: "Marketing automation is stopped by the kill switch.",
    };
  }
  const settings = await readMarketingAutomationSettings();
  if (!settings.draftsEnabled.ok) {
    return {
      code: "MARKETING_SWITCH_UNREADABLE",
      status: 503,
      message: "The marketing draft switch could not be read.",
    };
  }
  if (!settings.draftsEnabled.value) {
    return {
      code: "MARKETING_DRAFTS_DISABLED",
      status: 409,
      message: "The marketing draft switch is off.",
    };
  }
  return null;
}

export type MarketingMutationSpec<TBody, TResult> = {
  request: Request;
  /**
   * The exact audit action, from the plan's inventory. A shortened one is a
   * write the store refuses.
   *
   * A function when the body chooses it -- the switch route writes a different
   * action per switch, and reading the body twice to find out which would be
   * the same input read twice that the store functions are careful to avoid.
   */
  action: string | ((body: TBody) => string);
  targetType: "MarketingPost" | "MarketingChannel" | "AppSetting";
  /** Absent for a create, where the id does not exist until the write. */
  targetId?: string | ((body: TBody) => string);
  summary: string;
  gate: MarketingMutationGate;
  /** Distinguishes the rate-limit bucket; the buckets are per action. */
  bucket: string;
  schema: z.ZodType<TBody>;
  /** Audit metadata. `actorHadMarketingWrite` is added here, not by callers. */
  metadata: (body: TBody) => Record<string, unknown>;
  run: (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    context: { body: TBody; auditLogId: string; session: Session }
  ) => Promise<TResult>;
};

export async function runMarketingAdminMutation<TBody, TResult>(
  spec: MarketingMutationSpec<TBody, TResult>
): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    // A non-administrator is told nothing about what is here.
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "marketing:write")) {
      return NextResponse.json(
        { error: "Marketing write access is required.", code: "MARKETING_WRITE_REQUIRED" },
        { status: 403 }
      );
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(spec.request, session.user.id, spec.bucket, {
      minute: 20,
      day: 200,
    });

    const refusal = await gateRefusal(spec.gate);
    if (refusal) {
      return NextResponse.json(
        { error: refusal.message, code: refusal.code },
        { status: refusal.status }
      );
    }

    const body = await readLimitedJson(spec.request, 16 * 1024, spec.schema);

    const result = await prisma.$transaction(async (tx) => {
      const auditLogId = await writeAdminAuditLog({
        session,
        request: spec.request,
        action: typeof spec.action === "function" ? spec.action(body) : spec.action,
        targetType: spec.targetType,
        targetId:
          typeof spec.targetId === "function" ? spec.targetId(body) : spec.targetId,
        summary: spec.summary,
        metadata: { ...spec.metadata(body), actorHadMarketingWrite: true },
        tx,
      });
      return spec.run(tx, { body, auditLogId, session });
    });

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (error instanceof MarketingStoreRefusedError) {
      // The store's own words, which name the state that refused rather than
      // the action that was attempted.
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: refusalStatus(error.code) }
      );
    }
    console.error(`A marketing mutation failed (${spec.bucket}):`, error);
    return NextResponse.json(
      { error: "The change could not be made." },
      { status: 500 }
    );
  }
}
