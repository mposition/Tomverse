import "server-only";

import { z } from "zod";
import { apiSecurityResponse } from "@/lib/apiSecurity";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { ResearchPreviewRunError } from "@/lib/deepResearchSettlementHandoff";

export const researchNoStore = { "Cache-Control": "private, no-store, max-age=0" };
export const researchIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export async function researchRouteUser(request: Request) {
  const authentication = await resolveChatRouteSession(request);
  if (authentication.response) return { response: authentication.response };
  const userId = authentication.session?.user?.id;
  if (!userId) {
    return { response: Response.json({ error: "Authentication required.", code: "AUTHENTICATION_REQUIRED" }, { status: 401, headers: researchNoStore }) };
  }
  return { userId };
}

export function researchRouteError(error: unknown) {
  const security = apiSecurityResponse(error) ?? chatErrorResponse(error);
  if (security) return security;
  if (error instanceof ResearchPreviewRunError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: researchNoStore });
  }
  if (error instanceof z.ZodError) {
    return Response.json({ error: "Invalid Research request.", code: "INVALID_RESEARCH_REQUEST" }, { status: 400, headers: researchNoStore });
  }
  console.error(JSON.stringify({ event: "research_engine_route_failed", name: error instanceof Error ? error.name : "unknown" }));
  return Response.json({ error: "Research is temporarily unavailable.", code: "RESEARCH_UNAVAILABLE" }, { status: 503, headers: researchNoStore });
}
