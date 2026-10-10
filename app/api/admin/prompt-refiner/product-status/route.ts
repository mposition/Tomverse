export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readPromptRefinerProductStatus } from
  "@/lib/promptRefinerProductStatus";

const headers = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session) ||
        getAdminRole(session) !== "owner") {
      return Response.json({ error: "Not found." }, { status: 404, headers });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-prompt-refiner-product-status", { minute: 30, day: 1_000 });
    return Response.json(await readPromptRefinerProductStatus(), { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return Response.json({ code: "PROMPT_REFINER_PRODUCT_STATUS_UNAVAILABLE" },
      { status: 503, headers });
  }
}
