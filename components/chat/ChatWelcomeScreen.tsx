"use client";

import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import { displayHeadingClass } from "@/lib/displayHeading";
import { Bot, History } from "lucide-react";

type ChatWelcomeScreenProps = {
  recentConversations: { id: string; title: string }[];
  onSelectConversation?: (id: string) => void;
  inputSlotRef?: (node: HTMLDivElement | null) => void;
  consentSlotRef?: (node: HTMLDivElement | null) => void;
  /**
   * How recent chats are offered on this shell.
   *
   * "cards" is the desktop treatment: there is room for three titles and the
   * sidebar is already on screen next to them.
   *
   * "disclosure" is the mobile treatment: three title cards were both the
   * tallest thing on a 320x568 new-chat screen *and* a privacy leak, since a
   * shared or borrowed phone showed real conversation titles before anyone
   * asked for them. One row that only says how many there are keeps the
   * access path without printing the titles.
   */
  recentAccess?: "cards" | "disclosure";
  onOpenRecentConversations?: () => void;
  recentDisclosureRef?: (node: HTMLButtonElement | null) => void;
};

export function ChatWelcomeScreen({
  recentConversations,
  onSelectConversation,
  inputSlotRef,
  consentSlotRef,
  recentAccess = "cards",
  onOpenRecentConversations,
  recentDisclosureRef,
}: ChatWelcomeScreenProps) {
  const { data: session } = useSession();
  const { t, lang } = useLanguage();
  const welcomeGreeting = session?.user ? t("chat.welcomeBack") : t("chat.welcome");
  const recentCount = recentConversations.length;
  const disclosureLabel =
    recentCount === 1
      ? t("chat.recentConversationsDisclosureOne")
      : t("chat.recentConversationsDisclosure").replaceAll(
          "{count}",
          String(recentCount)
        );

  return (
    <div
      data-testid="chat-empty-state"
      className="flex h-full flex-col items-center justify-center px-6 text-center"
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-3xl bg-blue-500/10 text-blue-500">
        <Bot className="h-6 w-6" />
      </div>
      <p
        data-testid="chat-welcome-greeting"
        className={`text-xl font-bold text-zinc-800 dark:text-zinc-100 sm:text-2xl ${displayHeadingClass(lang)}`}
      >
        {welcomeGreeting}
      </p>
      <div ref={inputSlotRef} className="mt-5 w-full max-w-xl" />
      <div ref={consentSlotRef} className="w-full max-w-xl empty:mt-0 [&:not(:empty)]:mt-3" />
      {recentCount > 0 &&
        (recentAccess === "disclosure" ? (
          <button
            ref={recentDisclosureRef}
            type="button"
            data-testid="recent-conversations-disclosure"
            data-recent-count={recentCount}
            onClick={() => onOpenRecentConversations?.()}
            aria-label={disclosureLabel}
            className="mt-4 flex min-h-11 w-full max-w-xs items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-[13px] font-semibold text-zinc-600 shadow-sm transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <History className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
            <span className="min-w-0 truncate">{disclosureLabel}</span>
          </button>
        ) : (
          <div className="mt-5 flex w-full max-w-xs flex-col gap-2">
            <p className="text-left text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {t("chat.recentConversationsLabel")}
            </p>
            {recentConversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                data-testid="recent-conversation-card"
                onClick={() => onSelectConversation?.(conversation.id)}
                className="flex items-center gap-2.5 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-left text-sm text-zinc-700 shadow-sm transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{conversation.title}</span>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}
