/**
 * The Admin Console's engineering agent controls (docs/policy/engineering-agent.md
 * §11): a T2 decision, acknowledging a decision item, and the mode and freeze.
 *
 * Each takes `engineering-agent:write` and a recent sign-in, checked here on
 * every request; a stale sign-in answers 428 with the remedy, so the screen
 * can offer the way back. The store writes the change and its audit entry in
 * one transaction.
 */

import "server-only";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import type { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  EngineeringAgentStoreRefusedError,
  runEngineeringAgentTransaction,
  type EngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

export async function runEngineeringAgentAdminMutation<TBody, TResult>(spec: {
  request: Request;
  bucket: string;
  schema: z.ZodType<TBody>;
  run: (tx: EngineeringAgentTransaction, context: { body: TBody; session: Session }) => Promise<TResult>;
  /** AMUX row locks taken before the audit chain, in AMUX's order (§11). */
  beforeAuditLock?: (tx: Prisma.TransactionClient, body: TBody) => Promise<void>;
  /** A read outside the transaction (a GitHub observation), after authentication and the body. */
  beforeTransaction?: (body: TBody) => Promise<void>;
  /**
   * An action that runs inside another writer's transaction instead (an AMUX
   * writer with the action attached, which takes its own locks in AMUX's
   * order). Returns null for a body the engineering transaction handles.
   */
  runInOwnWriter?: (context: { body: TBody; session: Session }) => Promise<TResult> | null;
}): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    // A non-administrator is told nothing about what is here.
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "engineering-agent:write")) {
      return NextResponse.json(
        { error: "Engineering agent write access is required.", code: "ENGINEERING_AGENT_WRITE_REQUIRED" },
        { status: 403 },
      );
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(spec.request, session.user.id, spec.bucket, { minute: 20, day: 200 });
    const body = await readLimitedJson(spec.request, 4 * 1024, spec.schema);
    await spec.beforeTransaction?.(body);
    const inOwnWriter = spec.runInOwnWriter?.({ body, session }) ?? null;
    const result =
      inOwnWriter !== null
        ? await inOwnWriter
        : await runEngineeringAgentTransaction(
            prisma,
            (tx) => spec.run(tx, { body, session }),
            {
              maxWait: 5_000,
              timeout: 20_000,
              beforeAuditLock: spec.beforeAuditLock ? (tx) => spec.beforeAuditLock!(tx, body) : undefined,
            },
          );
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    if (error instanceof EngineeringAgentStoreRefusedError) {
      return NextResponse.json({ error: "Refused.", code: error.code }, { status: 409 });
    }
    console.error(JSON.stringify({ event: "engineering_agent_admin_mutation_failed", bucket: spec.bucket }));
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
