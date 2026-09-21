export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { MARKETING_CONSOLE_SECTIONS } from "@/lib/marketingConsoleSections";
import { readMarketingConsole } from "@/lib/marketingConsoleRead";

/**
 * Everything the Marketing console reads, and nothing it writes.
 *
 * Authorisation is ordinary admin authentication and nothing else
 * (docs/policy/marketing-automation.md §6.1, 기록 열람: 관리자 인증, 스위치 무관).
 * Reading the queue is how an operator finds out why nothing published, so a
 * feature switch being off changes what this returns, never whether it
 * answers, and recent-authentication step-up belongs to the mutations S2b1
 * adds. A reader refused because their sign-in aged out cannot tell a stopped
 * pipeline from a broken console.
 *
 * The page server-renders the same payload through the same loader; this route
 * is what the refresh control calls.
 */

const querySchema = z
  .object({
    section: z.enum(MARKETING_CONSOLE_SECTIONS),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-marketing-read", {
      minute: 60,
      day: 600,
    });

    const parsed = querySchema.safeParse({
      section: new URL(req.url).searchParams.get("section") ?? "queue",
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Unknown section." }, { status: 400 });
    }

    return NextResponse.json(await readMarketingConsole(parsed.data.section));
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load the marketing console:", error);
    return NextResponse.json(
      { error: "Failed to load marketing data." },
      { status: 500 }
    );
  }
}
