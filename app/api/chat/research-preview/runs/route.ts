import { z } from "zod";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import {
  createDurableResearchPreviewRun,
  listResearchPreviewRunDtos,
} from "@/lib/researchPreviewRunService";
import { ResearchPreviewRunError } from "@/lib/researchPreviewRunStore";
import { researchPreviewRunCreateSchema } from "@/lib/researchPreviewRunTypes";

const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const listSchema = z
  .object({
    conversationId: idSchema.optional(),
    assistantMessageId: z.string().uuid().optional(),
  })
  .refine(
    (value) => Boolean(value.conversationId) !== Boolean(value.assistantMessageId),
    "Exactly one run lookup scope is required."
  );

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

const errorResponse = (error: unknown) => {
  const security = apiSecurityResponse(error) ?? chatErrorResponse(error);
  if (security) return security;
  if (error instanceof ResearchPreviewRunError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStore }
    );
  }
  const code = error instanceof Error ? error.message.split(":", 1)[0] : "";
  const known: Record<string, [number, string]> = {
    RESEARCH_PREVIEW_DURABLE_DISABLED: [404, "Research Preview durable runs are unavailable."],
    RESEARCH_RUN_ID_REUSED: [409, "The response identity is already in use."],
    RESEARCH_SOURCE_UNAVAILABLE: [409, "The saved Research question is no longer current."],
    RESEARCH_PREVIEW_UNAVAILABLE: [409, "Research Preview is unavailable for this conversation."],
    RESEARCH_SEARCH_UNAVAILABLE: [503, "Research search is temporarily unavailable."],
  };
  const mapped = known[code];
  return Response.json(
    {
      error: mapped?.[1] ?? "The Research run could not be created.",
      code: mapped ? code : "RESEARCH_RUN_CREATE_FAILED",
    },
    { status: mapped?.[0] ?? 500, headers: noStore }
  );
};

export async function GET(request: Request) {
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
    const url = new URL(request.url);
    const query = listSchema.parse({
      conversationId: url.searchParams.get("conversationId") ?? undefined,
      assistantMessageId:
        url.searchParams.get("assistantMessageId") ?? undefined,
    });
    const runs = await listResearchPreviewRunDtos({ userId, ...query });
    return Response.json({ runs }, { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
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
    await consumeApiRateLimit(request, userId, "research-preview-run-create", {
      minute: 30,
      day: 500,
    });
    const payload = await readLimitedJson(
      request,
      16 * 1024,
      researchPreviewRunCreateSchema
    );
    const result = await createDurableResearchPreviewRun({
      request,
      userId,
      payload,
    });
    return Response.json(
      { run: result.run },
      { status: result.created ? 201 : 200, headers: noStore }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
