export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { createConversationForProduct } from "@/lib/conversationCreateHandler";
import { CHAT_PRODUCT_KEY } from "@/lib/conversationProduct";

/**
 * Create a Tomverse Chat conversation.
 *
 * Product boundary decision record v1.2, §6. The product is this module's
 * constant, for the same reason as the Review endpoint: the endpoint is the
 * server's own statement of which product it creates, and nothing the client
 * sends can change it.
 *
 * ## Why this route can 404
 *
 * Tomverse Chat is not released. The decision record's joining condition is
 * that Auto readiness and the productKey strict transition both complete
 * before Chat is exposed, and §3 adds that during the limited cohort the
 * entry to Chat is bound rather than merely the Auto toggle hidden -- an
 * account outside the cohort would otherwise get a manual Chat with none of
 * the product's promise, which is the same failure as a toggle that flips and
 * changes nothing.
 *
 * So this endpoint fails closed. The gate reuses the existing availability
 * decision (flag plus cohort, `lib/autoRoutingUi.ts`), which is off by
 * default: `TOMVERSE_AUTO_ROUTER_UI_ENABLED` has to be turned on and the
 * account has to be in the cohort. Nothing here turns either on.
 *
 * 404 rather than 403, and with no reason in the body, because the refusal is
 * internal rollout state -- which bucket, what share, which readiness gate --
 * and the UI contract §2 keeps all of it on the server. A client that could
 * read its own bucket could work out the rollout percentage.
 *
 * **This gate is provisional.** Decision record §3 requires one shared product
 * decision used by all three consumers -- surface entry, `offered`, and turn
 * routing -- and when that function lands it replaces the call below. Until
 * then the two agree because they read the same availability.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const availability = await autoAvailabilityFor(session.user.id);
  if (!availability.offered) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return createConversationForProduct(req, CHAT_PRODUCT_KEY);
}
