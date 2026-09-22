import "server-only";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import type { z } from "zod";
import { authOptions } from "@/lib/auth";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { readMarketingAutomationSettings } from "@/lib/appSettings";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import {
  MARKETING_REFUSAL_STATUS,
  MarketingStoreRefusedError,
} from "@/lib/marketingStore";
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

export type MarketingMutationGate =
  /** A person deciding about a draft: the draft switch, and no kill switch. */
  | "manual_approval"
  /** Anything that starts or restarts a publishing surface: no kill switch. */
  | "account_control"
  /**
   * An operator stopping or narrowing something: gated on nothing at all.
   *
   * Pausing, disconnecting, lowering a cap, turning a switch off, and the
   * scope and policy-version changes that send an account back to approval
   * mode. None of them make publishing more possible, so none of them is
   * something the kill switch needs to refuse -- and refusing them under it
   * would leave an operator unable to stop or narrow anything while it is on.
   */
  | "operator_restriction";

export type MarketingMutationRefusal = { code: string; status: number; message: string };

const refusalStatus = (code: string) => MARKETING_REFUSAL_STATUS[code] ?? 422;

/**
 * Whether the capability behind this action is switched on.
 *
 * Three gates, because "an account control" turned out to cover two opposite
 * things. Pausing an account and turning a switch off are an operator stopping
 * something; creating an account, confirming a connection, resuming one and
 * turning a switch on all start or restart a publishing surface, and the kill
 * switch has to reach those.
 *
 * The full `resolveMarketingAutomationAccess()` composition is not assembled
 * here. It needs publishing, webhook and graduation inputs that later slices
 * own, and half-building it would leave a decision function that answers about
 * capabilities nothing has yet. What is shared with it is the environment
 * variable's name, which is why that is imported rather than written out.
 */
async function gateRefusal(
  gate: MarketingMutationGate
): Promise<MarketingMutationRefusal | null> {
  // Stopping and narrowing are never refused: they are how an operator makes
  // something stop, and a stop a switch can refuse is not a stop.
  if (gate === "operator_restriction") return null;

  // The kill switch stops everything but reading the record
  // (docs/policy/marketing-automation.md §6.1), and §8.2 makes it an event that
  // pauses an account -- so a route that resumed one under it would undo the
  // switch's own effect. Read from the constant that names it: this checked a
  // name nothing sets, so the only gate this slice had did nothing at all.
  const killSwitch = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  if (typeof killSwitch === "string" && killSwitch.trim() !== "") {
    return {
      code: "MARKETING_KILL_SWITCH",
      status: 409,
      message: "Marketing automation is stopped by the kill switch.",
    };
  }
  if (gate === "account_control") return null;

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
  gate: MarketingMutationGate | ((body: TBody) => MarketingMutationGate);
  /** Distinguishes the rate-limit bucket; the buckets are per action. */
  bucket: string;
  schema: z.ZodType<TBody>;
  /** Audit metadata. `actorHadMarketingWrite` is added here, not by callers. */
  metadata: (body: TBody) => Record<string, unknown>;
  /**
   * A route's own refusals, for errors the store does not raise.
   *
   * Returning null leaves the error to the generic handler, which is a 500 --
   * so a route that can refuse for its own reasons has to say so here rather
   * than let its refusal read as a fault.
   */
  refusal?: (error: unknown) => MarketingMutationRefusal | null;
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

    const body = await readLimitedJson(spec.request, 16 * 1024, spec.schema);

    const refusal = await gateRefusal(
      typeof spec.gate === "function" ? spec.gate(body) : spec.gate
    );
    if (refusal) {
      return NextResponse.json(
        { error: refusal.message, code: refusal.code },
        { status: refusal.status }
      );
    }

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
    // A sign-in that aged out is 428 with the remedy, not a 500. Without this
    // the console cannot tell a gated control from a broken one, which the
    // Admin IA contract calls a defect and says has been got wrong three times.
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const routeRefusal = spec.refusal?.(error);
    if (routeRefusal) {
      return NextResponse.json(
        { error: routeRefusal.message, code: routeRefusal.code },
        { status: routeRefusal.status }
      );
    }
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
