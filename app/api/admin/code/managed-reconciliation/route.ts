export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAdminRole } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { ApiSecurityError, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { codeManagedReconciliationSchema } from "@/lib/codeManagedCore";
import { CodeManagedError, reconcileCodeManagedCall } from "@/lib/codeManagedService";
export async function POST(request: Request) {
    const headers = { "Cache-Control": "private, no-store" };
    if (!request.headers.get("origin") || !hasValidMutationOrigin(request))
        return Response.json({ error: "CODE_ORIGIN_FORBIDDEN" }, { status: 403, headers });
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id || getAdminRole(session) !== "owner")
            return Response.json({ error: "Not found." }, { status: 404, headers });
        await assertRecentAdminAuthentication(session);
        if (process.env.CODE_MANAGED_RECONCILIATION_ENABLED !== "true")
            return Response.json({ error: "CODE_RECONCILIATION_DISABLED" }, { status: 503, headers });
        await consumeApiRateLimit(request, session.user.id, "admin-code-reconciliation", { minute: 5, day: 50 });
        const body = await readLimitedJson(request, 8192, codeManagedReconciliationSchema);
        return Response.json(await reconcileCodeManagedCall(session, request, body), { headers });
    }
    catch (error) {
        if (isAdminReauthenticationError(error))
            return Response.json({ error: "CODE_ADMIN_REAUTH_REQUIRED" }, { status: 403, headers });
        if (error instanceof CodeManagedError || error instanceof ApiSecurityError)
            return Response.json({ error: error.code, message: "The Code reconciliation request was rejected." }, { status: error.status, headers });
        return Response.json({ error: "CODE_RECONCILIATION_UNAVAILABLE" }, { status: 503, headers });
    }
}
