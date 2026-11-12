import { resolveChatRouteSession } from "@/lib/chatRouteSession";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { mayStoreSelectionMode } from "@/lib/autoRoutingUi";
import { CHAT_INITIAL_SELECTION_MODE_HEADER } from "@/lib/chatWorkspaceEntry";
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
 * Every signed-in account may start a Chat (owner decision 2026-11-12). Auto
 * availability -- flag, cohort, readiness, initial-release authority -- only
 * decides whether this conversation may start in Auto mode; a refusal there
 * leaves the account in an ordinary manual-model Chat instead of closing it.
 */
export async function POST(req: Request) {
  const routeAuth = await resolveChatRouteSession(req);
    if (routeAuth.response) return routeAuth.response;
    const session = routeAuth.session;
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  // Auto is asked about only when the draft wants to start in Auto. Unknown
  // availability starts a manual Chat; it never refuses the conversation.
  const wantsAuto = req.headers.get(CHAT_INITIAL_SELECTION_MODE_HEADER) === "auto";
  const availability = wantsAuto
    ? await autoAvailabilityFor(session.user.id).catch(() => null)
    : null;
  const initialAutoOwnerId = availability && mayStoreSelectionMode("auto", availability)
    ? session.user.id : undefined;
  return createConversationForProduct(req, CHAT_PRODUCT_KEY, initialAutoOwnerId);
}
