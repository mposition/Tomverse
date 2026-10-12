export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  GUEST_CHAT_SMART_ADAPTIVE_WRITER_ENV,
} from "@/lib/guestChatSmartAdaptiveRelease";
import {
  activateGuestChatSmartAdaptiveRelease,
  readGuestChatSmartAdaptiveRelease,
} from
  "@/lib/guestChatSmartAdaptiveReleaseStore";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const schema = z.object({
  runtimeCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  runtimeDeploymentId: z.string().uuid(),
  confirmation: z.literal("ACTIVATE_EXACT_GUEST_CHAT_SMART_ADAPTIVE_DEPLOYMENT"),
}).strict();

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return Response.json({ error: "Not found." }, { status: 404, headers });
    }
    if (getAdminRole(session) !== "owner") {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-guest-chat-smart-adaptive-activation-read", { minute: 30, day: 300 });
    const release = await readGuestChatSmartAdaptiveRelease();
    return Response.json({ release }, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return Response.json({ code: "GUEST_CHAT_SMART_ADAPTIVE_READ_UNAVAILABLE" },
      { status: 503, headers });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return Response.json({ error: "Not found." }, { status: 404, headers });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) {
        return Response.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" },
          { status: 428, headers });
      }
      throw error;
    }
    if (process.env[GUEST_CHAT_SMART_ADAPTIVE_WRITER_ENV] !== "1") {
      return Response.json({ code: "GUEST_CHAT_SMART_ADAPTIVE_ACTIVATION_WRITE_DISABLED" },
        { status: 409, headers });
    }
    const body = await readLimitedJson(request, 2 * 1024, schema);
    await consumeApiRateLimit(request, session.user.id,
      "admin-guest-chat-smart-adaptive-activation", { minute: 2, day: 8 });
    const result = await activateGuestChatSmartAdaptiveRelease({ session,
      request, runtimeCommitSha: body.runtimeCommitSha,
      runtimeDeploymentId: body.runtimeDeploymentId });
    return Response.json(result, { status: 201, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    if (error instanceof Error &&
        error.message.startsWith("guest_chat_smart_adaptive_")) {
      return Response.json({ code: "GUEST_CHAT_SMART_ADAPTIVE_ACTIVATION_REFUSED",
        retryAuthorized: false, humanReviewRequired: true },
      { status: 409, headers });
    }
    return Response.json({ code: "GUEST_CHAT_SMART_ADAPTIVE_ACTIVATION_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true },
    { status: 503, headers });
  }
}
