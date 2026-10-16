export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import {
  MARKETING_DRAFT_INTAKE_MAX_BODY_BYTES,
  marketingDraftProvenanceMatches,
  marketingDraftSubmissionDigest,
  marketingDraftSubmissionSchema,
} from "@/lib/marketingDraftIntakeCore";
import {
  marketingGeneratorAuthorized,
  marketingGeneratorSecret,
  parseMarketingGeneratorJson,
  readMarketingGeneratorBody,
} from "@/lib/marketingGeneratorAuth";
import { intakeMarketingGeneratorDraft } from "@/lib/marketingDraftIntakeStore";
import { runMarketingTransaction } from "@/lib/marketingStore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";

// The generator's draft intake (S3 plan, S3a; docs/policy/marketing-automation.md §4).
//
// The Railway service `Marketing Generator` writes words with an LLM and posts
// them here. It holds this route's secret and an LLM key, and no database,
// publishing, bucket or GitHub credential; everything it sends is judged again
// by the app's Guard, and nothing it sends can say what the verdict is.
//
// Each submission names the cost-ledger calls that produced it (S3c4), and the
// intake consumes them. In this build every submission is still refused by the
// `draftIntake` decision -- the price-fallback alert (S3d) is not there yet --
// so the route answers with closed reasons and writes nothing.

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  const secret = marketingGeneratorSecret();
  if (!secret || !marketingGeneratorAuthorized(request, secret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const raw = await readMarketingGeneratorBody(request, MARKETING_DRAFT_INTAKE_MAX_BODY_BYTES);
  if (raw === null) return json({ code: "body_too_large" }, 413);
  const parsed = marketingDraftSubmissionSchema.safeParse(parseMarketingGeneratorJson(raw));
  if (!parsed.success) return json({ code: "invalid_request" }, 400);
  const submission = parsed.data;
  if (!marketingDraftProvenanceMatches(secret, submission)) {
    return json({ code: "provenance_invalid" }, 401);
  }

  const killSwitchValue = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  const submissionDigest = marketingDraftSubmissionDigest(submission);
  const results = [];
  // One transaction per draft, answered in the submitted order: one draft's
  // refusal or conflict does not hold the others, and each is decided against
  // the switches as they are then. The submission is not atomic; the
  // per-draft key and digest make a retry of the whole safe.
  for (const draft of submission.drafts) {
    try {
      const outcome = await runMarketingTransaction(
        prisma,
        (tx) =>
          intakeMarketingGeneratorDraft(tx, {
            generatorRunId: submission.generatorRunId,
            submissionId: submission.submissionId,
            provenance: submission.provenance,
            submissionDigest,
            llmCallRequestKeys: submission.llmCallRequestKeys,
            deadlineAt: new Date(submission.deadlineAt),
            draft,
            killSwitchValue,
          }),
        { maxWait: 5_000, timeout: 15_000 },
      );
      results.push({ logicalDraftId: draft.logicalDraftId, ...outcome });
    } catch (error) {
      // This draft's outcome is unknown; the ones before it are answered. The
      // generator resends the whole submission and each key is read back.
      void reportOperationalIncident({
        code: "MARKETING_GENERATOR_ROUTE_FAILED",
        title: "Marketing generator draft could not be recorded",
        error,
        severity: "error",
        cooldownMs: 30 * 60 * 1_000,
        context: { component: "marketing-drafts" },
      }).catch((reportError: unknown) => {
        console.error("Marketing generator incident could not be reported:", reportError);
      });
      return json({ results, code: "outcome_unknown", at: draft.logicalDraftId }, 500);
    }
  }
  return json({ results }, 200);
}
