export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextResponse } from "next/server";

import { runBillingFinanceOpsDeadline } from "@/lib/billingFinanceOpsRun";

// The billing-finance-ops stage W trigger's daily call
// (docs/policy/billing-finance-ops.md §1.1). All judgement is in
// lib/billingFinanceOpsRun.ts; this file only answers, with a code and never
// a payload, a model id or a ticket.
export async function POST(request: Request) {
  try {
    const { status, body } = await runBillingFinanceOpsDeadline(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const databaseCode =
      typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
    console.error(
      JSON.stringify({
        event: "billing_finance_ops_run_failed",
        databaseCode: databaseCode && /^[A-Z0-9]{1,10}$/.test(databaseCode) ? databaseCode : null,
      }),
    );
    return NextResponse.json({ result: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
