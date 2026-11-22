import "server-only";

import { NextResponse } from "next/server";
import { ApiSecurityError, apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { MemoryFeatureDisabledError } from "@/lib/appSettings";
import { AssistantKnowledgeError } from "@/lib/assistantKnowledgeService";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";

/**
 * Shared plumbing for the project workspace routes. Web (session cookie) and
 * Native (bearer) both resolve through `resolveChatRouteSession`, so the two
 * clients never get different ownership answers.
 */

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function projectRouteUser(
    req: Request,
    bucket: string,
    limits: { minute: number; day: number }
): Promise<{ userId: string; response?: undefined } | { userId?: undefined; response: Response }> {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return { response: authentication.response };
    const userId = authentication.session?.user?.id;
    if (!userId) {
        return { response: NextResponse.json({ error: "Authentication required.", code: "UNAUTHORIZED" }, { status: 401, headers: NO_STORE }) };
    }
    await consumeApiRateLimit(req, userId, bucket, limits);
    return { userId };
}

export function projectErrorResponse(error: unknown, fallback: string): Response {
    if (error instanceof AssistantKnowledgeError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
    }
    if (error instanceof MemoryFeatureDisabledError) {
        return NextResponse.json({ error: error.message, code: "MEMORY_FEATURE_DISABLED" }, { status: 403, headers: NO_STORE });
    }
    if (error instanceof ApiSecurityError) {
        const details = (error as ApiSecurityError & { details?: unknown }).details;
        return NextResponse.json(
            { error: error.message, code: error.code, ...(details !== undefined ? { details } : {}) },
            { status: error.status, headers: NO_STORE }
        );
    }
    const security = apiSecurityResponse(error);
    if (security) return security;
    if (error instanceof SyntaxError ||
        (typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "ZodError")) {
        return NextResponse.json({ error: "Invalid request.", code: "INVALID_REQUEST" }, { status: 400, headers: NO_STORE });
    }
    console.error(JSON.stringify({ event: "project_route_failed", route: fallback, errorName: error instanceof Error ? error.name : "UnknownError" }));
    return NextResponse.json({ error: "Project request failed.", code: "PROJECT_REQUEST_FAILED" }, { status: 500, headers: NO_STORE });
}
