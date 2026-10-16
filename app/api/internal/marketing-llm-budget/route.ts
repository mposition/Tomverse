export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { MARKETING_LLM_MONTHLY_CAP_ENV } from "@/lib/marketingLlmBudgetCore";
import { handleMarketingLlmBudgetRequest } from "@/lib/marketingLlmBudgetRequest";
import { prisma } from "@/lib/prisma";

// The generator's LLM budget (S3 plan, S3c3a; docs/policy/marketing-automation.md §5).
//
// The generator reserves before it calls its model, asks for one dispatch
// receipt, calls the provider once, and reports what happened. The app counts
// every dispatched call at its reservation. In this build no model is pinned,
// so every reservation is refused as `model_not_pinned` and nothing can spend.

export async function POST(request: Request) {
  const killSwitch = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  const response = await handleMarketingLlmBudgetRequest(request, {
    prisma,
    env: process.env,
    budget: {
      killSwitchOn: typeof killSwitch === "string" && killSwitch.trim().length > 0,
      monthlyCapRaw: process.env[MARKETING_LLM_MONTHLY_CAP_ENV],
    },
  });
  return NextResponse.json(response.body, { status: response.status, headers: { "cache-control": "no-store" } });
}
