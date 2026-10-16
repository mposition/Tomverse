/**
 * The marketing LLM cost ledger's expiry, as a step of the 15-minute
 * maintenance run (S3 plan, S3c3b; docs/policy/marketing-automation.md §5).
 *
 * Never throws: a failure is reported as an operational incident and the step
 * answers with what it managed, so it cannot turn a successful credit
 * reconciliation into a failed one. While the marketing kill switch is on it
 * does nothing, and resumes when the switch is lifted.
 */

import "server-only";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { expireMarketingLlmCalls, type MarketingLlmExpiryResult } from "@/lib/marketingLlmBudgetStore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";

export type MarketingLlmExpiryStepResult = MarketingLlmExpiryResult | { readonly failed: true };

export async function runMarketingLlmExpiryQuietly(): Promise<MarketingLlmExpiryStepResult> {
  const killSwitch = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  try {
    return await expireMarketingLlmCalls(prisma, {
      killSwitchOn: typeof killSwitch === "string" && killSwitch.trim().length > 0,
    });
  } catch (error) {
    await reportOperationalIncident({
      code: "MARKETING_LLM_EXPIRY_FAILED",
      title: "Marketing LLM cost ledger expiry failed",
      error,
      severity: "error",
      cooldownMs: 60 * 60 * 1_000,
      context: { component: "marketing-llm-expiry" },
    }).catch((reportError: unknown) => {
      console.error("Marketing LLM expiry incident could not be reported:", reportError);
    });
    return { failed: true };
  }
}
