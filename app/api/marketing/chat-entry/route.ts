export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * Whether a signed-in account gets the blank-Chat entry. Every account does
 * (owner decision 2026-11-12); rollout state no longer closes Chat. Opening a
 * marketing page creates no conversation, guest authority or paid attempt.
 */
export async function GET() {
  let offered = false;
  try {
    const session = await getServerSession(authOptions);
    offered = Boolean(session?.user?.id);
  } catch (error) {
    console.error(JSON.stringify({
      event: "marketing_chat_entry_unavailable",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
  return NextResponse.json({ offered }, { headers: PRIVATE_HEADERS });
}
