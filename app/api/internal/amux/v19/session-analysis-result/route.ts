export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_IDEA_ANALYSIS_PROVIDERS } from "@/lib/amux/ideaAnalysisChannelCore";
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
import { amuxAnalysisFreeformSubjectId } from
  "@/lib/amux/ideaAnalysisDraftSealCore";
import { createAmuxContentKeyRing } from "@/lib/amux/ideaKeyStore";
import { reportAmuxSessionIdeaNeedsOperator } from
  "@/lib/amux/ideaSessionAnalysisAlert";
import { amuxSessionPageKeyIdentities } from
  "@/lib/amux/ideaSessionAnalysisPlanService";
import { amuxV19SystemRegistrationEnabled } from
  "@/lib/amux/ideaSystemRegistrationCore";
import { AmuxV19SystemRegistrationError,
  registerCompletedAmuxIdeaFromSystem } from
  "@/lib/amux/ideaSystemRegistrationService";
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
// How the runner produced the answer (owner decision 2026-10-20): the claim's
// CLI channel, whether that CLI named the answering model ("served") or the
// requested model is the recorded one ("requested"), and the sha256 of the
// exact CLI copy that ran. Recorded with the settlement, never trusted for cost.
const cliAttestation = z.object({
  provider: z.enum(AMUX_IDEA_ANALYSIS_PROVIDERS),
  modelAttestation: z.enum(["served", "requested"]),
  cliSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const bodySchema = identity.extend({
  rawModelOutput: z.string().min(1),
  inputTokens: z.number().int().safe().nonnegative(),
  outputTokens: z.number().int().safe().nonnegative(),
  cliAttestation,
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
  // One key per proposal unit the plan may store; an unusable answer still
  // commits its result and settlement, and its unit keys stay empty.
  let unitCount = 0;
  try {
    const parsed: unknown = JSON.parse(body.rawModelOutput);
    const units = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).units : null;
    if (Array.isArray(units) && units.length <= 40) unitCount = units.length;
  } catch { /* A non-JSON answer is a refused plan, not a failed write. */ }
  const unitIds = Array.from({ length: unitCount }, () => randomUUID());
  // A continuation page opens the previous page; when that page cannot be
  // found the plan writer parks the idea, so a lookup failure is not fatal.
  const previousPage = await amuxSessionPageKeyIdentities(prisma, body.ideaId)
    .catch(() => []);
  let keys;
  try {
    keys = await createAmuxContentKeyRing(
      [{ ideaId: body.ideaId, purpose: "idea_raw", subjectId: body.ideaId },
        ...previousPage],
      [{ ideaId: body.ideaId, purpose: "analysis_result",
        subjectId: body.claimId },
      { ideaId: body.ideaId, purpose: "transfer_payload",
        subjectId: body.claimId },
      { ideaId: body.ideaId, purpose: "analysis_freeform",
        subjectId: amuxAnalysisFreeformSubjectId(body.ideaId, body.claimId) },
      ...unitIds.map((id) => ({ ideaId: body.ideaId,
        purpose: "analysis_draft" as const, subjectId: id }))]);
  } catch { return amuxJsonNoStore({ error: "key_outcome_unknown" }, 503); }
  let callbackReturned = false;
  let result: Awaited<ReturnType<typeof commitAmuxMaxSessionResult>>;
  try {
    result = await prisma.$transaction(async (tx) => {
      const saved = await commitAmuxMaxSessionResult(tx, { ...body, keys,
        unitIds });
      callbackReturned = true;
      return saved;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxMaxSessionResultError) {
      return amuxJsonNoStore({ error: error.code }, 409);
    }
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
  // The next page is claimed by the queue on its own; nothing to register yet.
  const registration = result.plan.state === "plan_continues"
    ? { state: "continues" } : result.plan.state === "plan_ready"
      ? await registerSessionPlan(body.ideaId) : { state: "not_planned" };
  if (registration.state !== "committed" &&
      registration.state !== "continues") {
    await alertOperator(body.ideaId, result.plan.state === "plan_refused"
      ? result.plan.reason : registration.state);
  }
  return amuxJsonNoStore({ ...result, registration });
}

/** v19 item 7: anything short of a registered plan is for the operator; the
 * alert carries the Admin link and a closed reason word only. */
async function alertOperator(ideaId: string, reason: string): Promise<void> {
  try {
    const idea = await prisma.amuxIdeaSubmission.findUnique({
      where: { id: ideaId }, select: { requestId: true } });
    if (idea) await reportAmuxSessionIdeaNeedsOperator({
      requestId: idea.requestId, reason });
  } catch { /* The committed result answer never depends on the alert. */ }
}

/** v19 item 5: the committed plan goes straight to the deterministic
 * registration Guard. It runs after the result commit in its own
 * transactions, so its outcome never changes the result answer; an unknown
 * outcome is read back by idea ID, never resent (v19 item 8). */
async function registerSessionPlan(ideaId: string): Promise<{ state: string }> {
  if (!amuxV19SystemRegistrationEnabled(process.env)) {
    return { state: "write_disabled" };
  }
  try {
    const registered = await registerCompletedAmuxIdeaFromSystem(ideaId);
    return { state: registered.state };
  } catch (error) {
    return { state: error instanceof AmuxV19SystemRegistrationError
      ? error.code : "outcome_unknown" };
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
