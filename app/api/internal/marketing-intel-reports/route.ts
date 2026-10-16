export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import {
  marketingGeneratorAuthorized,
  marketingGeneratorSecret,
  parseMarketingGeneratorJson,
  readMarketingGeneratorBody,
} from "@/lib/marketingGeneratorAuth";
import {
  MARKETING_INTEL_REPORT_MAX_BODY_BYTES,
  marketingGeneratorReportProvenanceMatches,
  marketingGeneratorReportSchema,
} from "@/lib/marketingIntelReportCore";
import { recordMarketingGeneratorReport } from "@/lib/marketingIntelReportStore";
import { runMarketingTransaction } from "@/lib/marketingStore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";

// The generator's internal reports (S3 plan, S3f; docs/policy/marketing-automation.md §4).
//
// The same secret as the draft intake, and only the two kinds a generator
// writes: a brief, and the market facts A3 found. Every other report kind --
// weekly KPIs, measurements, retention runs, webhook shadows -- is written by
// something else and cannot be written with this secret. A market fact is kept
// only when its source is one of the app's own official hosts for that
// competitor; the rest are counted, not stored.

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  const secret = marketingGeneratorSecret();
  if (!secret || !marketingGeneratorAuthorized(request, secret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const raw = await readMarketingGeneratorBody(request, MARKETING_INTEL_REPORT_MAX_BODY_BYTES);
  if (raw === null) return json({ code: "body_too_large" }, 413);
  const parsed = marketingGeneratorReportSchema.safeParse(parseMarketingGeneratorJson(raw));
  if (!parsed.success) return json({ code: "invalid_request" }, 400);
  if (!marketingGeneratorReportProvenanceMatches(secret, parsed.data)) {
    return json({ code: "provenance_invalid" }, 401);
  }

  try {
    const outcome = await runMarketingTransaction(
      prisma,
      (tx) =>
        recordMarketingGeneratorReport(tx, {
          report: parsed.data,
          killSwitchValue: process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV],
        }),
      { maxWait: 5_000, timeout: 15_000 },
    );
    return json({ result: outcome }, outcome.status === "conflict" ? 409 : 200);
  } catch (error) {
    // Rolled back, or committed with the answer lost: unknown either way, and
    // the same report resent is read back.
    void reportOperationalIncident({
      code: "MARKETING_GENERATOR_ROUTE_FAILED",
      title: "Marketing generator report could not be recorded",
      error,
      severity: "error",
      cooldownMs: 30 * 60 * 1_000,
      context: { component: "marketing-intel-reports" },
    }).catch((reportError: unknown) => {
      console.error("Marketing generator incident could not be reported:", reportError);
    });
    return json({ code: "outcome_unknown" }, 500);
  }
}
