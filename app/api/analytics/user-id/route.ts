export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
  ensureGa4UserId,
  ga4UserIdServerEnabled,
  withdrawGa4UserId,
} from "@/lib/ga4UserId";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const notFound = () =>
  NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });

/** The browser's statement that the visitor explicitly accepted analytics. */
const statesExplicitConsent = async (req: Request) => {
  try {
    const body = (await req.json()) as { consent?: unknown } | null;
    return body?.consent === "accepted";
  } catch {
    return false;
  }
};

const failure = (error: unknown, action: string) => {
  const securityResponse = apiSecurityResponse(error);
  if (securityResponse) return securityResponse;
  console.error(`Analytics user id ${action} failed.`, {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return NextResponse.json(
    { error: "Analytics user id is unavailable." },
    { status: 500, headers: noStore }
  );
};

/**
 * The signed-in account's GA4 User-ID (docs/policy/marketing-automation.md
 * §10.2), created on the first request. The browser asks only after the
 * visitor explicitly accepted analytics (lib/ga4UserIdPolicy.ts) and says so
 * in the body; this answers only while the notice is published and the switch
 * is on. Anything else is the same 404 and creates nothing, so the response
 * says nothing about which condition failed.
 */
export async function POST(req: Request) {
  try {
    if (!ga4UserIdServerEnabled()) return notFound();
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) return notFound();
    await consumeApiRateLimit(req, userId, "analytics-user-id", {
      minute: 30,
      day: 1_000,
    });
    if (!(await statesExplicitConsent(req))) return notFound();
    const analyticsUserId = await ensureGa4UserId(userId);
    if (!analyticsUserId) return notFound();
    return NextResponse.json({ analyticsUserId }, { headers: noStore });
  } catch (error) {
    return failure(error, "request");
  }
}

/**
 * Withdrawal: the visitor declined analytics while signed in. The stored id
 * is named to GA4 for deletion once and then deleted (lib/ga4UserId.ts).
 * Deliberately not gated on the switch or the notice, which only decide
 * whether an id is created: one created while they were on must still be
 * withdrawable. Only the caller's own id can be touched.
 */
export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) return notFound();
    await consumeApiRateLimit(req, userId, "analytics-user-id-withdrawal", {
      minute: 10,
      day: 200,
    });
    await withdrawGa4UserId(userId);
    return new NextResponse(null, { status: 204, headers: noStore });
  } catch (error) {
    return failure(error, "withdrawal");
  }
}
