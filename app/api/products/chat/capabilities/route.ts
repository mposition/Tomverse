export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { autoSelectionCapability } from "@/lib/autoRoutingUi";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * Read the server-owned Auto capability for a not-yet-created Tomverse Chat.
 *
 * This is deliberately read-only. Merely opening the workspace must not
 * consume conversation capacity or leave an empty row behind. The product is
 * this route's constant and the response exposes only the same boolean that a
 * confirmed Chat conversation detail exposes; rollout reasons stay server
 * side.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const availability = await autoAvailabilityFor(session.user.id);
    return NextResponse.json(
      { autoSelection: autoSelectionCapability(availability) },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "chat_draft_auto_capability_unavailable",
      errorName: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }));
    return NextResponse.json(
      { autoSelection: { offered: false } },
      { headers: NO_STORE_HEADERS }
    );
  }
}
