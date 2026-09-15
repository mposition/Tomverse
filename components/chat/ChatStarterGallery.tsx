"use client";

import type { ReactNode } from "react";
import {
  Code2,
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  Languages,
  Paperclip,
  PenLine,
  Sparkles,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type {
  ChatStarterEntry,
  StarterAccentRole,
} from "@/lib/chatStarterCatalog";
import type {
  StarterLockReason,
  VisibleStarterCard,
} from "@/lib/chatStarterAvailability";
import type { TaskKind } from "@/lib/taskProfileCore";
import type { ModelTier } from "@/lib/models";

/**
 * What a new conversation can be used for, said as outcomes.
 *
 * Contract: docs/ui-contracts/chat-starter-catalog.md.
 *
 * ## What this component is not allowed to do
 *
 * **It does not send.** A click seeds the composer draft and stops. The rule
 * is `docs/ui-contracts/prompt-refiner-suggestion.md` section 1's: a surface
 * that fills the box is offering a starting point, and a surface that sends is
 * spending a credit on the user's behalf on a sentence they have not read.
 *
 * **It does not sit beside the textarea.** The mobile composer contract gives
 * the textarea a dedicated full-width row; this gallery is its own block in
 * normal flow, above the composer, with no absolute positioning, no negative
 * margin and no transform. Nothing here can take horizontal space from the
 * input or float over it.
 *
 * **It does not print conversation titles.** `ChatWelcomeScreen` explains why
 * the mobile treatment counts titles instead of listing them, and this surface
 * is subject to the same reasoning: a card is generic copy, never the user's
 * own content.
 *
 * **It does not quote a price.** The card does not execute anything, so it has
 * nothing to price. A paid requirement is stated as a lock reason and no more.
 *
 * ## Why the icon is derived rather than declared
 *
 * Adding a card is a row in the table plus seven translations plus an evidence
 * path, and nothing else. A per-entry icon field would make it four things,
 * and the fourth is the one somebody forgets. So the icon falls out of the
 * accent role, and then out of the task kind the entry already declares.
 */

type ChatStarterGalleryProps = {
  cards: readonly VisibleStarterCard[];
  /** Fills the composer draft with this card's seed. Never sends. */
  onSeed: (entry: ChatStarterEntry) => void;
  /** Routes a locked card to sign-in or to pricing. Never seeds. */
  onLocked: (reason: StarterLockReason, entry: ChatStarterEntry) => void;
};

const KIND_ICONS: Record<TaskKind, ReactNode> = {
  coding: <Code2 className="h-4 w-4" aria-hidden="true" />,
  documents: <FileText className="h-4 w-4" aria-hidden="true" />,
  research: <Globe className="h-4 w-4" aria-hidden="true" />,
  writing: <PenLine className="h-4 w-4" aria-hidden="true" />,
  multilingual: <Languages className="h-4 w-4" aria-hidden="true" />,
  general: <Sparkles className="h-4 w-4" aria-hidden="true" />,
};

const ROLE_ICONS: Partial<Record<StarterAccentRole, ReactNode>> = {
  image: <ImageIcon className="h-4 w-4" aria-hidden="true" />,
  "web-search": <Globe className="h-4 w-4" aria-hidden="true" />,
  "generated-artifact": (
    <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
  ),
};

/**
 * The icon plate's colours, by role.
 *
 * `neutral` is the product's own blue, not an absence: AGENTS.md reserves the
 * role hues, this slice adds no new role, and the AI Review gradient is
 * reserved even for a card about AI Review.
 */
const ROLE_PLATE: Record<StarterAccentRole, string> = {
  neutral: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  "web-search":
    "bg-accent-web-search-500/10 text-accent-web-search-600 dark:text-accent-web-search-300",
  image: "bg-accent-image-500/10 text-accent-image-600 dark:text-accent-image-300",
  "generated-artifact":
    "bg-accent-generated-artifact-500/10 text-accent-generated-artifact-600 dark:text-accent-generated-artifact-300",
};

const iconFor = (entry: ChatStarterEntry): ReactNode =>
  ROLE_ICONS[entry.accentRole] ?? KIND_ICONS[entry.taskProfile.kind];

export function ChatStarterGallery({
  cards,
  onSeed,
  onLocked,
}: ChatStarterGalleryProps) {
  const { t } = useLanguage();
  // `offered=false` reaches this component as an empty list, and an empty list
  // renders nothing at all -- no heading, no frame, no row height. A gallery
  // that announced itself and then had nothing to show would be the disabled
  // teaser the contract refuses.
  if (cards.length === 0) return null;

  const lockLabel = (
    reason: StarterLockReason,
    minimumPlan?: ModelTier
  ): string =>
    reason === "sign_in_required"
      ? t("chatStarter.lockedSignIn")
      : t("chatStarter.lockedPlan").replaceAll("{plan}", minimumPlan ?? "Pro");

  return (
    <section
      data-testid="chat-starter-gallery"
      aria-labelledby="chat-starter-gallery-title"
      // Its own full-width block in normal flow. The composer's row is above
      // it and is never shared, overlapped or floated over.
      className="mt-5 w-full max-w-xl"
    >
      <h2
        id="chat-starter-gallery-title"
        className="text-left text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500"
      >
        {t("chatStarter.title")}
      </h2>
      <p className="mt-1 text-left text-xs text-zinc-500 dark:text-zinc-400">
        {t("chatStarter.hint")}
      </p>
      <ul className="mt-3 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
        {cards.map(({ entry, availability }) => {
          const locked = availability.state === "locked";
          return (
            <li key={entry.id} className="min-w-0">
              <button
                type="button"
                data-testid="chat-starter-card"
                data-starter-id={entry.id}
                data-starter-state={availability.state}
                onClick={() => {
                  if (availability.state === "locked") {
                    onLocked(availability.reason, entry);
                    return;
                  }
                  onSeed(entry);
                }}
                // min-h-11 is the 44px touch target; the flex column lets the
                // outcome sentence wrap to as many lines as it needs at 320px
                // and at 200% text scaling instead of being truncated.
                className="flex min-h-11 w-full flex-col items-start gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-left shadow-sm transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${ROLE_PLATE[entry.accentRole]}`}
                  >
                    {iconFor(entry)}
                  </span>
                  {/*
                    The requirement is stated here, before the sentence it
                    applies to, and never after a click: the lock is part of
                    the offer (docs/ui-contracts/image-generation-workspace.md).
                  */}
                  {/*
                    The card declared that its question expects a file, so the
                    card says so. Read here rather than acted on: opening a
                    file dialog from a click on a sentence would be a surprise,
                    and the composer already owns the picker.
                  */}
                  {entry.seed.attachment && (
                    <span
                      data-testid="chat-starter-attachment-hint"
                      className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
                    >
                      <Paperclip className="h-3 w-3" aria-hidden="true" />
                      {/*
                        The icon carries the meaning on screen; the name is for
                        the accessibility tree, where a paperclip is nothing.
                      */}
                      <span className="sr-only">{t("chat.attachFile")}</span>
                    </span>
                  )}
                  {locked && availability.state === "locked" && (
                    <span
                      data-testid="chat-starter-lock"
                      className="min-w-0 truncate rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      {lockLabel(availability.reason, availability.minimumPlan)}
                    </span>
                  )}
                </span>
                <span
                  className={`w-full min-w-0 text-[13px] font-medium ${
                    locked
                      ? "text-zinc-500 dark:text-zinc-400"
                      : "text-zinc-700 dark:text-zinc-200"
                  }`}
                >
                  {t(entry.outcomeKey)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
