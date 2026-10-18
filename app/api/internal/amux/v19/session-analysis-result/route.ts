export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV } from
  "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { AmuxMaxSessionResultError,
  commitAmuxMaxSessionResult, preflightAmuxMaxSessionResult,
  readAmuxMaxSessionResultReceipt } from
  "@/lib/amux/ideaSessionAnalysisResultService";
import { createAmuxContentUnitKeys } from "@/lib/amux/ideaKeyStore";
import { prisma } from "@/lib/prisma";

const WRITE_ENV = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_WRITE";
const READ_ENV = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_READ";
const RETENTION_ENV = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_RETENTION";
const uuid = z.string().uuid();
const identity = z.object({ claimId: uuid, requestId: uuid,
  reservationId: uuid, ideaId: uuid,
  invocationOrdinal: z.number().int().safe().nonnegative(),
  referenceOrdinal: z.number().int().safe().nonnegative(),
  evidenceId: uuid, manifestId: uuid }).strict();
const bodySchema = identity.extend({
  rawModelOutput: z.string().min(1),
  inputTokens: z.number().int().safe().nonnegative(),
  outputTokens: z.number().int().safe().nonnegative(),
}).refine((body) => Buffer.byteLength(body.rawModelOutput, "utf8") <=
    65_536 && body.inputTokens + body.outputTokens > 0 &&
    Number.isSafeInteger(body.inputTokens + body.outputTokens));
const receiptSchema = identity.pick({ claimId: true, requestId: true,
  reservationId: true, ideaId: true, invocationOrdinal: true });

function authorized(request: Request): boolean {
  return isAmuxV19MaxLauncherAuthorized(request,
    process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET);
}

/** The Max launcher submits one result once. Any uncertain POST needs the
 * exact GET receipt and an operator decision; a replay is never authorized. */
export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (process.env[WRITE_ENV] !== "enabled" ||
      process.env[READ_ENV] !== "enabled" ||
      process.env[RETENTION_ENV] !== "enabled" ||
      process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "session_analysis_result_write_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let body: z.infer<typeof bodySchema>;
  // JSON escaping can nearly double a 64 KiB plaintext result.
  try { body = await readLimitedJson(request, 140 * 1024, bodySchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  try {
    await prisma.$transaction((tx) => preflightAmuxMaxSessionResult(tx, body),
      { maxWait: 5_000, timeout: 10_000 });
  } catch {
    return amuxJsonNoStore({ error: "not_ready" }, 409);
  }
  let keys;
  try {
    keys = await createAmuxContentUnitKeys({ ideaId: body.ideaId,
      purpose: "analysis_result", subjectId: body.claimId });
  } catch { return amuxJsonNoStore({ error: "key_outcome_unknown" }, 503); }
  let callbackReturned = false;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const saved = await commitAmuxMaxSessionResult(tx, { ...body, keys });
      callbackReturned = true;
      return saved;
    }, { maxWait: 5_000, timeout: 15_000 });
    return amuxJsonNoStore(result);
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxMaxSessionResultError) {
      return amuxJsonNoStore({ error: error.code }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (process.env[READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "session_analysis_result_read_disabled" }, 409);
  }
  const url = new URL(request.url);
  const names = ["claimId", "requestId", "reservationId", "ideaId",
    "invocationOrdinal"];
  if (url.searchParams.size !== names.length ||
      names.some((name) => url.searchParams.getAll(name).length !== 1)) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const ordinal = url.searchParams.get("invocationOrdinal");
  if (!ordinal || !/^(?:0|[1-9][0-9]*)$/.test(ordinal)) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const parsed = receiptSchema.safeParse({
    claimId: url.searchParams.get("claimId"),
    requestId: url.searchParams.get("requestId"),
    reservationId: url.searchParams.get("reservationId"),
    ideaId: url.searchParams.get("ideaId"),
    invocationOrdinal: Number(ordinal),
  });
  if (!parsed.success) return amuxJsonNoStore({ error: "Invalid request." }, 400);
  try {
    const result = await prisma.$transaction((tx) =>
      readAmuxMaxSessionResultReceipt(tx, parsed.data),
    { maxWait: 5_000, timeout: 10_000 });
    return amuxJsonNoStore(result);
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}
