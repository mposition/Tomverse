import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import { chatSurfaceAvailable } from "@/lib/autoProductBoundary";
import { decideChatWorkspaceEntry } from "@/lib/chatWorkspaceEntry";
import { chatProductUiCopy, localizedProductHref } from "@/lib/chatProductUiCopy";
import { CONVERSATION_HANDOFF_PARAM, conversationHandoffHref } from "@/lib/continuationRoutes";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import { isLanguage, type Language } from "@/lib/language";
import {
  REVIEW_WORKSPACE_PATH,
} from "@/lib/productSurfaceRoutes";
import { prisma } from "@/lib/prisma";
import { ReviewWorkspaceShell } from "@/components/chat/ReviewWorkspaceShell";

const ChatUnavailableNotice = ({ language }: { language: Language }) => {
  const copy = chatProductUiCopy[language];
  return (
    <main
      data-testid="chat-unavailable"
      className="flex min-h-[60vh] items-center justify-center px-4 py-12"
    >
      <section className="w-full max-w-lg rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-sm font-bold text-zinc-500 dark:text-zinc-400">
          {copy.chat.name}
        </p>
        <h1 className="mt-2 text-2xl font-black text-zinc-950 dark:text-white">
          {copy.unavailable}
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
          {copy.review.description}
        </p>
        <a
          data-testid="chat-unavailable-review"
          href={localizedProductHref("review", language)}
          className="mt-5 flex min-h-11 w-full items-center justify-center rounded-xl bg-zinc-950 px-4 py-2 text-sm font-bold text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {copy.review.open}
        </a>
      </section>
    </main>
  );
};

/** Gated new entry; owned existing Chat is readable independently of rollout. */
export async function ChatWorkspaceShell({ searchParams }: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const requested = searchParams[CONVERSATION_HANDOFF_PARAM];
  const conversationId = typeof requested === "string" && requested ? requested : null;
  const language = isLanguage(searchParams.lang) ? searchParams.lang : "en";

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
  if (!userId) {
    const decision = decideChatWorkspaceEntry({
      authenticated: false,
      requestedConversation: Boolean(conversationId),
      ownedConversation: null,
      offered: false,
      guestTrialAvailable: true,
    });
    if (decision.action === "not_found") notFound();
    return (
      <ReviewWorkspaceShell
        mountedSurface="chat"
        initialConversationId={null}
      />
    );
  }
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
    guestTrialAvailable: false,
  });
  if (decision.action === "not_found") {
    if (!conversationId) return <ChatUnavailableNotice language={language} />;
    notFound();
  }
  if (decision.action === "redirect" && conversationId) {
    const destination = new URL(conversationHandoffHref(decision.surface, conversationId, REVIEW_WORKSPACE_PATH), "https://local.invalid");
    for (const [key, values] of Object.entries(searchParams)) {
      if (key === CONVERSATION_HANDOFF_PARAM || values === undefined) continue;
      for (const value of Array.isArray(values) ? values : [values]) destination.searchParams.append(key, value);
    }
    redirect(`${destination.pathname}${destination.search}`);
  }
  return <ReviewWorkspaceShell mountedSurface="chat" initialConversationId={conversationId} />;
}
