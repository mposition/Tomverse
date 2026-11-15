import { z } from "zod";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { readResearchPreviewRunDto } from "@/lib/researchPreviewRunService";
import { ResearchPreviewRunError } from "@/lib/researchPreviewRunStore";

const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(
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
    const parsed = idSchema.safeParse((await params).id);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid Research run.", code: "INVALID_RESEARCH_RUN" },
        { status: 400, headers: noStore }
      );
    }
    const run = await readResearchPreviewRunDto(userId, parsed.data, request);
    return run
      ? Response.json({ run }, { headers: noStore })
      : Response.json(
          { error: "Research run not found.", code: "RESEARCH_RUN_NOT_FOUND" },
          { status: 404, headers: noStore }
        );
  } catch (error) {
    if (error instanceof ResearchPreviewRunError) return Response.json(
      { error: error.message, code: error.code }, { status: error.status, headers: noStore }
    );
    return Response.json({ error: "Research status is unavailable.", code: "RESEARCH_RUN_READ_FAILED" },
      { status: 503, headers: noStore });
  }
}
