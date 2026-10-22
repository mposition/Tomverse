export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { CODE_MAX_BODY_BYTES, codeManagedRequestSchema } from "@/lib/codeManagedCore";
import { CodeManagedError, handleCodeManaged } from "@/lib/codeManagedService";
export async function POST(request: Request) {
    const headers = { "Cache-Control": "private, no-store" };
    if (request.headers.get("x-tomverse-code") !== "1" || !request.headers.get("origin") || !hasValidMutationOrigin(request))
        return Response.json({ error: "CODE_ORIGIN_FORBIDDEN", message: "A same-origin Code request is required.", dispatchState: "not_dispatched" }, { status: 403, headers });
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id)
            return Response.json({ error: "CODE_SIGN_IN_REQUIRED", message: "Sign in required.", dispatchState: "not_dispatched" }, { status: 401, headers });
        const body = await readLimitedJson(request, CODE_MAX_BODY_BYTES, codeManagedRequestSchema);
        return Response.json(await handleCodeManaged(session.user.id, body), { headers });
    }
    catch (error) {
        if (error instanceof CodeManagedError)
            return Response.json({ error: error.code, message: error.message, dispatchState: error.dispatchState, ...(error.receipt ? { receipt: error.receipt } : {}), ...(error.metadata ?? {}) }, { status: error.status, headers });
        if (error instanceof ApiSecurityError)
            return Response.json({ error: error.code, message: "The Code request payload was rejected.", dispatchState: "not_dispatched" }, { status: error.status, headers });
        // Authentication/validation/DB/provider errors never echo body or secrets.
        return Response.json({ error: "CODE_REQUEST_UNAVAILABLE", message: "The managed Code request is unavailable.", dispatchState: "not_dispatched" }, { status: 503, headers });
    }
}
