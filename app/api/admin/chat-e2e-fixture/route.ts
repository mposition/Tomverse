import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { chatE04StagingFixtureEligible, parseChatE04AutoAction } from "@/lib/chatE04StagingFixture";
import { runChatE04SyntheticAuto } from "@/lib/chatE04StagingFixtureAuto";

export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store" },
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!chatE04StagingFixtureEligible({ environment: process.env,
    authenticated: Boolean(session?.user?.id), administrator: isAdminSession(session) })) {
    return reply({ code: "CHAT_E04_QA_UNAVAILABLE" }, 404);
  }
  if (!hasValidMutationOrigin(request)) return reply({ code: "INVALID_ORIGIN" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return reply({ code: "CHAT_E04_QA_INVALID_ACTION" }, 400);
  }
  const reader = request.body?.getReader();
  if (!reader) return reply({ code: "CHAT_E04_QA_INVALID_ACTION" }, 400);
  let bytes = new Uint8Array();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes.length + value.length > 512) {
        await reader.cancel();
        return reply({ code: "CHAT_E04_QA_INVALID_ACTION" }, 400);
      }
      const combined = new Uint8Array(bytes.length + value.length);
      combined.set(bytes); combined.set(value, bytes.length); bytes = combined;
    }
    const action = parseChatE04AutoAction(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!action) return reply({ code: "CHAT_E04_QA_INVALID_ACTION" }, 400);
    return reply(runChatE04SyntheticAuto(action));
  } catch {
    return reply({ code: "CHAT_E04_QA_INVALID_ACTION" }, 400);
  } finally { reader.releaseLock(); }
}
