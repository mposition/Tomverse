"use client";

import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import { Bot, Lock } from "lucide-react";

type ChatWelcomeScreenProps = {
  isPrivate: boolean;
  recentConversations: { id: string; title: string }[];
  onSelectConversation?: (id: string) => void;
};

export function ChatWelcomeScreen({
  isPrivate,
  recentConversations,
  onSelectConversation,
}: ChatWelcomeScreenProps) {
  const { data: session } = useSession();
  const { t } = useLanguage();
  const welcomeGreeting = session?.user ? t("chat.welcomeBack") : t("chat.welcome");

  return (
    <div
      data-testid="chat-empty-state"
      className="flex h-full flex-col items-center justify-center px-6 text-center"
    >
      <div
        className={`mb-4 flex h-14 w-14 items-center justify-center rounded-3xl ${
          isPrivate ? "bg-purple-500/10 text-purple-500" : "bg-blue-500/10 text-blue-500"
        }`}
      >
        {isPrivate ? <Lock className="h-6 w-6" /> : <Bot className="h-6 w-6" />}
      </div>
      <p className="text-xl font-bold text-zinc-800 dark:text-zinc-100 sm:text-2xl">
        {isPrivate ? t("chat.privateWelcomeTitle") : welcomeGreeting}
      </p>
      {isPrivate && (
        <p className="mt-2 max-w-xs text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          {t("chat.privateWelcomeSubtitle")}
        </p>
      )}
      {!isPrivate && recentConversations.length > 0 && (
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
      )}
    </div>
  );
}
