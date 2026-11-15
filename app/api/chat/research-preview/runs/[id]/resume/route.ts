import { z } from "zod";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { resumeDurableResearchPreviewRun } from "@/lib/researchPreviewRunService";
import { ResearchPreviewRunError } from "@/lib/researchPreviewRunStore";

const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authentication = await resolveChatRouteSession(request);
    if (authentication.response) return authentication.response;
    const userId = authentication.session?.user?.id;
    if (!userId) {
      return Response.json(
        { error: "Authentication required.", code: "AUTHENTICATION_REQUIRED" },
        { status: 401, headers: noStore }
      );
    }
    const id = idSchema.parse((await params).id);
    await consumeApiRateLimit(request, userId, "research-preview-run-resume", {
      minute: 30,
      day: 500,
    });
    const run = await resumeDurableResearchPreviewRun({ request, userId, runId: id });
    return run
      ? Response.json({ run }, { headers: noStore })
      : Response.json(
          { error: "Research run not found.", code: "RESEARCH_RUN_NOT_FOUND" },
          { status: 404, headers: noStore }
        );
  } catch (error) {
    const security = apiSecurityResponse(error) ?? chatErrorResponse(error);
    if (security) return security;
    if (error instanceof ResearchPreviewRunError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: noStore }
      );
    }
    const code = error instanceof Error ? error.message : "";
    const locked = code === "RESEARCH_CONVERSATION_LOCKED";
    return Response.json(
      {
        error: locked
          ? "Unlock this conversation before resuming Research."
          : "This Research run cannot be resumed safely.",
        code: locked ? code : "RESEARCH_RUN_CANNOT_RESUME",
      },
      { status: locked ? 423 : 409, headers: noStore }
    );
  }
}
