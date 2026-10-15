export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { buildPreviewPermitted } from "@/lib/amux/ideaBuildPreviewCore";
import { InitialPlanAccessError, prepareInitialIdeaSourcePlan } from "@/lib/amux/ideaInitialSourcePlanAccess";
import { InitialSourcePlanError } from "@/lib/amux/ideaInitialSourcePlanService";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { IdeaSubmissionError, submitIdea } from "@/lib/amux/ideaSubmissionService";
import { ideaTransferBrowserCookieName, newIdeaTransferBrowserNonce } from "@/lib/amux/ideaTransferBrowserCore";
import { inspectIdeaOnlyTransferPreviewRequest } from "@/lib/amux/ideaTransferPreviewInputCore";
import { IdeaTransferPreviewError, prepareIdeaOnlyTransferPreview } from "@/lib/amux/ideaTransferPreviewService";

// amux-intake.md v18 item 1, the steps before the execution approval: save
// the idea, prepare its idea-only source plan and prepare the exact transfer
// preview, in one request instead of five clicks. Nothing here authorizes a
// transfer or calls a model: every write is the existing non-authorizing one,
// in its own transaction, with every check of its own route. The steps run in
// order and the first one that refuses or whose outcome is unknown stops the
// chain; the answer names that step and the id its own exact read-back takes
// (submission requestId, plan ideaId, preview previewId), and nothing is retried.

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const BODY_MAX_BYTES = 72_000;
const body = z.object({
  version: z.literal(1),
  requestId: z.string(),
  previewId: z.string(),
  input: z.unknown(),
  model: z.object({ provider: z.string(), modelId: z.string(), reasoningEffort: z.string(),
    approvalId: z.string(), approvalVersion: z.number() }).strict(),
}).strict();

async function owner(): Promise<Session | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  if (getAdminRole(session) !== "owner") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  }
  try { await assertRecentAdminAuthentication(session); } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    throw error;
  }
  return session;
}


const stopped = (step: "submission" | "plan" | "preview", status: number,
  detail: Record<string, unknown>) => NextResponse.json({ step, ...detail, retryWrite: false,
  transferAuthorized: false }, { status, headers: noStore });

export async function POST(request: Request) {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    if (!buildPreviewPermitted(process.env)) {
      return NextResponse.json({ error: "build_preview_disabled", transferAuthorized: false },
        { status: 503, headers: noStore });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused", transferAuthorized: false },
        { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user!.id!, "admin-amux-v4-build-preview",
      { minute: 3, day: 20 });
    let raw: unknown;
    try { raw = JSON.parse(await readLimitedText(request, BODY_MAX_BYTES)); }
    catch { return NextResponse.json({ error: "schema_rejected", transferAuthorized: false },
      { status: 400, headers: noStore }); }
    const parsed = body.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "schema_rejected", transferAuthorized: false },
      { status: 400, headers: noStore });
    const { requestId, previewId, input, model } = parsed.data;

    // 1. Save the idea, checked exactly as the submission route checks it.
    const submission = inspectAmuxIdeaSubmission(JSON.stringify({ version: 1, requestId, input }));
    if (!submission.ok) return stopped("submission", submission.code === "too_large" ? 413 : 400,
      { error: submission.code });
    let ideaId: string;
    try {
      ideaId = (await submitIdea({ session, request, inspected: submission })).ideaId;
    } catch (error) {
      if (!(error instanceof IdeaSubmissionError)) throw error;
      return stopped("submission", error.status, { error: error.code, requestId,
        ...(error.readBack ? { readBack: error.readBack } : {}), ...(error.ideaId ? { ideaId: error.ideaId } : {}) });
    }
    // Plans and previews are idea-only; an idea naming sources stops after saving.
    if (submission.counts.repositoryCount + submission.counts.pullRequestCount > 0) {
      return NextResponse.json({ state: "submitted", ideaId, requestId, hasExternalSources: true,
        transferAuthorized: false }, { status: 201, headers: noStore });
    }

    // 2. Prepare its idea-only source plan.
    let revisionId: string;
    try {
      revisionId = (await prepareInitialIdeaSourcePlan(session, request, ideaId)).revisionId;
    } catch (error) {
      if (error instanceof InitialPlanAccessError) {
        return stopped("plan", error.status, { error: error.code, ideaId, requestId,
          ...(error.readBack ? { readBack: error.readBack } : {}) });
      }
      if (error instanceof InitialSourcePlanError) {
        return stopped("plan", error.code === "not_found" ? 404 :
          error.code === "integrity_unavailable" ? 503 : 409, { error: error.code, ideaId, requestId });
      }
      throw error;
    }

    // 3. Prepare the exact transfer preview, bound to this browser.
    const preview = inspectIdeaOnlyTransferPreviewRequest(JSON.stringify({ version: 1, previewId, ideaId,
      provider: model.provider, modelId: model.modelId, reasoningEffort: model.reasoningEffort,
      approvalId: model.approvalId, approvalVersion: model.approvalVersion }));
    if (!preview.ok) return stopped("preview", preview.code === "too_large" ? 413 : 400,
      { error: preview.code, ideaId, requestId });
    const browserNonce = newIdeaTransferBrowserNonce();
    const withCookie = (response: NextResponse) => {
      response.cookies.set(ideaTransferBrowserCookieName(previewId), browserNonce,
        { httpOnly: true, secure: true, sameSite: "strict", path: "/api/admin/amux/ideas", maxAge: 15 * 60 });
      return response;
    };
    try {
      const prepared = await prepareIdeaOnlyTransferPreview(session, request, preview.request, browserNonce);
      return withCookie(NextResponse.json({ state: "prepared", ideaId, requestId, revisionId,
        preview: prepared, transferAuthorized: false }, { status: 201, headers: noStore }));
    } catch (error) {
      if (!(error instanceof IdeaTransferPreviewError)) throw error;
      const status = error.code === "not_found" ? 404 :
        error.code === "not_ready" || error.code === "model_changed" ? 409 : 503;
      const response = stopped("preview", status, { error: error.code, ideaId, requestId, previewId });
      // An unknown preview may have committed: it keeps its browser binding.
      return error.code === "outcome_unknown" ? withCookie(response) : response;
    }
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    console.error("AMUX v4 build preview unavailable");
    return NextResponse.json({ error: "outcome_unknown", retryWrite: false, transferAuthorized: false },
      { status: 503, headers: noStore });
  }
}
