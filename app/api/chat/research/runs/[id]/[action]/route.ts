import { z } from "zod";
import { consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import {
  amendResearchScope, approveResearchPlan, cancelResearchRun, editResearchPlan, extendResearchBudget, finishResearchNow, pauseResearchRun,
  requestResearchPlan, requestResearchRevision, researchRevisionRequestInputSchema, researchScopeAmendmentSchema, resumeResearchRun,
} from "@/lib/researchEngineService";
import { exportResearchReport, listResearchSources, readResearchEvidence, readResearchReport } from "@/lib/researchEngineReads";
import { researchIdSchema, researchNoStore, researchRouteError, researchRouteUser } from "@/lib/researchEngineRoute";

type Context = { params: Promise<{ id: string; action: string }> };

const emptySchema = z.object({}).strict();
const planRequestSchema = z.object({ expectedPlanRevision: z.number().int().min(0), feedback: z.string().trim().max(4_000).optional() }).strict();
const planEditSchema = z.object({ expectedPlanRevision: z.number().int().min(0), plan: z.unknown() }).strict();
const approveSchema = z.object({ planRevision: z.number().int().min(1) }).strict();
const budgetSchema = z.object({ expectedApprovedCredits: z.number().int().min(0), approvedCredits: z.number().int().min(1).max(100_000) }).strict();

/** Paid or state-changing actions. Each is owner-scoped, revision-checked and idempotent. */
export async function POST(request: Request, { params }: Context) {
  try {
    const user = await researchRouteUser(request);
    if (user.response) return user.response;
    const { id, action } = await params;
    const runId = researchIdSchema.parse(id);
    const base = { request, userId: user.userId, runId };
    await consumeApiRateLimit(request, user.userId, `research-engine-${action.replace(/[^a-z-]/gu, "")}`.slice(0, 60), { minute: 30, day: 1_000 });
    let run;
    switch (action) {
      case "plan": { const body = await readLimitedJson(request, 16 * 1024, planRequestSchema); run = await requestResearchPlan({ ...base, ...body }); break; }
      case "plan-edit": { const body = await readLimitedJson(request, 256 * 1024, planEditSchema); run = await editResearchPlan({ ...base, ...body }); break; }
      case "approve": { const body = await readLimitedJson(request, 4 * 1024, approveSchema); run = await approveResearchPlan({ ...base, ...body }); break; }
      case "pause": await readLimitedJson(request, 1024, emptySchema); run = await pauseResearchRun(base); break;
      case "resume": await readLimitedJson(request, 1024, emptySchema); run = await resumeResearchRun(base); break;
      case "cancel": await readLimitedJson(request, 1024, emptySchema); run = await cancelResearchRun(base); break;
      case "finish": await readLimitedJson(request, 1024, emptySchema); run = await finishResearchNow(base); break;
      case "budget": { const body = await readLimitedJson(request, 4 * 1024, budgetSchema); run = await extendResearchBudget({ ...base, ...body }); break; }
      case "scope": { const amendment = await readLimitedJson(request, 64 * 1024, researchScopeAmendmentSchema); run = await amendResearchScope({ ...base, amendment }); break; }
      case "revisions": { const revision = await readLimitedJson(request, 16 * 1024, researchRevisionRequestInputSchema); run = await requestResearchRevision({ ...base, revision }); break; }
      default: return Response.json({ error: "Unknown Research action.", code: "RESEARCH_ACTION_UNKNOWN" }, { status: 404, headers: researchNoStore });
    }
    return Response.json({ run }, { headers: researchNoStore });
  } catch (error) {
    return researchRouteError(error);
  }
}

/** Owner-only reads: sources, evidence spans, report revisions and exports. */
export async function GET(request: Request, { params }: Context) {
  try {
    const user = await researchRouteUser(request);
    if (user.response) return user.response;
    const { id, action } = await params;
    const runId = researchIdSchema.parse(id);
    const search = new URL(request.url).searchParams;
    const revision = search.get("revision") ? z.coerce.number().int().min(1).parse(search.get("revision")) : undefined;
    switch (action) {
      case "sources": return Response.json(await listResearchSources({ userId: user.userId, runId, request,
        cursor: search.get("cursor") ? researchIdSchema.parse(search.get("cursor")) : undefined,
        limit: search.get("limit") ? z.coerce.number().int().min(1).max(200).parse(search.get("limit")) : undefined,
        visibility: search.get("visibility") ? z.enum(["public", "private"]).parse(search.get("visibility")) : undefined }), { headers: researchNoStore });
      case "evidence": return Response.json(await readResearchEvidence({ userId: user.userId, runId, request,
        chunkId: researchIdSchema.parse(search.get("chunkId")),
        start: search.get("start") ? z.coerce.number().int().min(0).parse(search.get("start")) : undefined,
        end: search.get("end") ? z.coerce.number().int().min(1).parse(search.get("end")) : undefined }), { headers: researchNoStore });
      case "report": return Response.json(await readResearchReport({ userId: user.userId, runId, request, revision }), { headers: researchNoStore });
      case "export": {
        await consumeApiRateLimit(request, user.userId, "research-engine-export", { minute: 20, day: 500 });
        const format = z.enum(["md", "pdf", "docx", "csv", "xlsx"]).parse(search.get("format"));
        const file = await exportResearchReport({ userId: user.userId, runId, request, revision, format });
        return new Response(Buffer.from(file.bytes), { headers: { ...researchNoStore, "Content-Type": file.mediaType,
          "Content-Disposition": `attachment; filename="${file.filename}"`, "X-Content-Type-Options": "nosniff" } });
      }
      default: return Response.json({ error: "Unknown Research read.", code: "RESEARCH_ACTION_UNKNOWN" }, { status: 404, headers: researchNoStore });
    }
  } catch (error) {
    return researchRouteError(error);
  }
}
