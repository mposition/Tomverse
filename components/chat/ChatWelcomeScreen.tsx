"use client";

import type { ReactNode } from "react";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import { displayHeadingClass } from "@/lib/displayHeading";
import { History } from "lucide-react";

type ChatWelcomeScreenProps = {
  /**
   * Recent conversations, counted rather than listed.
   *
   * Only the mobile shell passes these, together with
   * `onOpenRecentConversations`. Three title cards were both the tallest thing
   * on a 320x568 new-chat screen *and* a privacy leak, since a shared or
   * borrowed phone showed real conversation titles before anyone asked for
   * them; one row that only says how many there are keeps the access path
   * without printing the titles.
   *
   * The desktop shell passes nothing: the sidebar beside this screen already
   * lists the same conversations, so a second list in the middle of the screen
   * was the same information twice.
   */
  recentConversations?: readonly { id: string }[];
  onOpenRecentConversations?: () => void;
  recentDisclosureRef?: (node: HTMLButtonElement | null) => void;
  /**
   * The starter catalogue, when this deployment offers one.
   *
   * A node rather than data, because what the gallery shows depends on the
   * viewer's plan, the deployment's flags and this request's capabilities --
   * all of which `ChatPageClient` has already resolved and this screen has no
   * business resolving again.
   *
   * `undefined` renders nothing: no heading, no frame, no row height. That is
   * the whole of the flag-off state (docs/ui-contracts/chat-starter-catalog.md
   * section 2), and it is why this is a slot rather than a boolean.
   */
  starterGallery?: ReactNode;
};

/**
 * The new-chat screen above the composer.
 *
 * The composer is not in here. It sits in the shell's bottom dock in every
 * state, so a new chat and an ongoing one put it in the same place and the
 * first send does not move it (docs/ui-contracts/chat-starter-catalog.md
 * section 6). What is left -- the greeting, the mobile recent-chats row and
 * the starters -- is one group, centred vertically in the space between the
 * header and the dock.
 */
export function ChatWelcomeScreen({
  recentConversations = [],
  onOpenRecentConversations,
  recentDisclosureRef,
  starterGallery,
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
      // `min-h-full` + `grow`, never a fixed height: the group below centres
      // itself with auto margins, which collapse to zero when the content is
      // taller than the space. `justify-content: center` on a box of fixed
      // height would instead overflow in both directions and put the top of
      // the group where no scroll can reach it.
      className="flex min-h-full w-full grow flex-col items-center px-4 text-center sm:px-6"
    >
      <div
        data-testid="chat-welcome-group"
        className="my-auto flex w-full max-w-2xl flex-col items-center py-6"
      >
        <p
          data-testid="chat-welcome-greeting"
          className={`text-balance text-xl font-bold text-zinc-800 dark:text-zinc-100 sm:text-2xl ${displayHeadingClass(lang)}`}
        >
          {welcomeGreeting}
        </p>
        {recentCount > 0 && onOpenRecentConversations && (
          <button
            ref={recentDisclosureRef}
            type="button"
            data-testid="recent-conversations-disclosure"
            data-recent-count={recentCount}
            onClick={() => onOpenRecentConversations()}
            aria-label={disclosureLabel}
            className="mt-2 flex min-h-11 max-w-full items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            <History className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
            <span className="min-w-0 truncate">{disclosureLabel}</span>
          </button>
        )}
        {starterGallery}
      </div>
    </div>
  );
}
