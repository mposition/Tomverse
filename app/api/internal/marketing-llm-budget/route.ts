export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { handleMarketingLlmBudgetRequest } from "@/lib/marketingLlmBudgetRequest";
import { prisma } from "@/lib/prisma";

// The generator's LLM budget (S3 plan, S3c3a; docs/policy/marketing-automation.md §5).
//
// The generator reserves before it calls its model, asks for one dispatch
// receipt, calls the provider once, and reports what happened. The app counts
// an open or unknown call at its reservation and a settled one at its reported
// cost, against the model and monthly cap
// the operator set in the Admin Console (read inside the reservation). With no
// pinned model selected every reservation is refused and nothing can spend.

export async function POST(request: Request) {
  const killSwitch = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  const response = await handleMarketingLlmBudgetRequest(request, {
    prisma,
    env: process.env,
    budget: {
      killSwitchOn: typeof killSwitch === "string" && killSwitch.trim().length > 0,
    },
  });
  return NextResponse.json(response.body, { status: response.status, headers: { "cache-control": "no-store" } });
}
