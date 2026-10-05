/**
 * The owner's ops-observer genesis (docs/policy/sre-ops.md §8, §9 D5b): start,
 * recover or activate the sre-ops agent's state chain.
 *
 * Owner only (`sre-agent:write`), with a recent sign-in checked on every
 * request -- a stale one answers with the remedy, so the screen can offer the
 * way back. The body names the head and trust verdict the owner looked at; the
 * store refuses (`stale`) when either moved, and writes the genesis, the
 * owner's audit entry and the generation-0 state in one transaction.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { createOpsObserverGenesis } from "@/lib/opsObserverStore";
import { OpsObserverLateError, isBudgetInsufficient } from "@/lib/opsObserverTransaction";
import { GENESIS_MODES, GENESIS_REASONS } from "@/scripts/ops-observer/genesis-core.mjs";
import { TRUST_REASONS } from "@/scripts/ops-observer/trust-check-core.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    reason: z.enum(GENESIS_REASONS as unknown as [string, ...string[]]),
    mode: z.enum(GENESIS_MODES as unknown as [string, ...string[]]),
    expectedGenesisId: z.string().uuid().nullable(),
    expectedGeneration: z.number().int().nonnegative().nullable(),
    expectedMode: z.enum(GENESIS_MODES as unknown as [string, ...string[]]).nullable(),
    trustReason: z.enum(["trusted", ...TRUST_REASONS] as [string, ...string[]]),
  })
  .strict();

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    // A non-administrator is told nothing about what is here.
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "sre-agent:write")) {
      return NextResponse.json(
        { error: "SRE agent write access is required.", code: "SRE_AGENT_WRITE_REQUIRED" },
        { status: 403 },
      );
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id, "admin-sre-ops-genesis", { minute: 5, day: 20 });
    const body = await readLimitedJson(request, 2 * 1024, bodySchema);
    const outcome = await createOpsObserverGenesis({
      session,
      request,
      reason: body.reason as "initial" | "recovery" | "activation",
      mode: body.mode as "shadow" | "live",
      expectedGenesisId: body.expectedGenesisId,
      expectedGeneration: body.expectedGeneration,
      expectedMode: body.expectedMode,
      trustReason: body.trustReason,
    });
    if (outcome.result !== "created") {
      return NextResponse.json({ error: "Refused.", code: outcome.result }, { status: 409 });
    }
    return NextResponse.json({ ok: true, result: outcome });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    if (error instanceof OpsObserverLateError || isBudgetInsufficient(error)) {
      return NextResponse.json({ error: "Refused.", code: "late" }, { status: 409 });
    }
    const e = error as { name?: unknown; code?: unknown };
    console.error(JSON.stringify({
      event: "ops_observer_genesis_failed",
      errorName: typeof e?.name === "string" ? e.name : null,
      errorCode: typeof e?.code === "string" ? e.code : null,
    }));
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
