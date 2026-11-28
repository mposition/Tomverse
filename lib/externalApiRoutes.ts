import "server-only";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import { externalApiAccountAccess } from "@/lib/externalApiAccess";
import { externalApiEnabled, externalApiUserAllowed } from "@/lib/externalApiCatalogCore";
import { authenticateExternalApiCaller, type ExternalApiCaller } from "@/lib/externalApiCaller";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { externalApiErrorResponse, externalApiRefusal, positiveInteger } from "@/lib/externalApiInference";

/**
 * Shared front door for the /api/v1 Bearer routes and the cookie-managed
 * /api/user/api-keys routes. The two never share a credential: a Bearer route
 * reads no cookie, and a management route refuses any Authorization header
 * rather than falling back to the cookie behind it.
 */

export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export const externalApiBaseUrl = (request: Request) => {
    const configured = process.env.EXTERNAL_API_PUBLIC_BASE_URL?.trim();
    if (configured) return configured.replace(/\/+$/, "");
    const url = new URL(request.url);
    const host = request.headers.get("host")?.split(",")[0]?.trim() || url.host;
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const protocol = forwarded === "http" || forwarded === "https" ? forwarded : url.protocol.replace(":", "");
    return `${protocol}://${host}/api/v1`;
};

/**
 * A key request, or on the coding API's enrolled reads a Desktop session request (lib/externalApiCaller.ts): the same
 * account check and the same read budget either way.
 */
export const withBearerKey = async (
    request: Request,
    handler: (key: ExternalApiCaller) => Promise<Response>
) => {
    if (!externalApiEnabled(process.env)) {
        return externalApiErrorResponse(503, "The Tomverse API is not enabled.", "feature_unavailable");
    }
    try {
        const key = await authenticateExternalApiCaller(request);
        const access = await externalApiAccountAccess(key.userId);
        if (!access.allowed) return externalApiErrorResponse(403, access.message, access.code);
        // Read routes (models, usage) have their own per-account budget,
        // separate from completions, so polling cannot crowd out real calls.
        await consumeApiRateLimit(request, key.userId, "external-api-reads", {
            minute: positiveInteger(process.env.EXTERNAL_API_READS_PER_MINUTE, 60),
            day: positiveInteger(process.env.EXTERNAL_API_READS_PER_DAY, 5_000),
        });
        return await handler(key);
    } catch (error) {
        const refusal = externalApiRefusal(error);
        if (refusal) return refusal;
        console.error(JSON.stringify({ event: "external_api_route_failed", message: String(error) }));
        return externalApiErrorResponse(500, "The request could not be processed.", "internal_error");
    }
};

const json = (status: number, body: unknown) =>
    Response.json(body, { status, headers: NO_STORE_HEADERS });

export type ManagementContext = {
    session: Session;
    userId: string;
    plan: Awaited<ReturnType<typeof getUserBillingPlan>>;
};

export const withKeyManagementSession = async (
    request: Request,
    handler: (context: ManagementContext) => Promise<Response>,
    options?: {
        /** Answers a signed-in account the API is not offered to. */
        whenDisabled?: (context: { userId: string }) => Promise<Response> | Response;
        /** Revocation must work even after the feature is switched off. */
        allowWhenDisabled?: boolean;
    }
) => {
    if (request.headers.has("authorization")) {
        return json(401, { error: "Key management uses your signed-in session, not an API key.", code: "SESSION_REQUIRED" });
    }
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!session || !userId) {
        return json(401, { error: "Sign in to manage API keys.", code: "UNAUTHENTICATED" });
    }
    if (
        !options?.allowWhenDisabled &&
        (!externalApiEnabled(process.env) || !externalApiUserAllowed(process.env, userId))
    ) {
        if (options?.whenDisabled) return options.whenDisabled({ userId });
        return json(403, { error: "The Tomverse API is not enabled for this account.", code: "EXTERNAL_API_NOT_ENABLED" });
    }
    const plan = await getUserBillingPlan(userId);
    return handler({ session, userId, plan });
};

export { json as managementJson };

/**
 * Per-account budget for the settings page's read routes (key list, a key's
 * receipts). Revocation is deliberately not behind it: it must always work.
 */
export const withManagementReadLimit = async (
    request: Request,
    userId: string,
    render: () => Promise<Response>
) => {
    try {
        await consumeApiRateLimit(request, userId, "external-api-key-read", { minute: 60, day: 5_000 });
    } catch (error) {
        const security = apiSecurityResponse(error);
        if (security) return security;
        throw error;
    }
    return render();
};
