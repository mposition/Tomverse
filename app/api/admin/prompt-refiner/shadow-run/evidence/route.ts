export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  projectPromptRefinerShadowHistoricalDiagnostics,
} from "@/lib/promptRefinerShadowHistoricalDiagnostics";
import {
  promptRefinerShadowRunErrorResponse,
  readPromptRefinerShadowEvidenceBundle,
} from "@/lib/promptRefinerShadowRunStore";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };
const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

/** Historical evidence is independent of a live approval or current source. */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json(
        { error: "Not found." },
        { status: 404, headers: noStoreHeaders }
      );
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json(
        { error: "Forbidden." },
        { status: 403, headers: noStoreHeaders }
      );
    }
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) {
        return NextResponse.json(
          {
            error: "Recent administrator authentication is required.",
            code: "ADMIN_REAUTHENTICATION_REQUIRED",
          },
          { status: 428, headers: noStoreHeaders }
        );
      }
      throw error;
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      "admin-prompt-refiner-shadow-historical-evidence",
      { minute: 10, day: 40 }
    );
    const bundle = await readPromptRefinerShadowEvidenceBundle();
    return NextResponse.json(
      {
        diagnostics: bundle
          ? projectPromptRefinerShadowHistoricalDiagnostics(bundle)
          : null,
      },
      { headers: noStoreHeaders }
    );
  } catch (error) {
    const run = promptRefinerShadowRunErrorResponse(error);
    if (run) return withNoStore(run);
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    console.error("Failed to read Prompt Refiner historical evidence:", error);
    return NextResponse.json(
      { error: "Failed to read Prompt Refiner historical evidence." },
      { status: 500, headers: noStoreHeaders }
    );
  }
}
