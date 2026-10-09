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

export async function GET(request: Request) {
  if (request.method !== "GET") return reply({ code: "CHAT_E04_QA_INVALID_ACTION" }, 405);
  const session = await getServerSession(authOptions);
  if (!chatE04StagingFixtureEligible({ environment: process.env,
    authenticated: Boolean(session?.user?.id), administrator: isAdminSession(session) })) {
    return reply({ code: "CHAT_E04_QA_UNAVAILABLE" }, 404);
  }
  if (!hasValidMutationOrigin(request)) return reply({ code: "INVALID_ORIGIN" }, 403);
  const url = new URL(request.url);
  const query = url.search.slice(1);
  const parameters = [...url.searchParams.entries()];
  if (request.body !== null || new TextEncoder().encode(query).byteLength > 512
    || query.split("&").length !== 1 || parameters.length !== 1 || parameters[0][0] !== "action") {
    return reply({ code: "CHAT_E04_QA_INVALID_ACTION" }, 400);
  }
  const action = parseChatE04AutoAction({ action: parameters[0][1] });
  if (!action) return reply({ code: "CHAT_E04_QA_INVALID_ACTION" }, 400);
  return reply(runChatE04SyntheticAuto(action));
}
