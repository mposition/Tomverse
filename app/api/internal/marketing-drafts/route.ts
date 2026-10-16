export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import {
  MARKETING_DRAFT_INTAKE_MAX_BODY_BYTES,
  marketingDraftProvenanceMatches,
  marketingDraftSubmissionSchema,
} from "@/lib/marketingDraftIntakeCore";
import { intakeMarketingGeneratorDraft } from "@/lib/marketingDraftIntakeStore";
import { runMarketingTransaction } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";

// The generator's draft intake (S3 plan, S3a; docs/policy/marketing-automation.md §4).
//
// The Railway service `Marketing Generator` writes words with an LLM and posts
// them here. It holds this route's secret and an LLM key, and no database,
// publishing, bucket or GitHub credential; everything it sends is judged again
// by the app's Guard, and nothing it sends can say what the verdict is.
//
// In this build every submission is refused by the `draftIntake` decision --
// the generation budget (S3c) and the price-fallback alert (S3d) are not there
// yet -- so the route answers with closed reasons and writes nothing.

/**
 * Only `MARKETING_GENERATOR_SUBMIT_SECRET`, by the publisher route's rule: at
 * least 32 characters, compared as SHA-256 digests in constant time, and no
 * other secret as a fallback.
 */
const generatorSecret = (): string | null => {
  const secret = process.env.MARKETING_GENERATOR_SUBMIT_SECRET;
  return secret && secret.length >= 32 ? secret : null;
};

const authorized = (request: Request, secret: string): boolean => {
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest(),
  );
};

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/** Read chunk by chunk and abandon the stream at the first byte over the limit. */
const readBody = async (request: Request): Promise<Uint8Array | null> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MARKETING_DRAFT_INTAKE_MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MARKETING_DRAFT_INTAKE_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export async function POST(request: Request) {
  const secret = generatorSecret();
  if (!secret || !authorized(request, secret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const raw = await readBody(request);
  if (raw === null) return json({ code: "body_too_large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return json({ code: "invalid_request" }, 400);
  }
  const parsed = marketingDraftSubmissionSchema.safeParse(body);
  if (!parsed.success) return json({ code: "invalid_request" }, 400);
  const submission = parsed.data;
  if (!marketingDraftProvenanceMatches(secret, submission)) {
    return json({ code: "provenance_invalid" }, 401);
  }

  const killSwitchValue = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  const results = [];
  // One transaction per draft, answered in the submitted order: one draft's
  // refusal or conflict does not hold the others, and each is decided against
  // the switches as they are then. The submission is not atomic; the
  // per-draft key and digest make a retry of the whole safe.
  for (const draft of submission.drafts) {
    const outcome = await runMarketingTransaction(
      prisma,
      (tx) =>
        intakeMarketingGeneratorDraft(tx, {
          generatorRunId: submission.generatorRunId,
          submissionId: submission.submissionId,
          provenance: submission.provenance,
          deadlineAt: new Date(submission.deadlineAt),
          draft,
          killSwitchValue,
        }),
      { maxWait: 5_000, timeout: 15_000 },
    );
    results.push({ logicalDraftId: draft.logicalDraftId, ...outcome });
  }
  return json({ results }, 200);
}
