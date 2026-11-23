import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { PROJECT_LIMITS } from "@/lib/projectWorkspaceCore";
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

/**
 * A Native bearer call while the project workspace switch is off reaches the
 * project routes only through the folder-era history calls, so it may set the
 * name and nothing else: description, instructions, context, memory scope,
 * automatic memory and archive are workspace settings behind that switch.
 */
export function nativeFolderOnly(req: Request): boolean {
    return req.headers.has("authorization") && process.env.TOMVERSE_NATIVE_PROJECT_WORKSPACE_ENABLED !== "true";
}

export const folderOnlyProjectSchema = z.object({ name: z.string().trim().min(1).max(PROJECT_LIMITS.maxNameLength) }).strict();

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
