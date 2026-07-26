export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chatErrorResponse, identifyChatCaller } from "@/lib/chatSecurity";
import {
  generateConversationTitle,
  recordTitleGenerationUsage,
} from "@/lib/conversationTitle";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { ensureGuestVerified } from "@/lib/turnstile";

const requestSchema = z
  .object({
    message: z.string().trim().min(1).max(2_000),
    turnstileToken: z.string().min(1).max(2_048).optional(),
  })
  .strict();

const jsonError = (
  error: string,
  code: string,
  status: number,
  traceId: string
) =>
  Response.json(
    { error, code, traceId },
    { status, headers: { "Cache-Control": "no-store" } }
  );

const safeErrorMessage = (error: unknown) => {
  if (!error || typeof error !== "object" || !("message" in error)) {
    return undefined;
  }
  return typeof error.message === "string" ? error.message : undefined;
};

// Guest counterpart to the authenticated
// app/api/conversations/[conversationId]/generate-title route. Guests never
// persist conversations/messages server-side, so this route is stateless --
// it never writes the prompt, the title, or anything guest-identifying to
// the database. The client applies the returned title to its own
// localStorage-backed conversation state.
export async function POST(request: Request) {
  const traceId = randomUUID();
  try {
    const access = identifyChatCaller(request);
    if (access.kind !== "guest") {
      return jsonError(
        "This endpoint is for guest sessions only.",
        "GUEST_ONLY_ENDPOINT",
        400,
        traceId
      );
    }

    await consumeApiRateLimit(request, access.subjectKey, "guest-conversation-title", {
      minute: 3,
      day: 10,
    });

    const body = await readLimitedJson(request, 8 * 1024, requestSchema);

    const turnstileGrantCookie = await ensureGuestVerified(
      request,
      body.turnstileToken,
      "guest_conversation_title"
    );

    const headers = new Headers({ "Cache-Control": "no-store" });
    if (access.setCookie) headers.append("Set-Cookie", access.setCookie);
    if (turnstileGrantCookie) headers.append("Set-Cookie", turnstileGrantCookie);

    const generation = await generateConversationTitle(body.message);
    if (!generation.ok) {
      return Response.json({ updated: false, reason: generation.reason }, { headers });
    }

    try {
      await recordTitleGenerationUsage(generation);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "guest_conversation_title_usage_record_failed",
          traceId,
          message: safeErrorMessage(error)?.slice(0, 1_000),
        })
      );
    }

    return Response.json(
      { updated: true, title: generation.title },
      { headers }
    );
  } catch (error) {
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;

    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    console.error(
      JSON.stringify({
        event: "guest_conversation_title_failed",
        traceId,
        message: safeErrorMessage(error)?.slice(0, 1_000),
      })
    );
    // A title-generation failure must never surface as a user-facing error --
    // the client keeps its interim title either way.
    return Response.json({ updated: false, reason: "provider_error" });
  }
}
