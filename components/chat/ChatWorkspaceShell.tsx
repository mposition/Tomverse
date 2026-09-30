import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { chatSurfaceAvailable } from "@/lib/autoProductBoundary";
import { decideChatWorkspaceEntry } from "@/lib/chatWorkspaceEntry";
import { CONVERSATION_HANDOFF_PARAM, conversationHandoffHref } from "@/lib/continuationRoutes";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import { LEGACY_REVIEW_PATH } from "@/lib/productSurfaceRoutes";
import { prisma } from "@/lib/prisma";
import { ReviewWorkspaceShell } from "@/components/chat/ReviewWorkspaceShell";

/** Gated new entry; owned existing Chat is readable independently of rollout. */
export async function ChatWorkspaceShell({ searchParams }: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const requested = searchParams[CONVERSATION_HANDOFF_PARAM];
  const conversationId = typeof requested === "string" && requested ? requested : null;

  // Browser-only mocked journeys use the same loopback + two-flag fixture
  // boundary as the application layout. Never consulted on a real deployment.
  if (isE2EFixtureMode()) {
    const jar = await cookies();
    if (jar.get("__tomverse_e2e_auth")?.value === "1" &&
        jar.get("__tomverse_e2e_chat_workspace")?.value === "1") {
      return <ReviewWorkspaceShell mountedSurface="chat" initialConversationId={conversationId} />;
    }
  }

  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) notFound();
  const owned = conversationId
    ? await prisma.conversation.findFirst({
        where: { id: conversationId, userId },
        select: { productKey: true, continuationBridge: { select: { id: true } } },
      })
    : null;
  const offered = conversationId ? false : await autoAvailabilityFor(userId)
    .then(chatSurfaceAvailable).catch(() => false);
  const decision = decideChatWorkspaceEntry({
    authenticated: true,
    requestedConversation: Boolean(conversationId),
    ownedConversation: owned ? {
      productKey: owned.productKey,
      hasContinuationBridge: owned.continuationBridge !== null,
    } : null,
    offered,
  });
  if (decision.action === "not_found") notFound();
  if (decision.action === "redirect" && conversationId) {
    const destination = new URL(conversationHandoffHref(decision.surface, conversationId, LEGACY_REVIEW_PATH), "https://local.invalid");
    for (const [key, values] of Object.entries(searchParams)) {
      if (key === CONVERSATION_HANDOFF_PARAM || values === undefined) continue;
      for (const value of Array.isArray(values) ? values : [values]) destination.searchParams.append(key, value);
    }
    redirect(`${destination.pathname}${destination.search}`);
  }
  return <ReviewWorkspaceShell mountedSurface="chat" initialConversationId={conversationId} />;
}
