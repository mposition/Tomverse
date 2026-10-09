export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { handlePromptRefinerProductPrepare,
  promptRefinerProductApiErrorResponse } from
  "@/lib/promptRefinerProductApi";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return Response.json({ code: "UNAUTHORIZED" },
      { status: 401, headers });
    if (!hasValidMutationOrigin(request)) return Response.json({ code: "FORBIDDEN" },
      { status: 403, headers });
    return await handlePromptRefinerProductPrepare(request, session.user.id);
  } catch (error) {
    return promptRefinerProductApiErrorResponse(error) ??
      Response.json({ outcome: "original_fallback", reason: "audit_unavailable" },
        { status: 503, headers });
  }
}
