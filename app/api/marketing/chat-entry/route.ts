export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { chatSurfaceAvailable } from "@/lib/autoProductBoundary";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * Read the same account offer that admits a blank Chat workspace. Opening a
 * marketing page creates no conversation, guest authority or paid attempt.
 * Reasons and rollout configuration remain private to the server.
 */
export async function GET() {
  let offered = false;
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (userId) offered = chatSurfaceAvailable(await autoAvailabilityFor(userId)) === true;
  } catch (error) {
    console.error(JSON.stringify({
      event: "marketing_chat_entry_unavailable",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  }
  return NextResponse.json({ offered }, { headers: PRIVATE_HEADERS });
}
