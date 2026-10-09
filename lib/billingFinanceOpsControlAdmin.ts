/**
 * The Admin Console's billing-finance-ops writes: the app switch and the
 * monitor confirmation (docs/policy/billing-finance-ops.md §1.2, §1.4).
 *
 * Owner and ops (`ops:write`) and a recent sign-in, checked here on every
 * request. A stale sign-in answers 428 with the remedy so the screen can offer
 * the way back. The store writes the change and its audit entry in one
 * transaction. Same shape as the QA-release control wrapper.
 */

import "server-only";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import type { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { BillingFinanceOpsControlRefusedError } from "@/lib/billingFinanceOpsControlStore";

export async function runBillingFinanceOpsAdminMutation<TBody, TResult>(spec: {
  request: Request;
  bucket: string;
  schema: z.ZodType<TBody>;
  run: (context: { body: TBody; session: Session }) => Promise<TResult>;
}): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    // A non-administrator is told nothing about what is here.
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json(
        { error: "Owner or ops access is required.", code: "BILLING_FINANCE_OPS_CONTROL_WRITE_REQUIRED" },
        { status: 403 },
      );
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(spec.request, session.user.id, spec.bucket, { minute: 10, day: 100 });
    const body = await readLimitedJson(spec.request, 1024, spec.schema);
    const result = await spec.run({ body, session });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    if (error instanceof BillingFinanceOpsControlRefusedError) {
      return NextResponse.json({ error: "Refused.", code: error.code }, { status: 409 });
    }
    console.error(JSON.stringify({ event: "billing_finance_ops_admin_mutation_failed", bucket: spec.bucket }));
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
