export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { identifyChatCaller } from "@/lib/chatSecurity";
import { resolveChatConcurrencyPlan } from "@/lib/chatConcurrencyCore";
import { countActiveLeases } from "@/lib/chatRequestLease";

/**
 * Whether the caller could start one more response right now.
 *
 * Read-only: it takes no lease, holds no lock and reserves nothing, so a "yes"
 * here is a hint for the retry button and never an admission -- the real send
 * still goes through acquireChatAccess and can still be refused. Polled by the
 * error card of a CHAT_CONCURRENCY_EXCEEDED / CHAT_IP_CONCURRENCY_EXCEEDED
 * turn so the button enables once a running answer finishes.
 *
 * The IP scope answers yes/no only; how busy a shared network is stays private.
 */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const access = identifyChatCaller(request, session?.user?.id ?? null);
    // A guest without a cookie yet has never held a lease; nothing to count,
    // and no cookie is minted from a status read.
    // One poll per 5s per refused panel; three Review panels stay under this.
    await consumeApiRateLimit(request, access.subjectKey, "chat-concurrency-read", {
      minute: 60,
      day: 3_000,
    });

    const plan = resolveChatConcurrencyPlan(access);
    const subjectActive = await countActiveLeases(prisma, plan.subject);
    const ipActive = plan.ip ? await countActiveLeases(prisma, plan.ip) : 0;
    const available =
      subjectActive < plan.subject.limit &&
      (!plan.ip || ipActive < plan.ip.limit);

    return NextResponse.json(
      {
        available,
        activeRequests: subjectActive,
        concurrentLimit: plan.subject.limit,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to read chat concurrency:", error);
    return NextResponse.json(
      { error: "Failed to read chat concurrency." },
      { status: 500 }
    );
  }
}
