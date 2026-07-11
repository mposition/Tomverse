export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const waitlistSchema = z
  .object({
    plan: z.enum(["Pro", "Max"]),
    email: z.string().email().max(254).optional(),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const subject = session?.user?.id || "guest";
    await consumeApiRateLimit(req, subject, "waitlist-submit", {
      minute: 5,
      day: 20,
    });
    const body = await readLimitedJson(req, 4 * 1024, waitlistSchema);
    console.warn(
      JSON.stringify({
        event: "billing_waitlist",
        userId: session?.user?.id || null,
        email: session?.user?.email || body.email || null,
        plan: body.plan,
      })
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Waitlist submit failed:", error);
    return NextResponse.json({ error: "Failed to join waitlist." }, { status: 500 });
  }
}
