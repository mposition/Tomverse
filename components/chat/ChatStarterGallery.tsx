"use client";

import { useId, useState, type ReactNode } from "react";
import {
  Code2,
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  Languages,
  Lock,
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
  StarterAvailability,
  StarterLockReason,
  VisibleStarterCard,
} from "@/lib/chatStarterAvailability";
import type { TaskKind } from "@/lib/taskProfileCore";

/** The locked half of a card's verdict, which always names its own reason. */
type StarterLock = Extract<StarterAvailability, { state: "locked" }>;

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
 * **It does not sit beside the textarea.** The composer is in the shell's
 * bottom dock, below this gallery and outside the welcome screen that holds
 * it. Nothing here is absolutely positioned, transformed or given a negative
 * margin, so nothing can take horizontal space from the input or float over
 * it.
 *
 * **It does not print conversation titles.** A card is generic copy, never the
 * user's own content.
 *
 * **It does not quote a price.** The card does not execute anything, so it has
 * nothing to price. A paid requirement is stated as a lock reason and no more.
 *
 * ## One component, two shapes, decided by its own width
 *
 * A wide gallery is a row of wrapping chips; a narrow one is a two-column tile
 * grid, and a very narrow one a single column. The switch is a container query
 * in `rem`, so a larger root font size moves a gallery to the narrower shape
 * exactly as a narrower screen does. It is never decided by which shell
 * rendered it: `ChatPageClient` builds this element once and hands the same
 * node to both shells, and a 768px tablet on the desktop shell is as narrow as
 * a phone.
 *
 * The full outcome sentence sits in a line under the cards, replacing the hint
 * while a card is hovered or focused. It is the card's accessible description
 * in every shape, because on a touch screen nothing is hovered and the label
 * is all the eye gets (section 1).
 *
 * ## Why the icon is derived rather than declared
 *
 * Adding a card is a row in the table plus its translations plus an evidence
 * path, and nothing else. A per-entry icon field would add a step, and that is
 * the one somebody forgets. So the icon falls out of the accent role, and then
 * out of the task kind the entry already declares.
 */

type ChatStarterGalleryProps = {
  cards: readonly VisibleStarterCard[];
  /** Fills the composer draft with this card's seed. Never sends. */
  onSeed: (entry: ChatStarterEntry) => void;
  /** Routes a locked card to sign-in or to pricing. Never seeds. */
  onLocked: (reason: StarterLockReason, entry: ChatStarterEntry) => void;
};

const ICON_CLASS = "h-4 w-4";

const KIND_ICONS: Record<TaskKind, ReactNode> = {
  coding: <Code2 className={ICON_CLASS} aria-hidden="true" />,
  documents: <FileText className={ICON_CLASS} aria-hidden="true" />,
  research: <Globe className={ICON_CLASS} aria-hidden="true" />,
  writing: <PenLine className={ICON_CLASS} aria-hidden="true" />,
  multilingual: <Languages className={ICON_CLASS} aria-hidden="true" />,
  general: <Sparkles className={ICON_CLASS} aria-hidden="true" />,
};

const ROLE_ICONS: Partial<Record<StarterAccentRole, ReactNode>> = {
  image: <ImageIcon className={ICON_CLASS} aria-hidden="true" />,
  "web-search": <Globe className={ICON_CLASS} aria-hidden="true" />,
  "generated-artifact": <FileSpreadsheet className={ICON_CLASS} aria-hidden="true" />,
};

/**
 * The icon's colour, by role.
 *
 * `neutral` is the product's own blue, not an absence: AGENTS.md reserves the
 * role hues, this slice adds no new role, and the AI Review gradient is
 * reserved even for a card about AI Review.
 */
const ROLE_ICON_COLOUR: Record<StarterAccentRole, string> = {
  neutral: "text-blue-600 dark:text-blue-400",
  "web-search": "text-accent-web-search-600 dark:text-accent-web-search-300",
  image: "text-accent-image-600 dark:text-accent-image-300",
  "generated-artifact":
    "text-accent-generated-artifact-600 dark:text-accent-generated-artifact-300",
};

const iconFor = (entry: ChatStarterEntry): ReactNode =>
  ROLE_ICONS[entry.accentRole] ?? KIND_ICONS[entry.taskProfile.kind];

export function ChatStarterGallery({
  cards,
  onSeed,
  onLocked,
}: ChatStarterGalleryProps) {
  const { t } = useLanguage();
  const idPrefix = useId();
  const [previewId, setPreviewId] = useState<string | null>(null);
  // `offered=false` reaches this component as an empty list, and an empty list
  // renders nothing at all -- no heading, no frame, no row height. A gallery
  // that announced itself and then had nothing to show would be the disabled
  // teaser the contract refuses.
  if (cards.length === 0) return null;

  // No fallback tier: `plan_required` carries its own, by construction of
  // `StarterAvailability`. A default here would be a guess about somebody's
  // money, printed on the card as though it were a fact.
  const lockLabel = (lock: StarterLock): string =>
    lock.reason === "sign_in_required"
      ? t("chatStarter.lockedSignIn")
      : t("chatStarter.lockedPlan").replaceAll("{plan}", lock.minimumPlan);
  const lockShortLabel = (lock: StarterLock): string =>
    lock.reason === "sign_in_required"
      ? t("chatStarter.lockedSignInShort")
      : t("chatStarter.lockedPlanShort").replaceAll("{plan}", lock.minimumPlan);

  const titleId = `${idPrefix}-title`;
  const hintId = `${idPrefix}-hint`;
  const previewed = cards.find(({ entry }) => entry.id === previewId);

  return (
    <section
      data-testid="chat-starter-gallery"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      // `@container/starters` is what the cards below measure. `max-w-2xl`
      // keeps a wide screen's chips in rows a reader can scan.
      className="@container/starters mt-5 w-full max-w-2xl"
    >
      {/*
        The heading stays for navigation by heading; on screen the greeting
        above already says what this screen is for.
      */}
      <h2 id={titleId} className="sr-only">
        {t("chatStarter.title")}
      </h2>
      <span id={hintId} className="sr-only">
        {t("chatStarter.hint")}
      </span>
      <ul
        className="m-0 grid list-none grid-cols-2 gap-2 p-0 @max-[18rem]/starters:grid-cols-1 @min-[30rem]/starters:flex @min-[30rem]/starters:flex-wrap @min-[30rem]/starters:justify-center"
        onMouseLeave={() => setPreviewId(null)}
      >
        {cards.map(({ entry, availability }) => {
          const lock = availability.state === "locked" ? availability : null;
          const outcomeId = `${idPrefix}-${entry.id}-outcome`;
          const lockId = `${idPrefix}-${entry.id}-lock`;
          return (
            <li key={entry.id} className="flex min-w-0 max-w-full">
              <button
                type="button"
                data-testid="chat-starter-card"
                data-starter-id={entry.id}
                data-starter-state={availability.state}
                aria-describedby={lock ? `${lockId} ${outcomeId}` : outcomeId}
                onClick={() => {
                  if (lock) {
                    onLocked(lock.reason, entry);
                    return;
                  }
                  onSeed(entry);
                }}
                onMouseEnter={() => setPreviewId(entry.id)}
                onFocus={() => setPreviewId(entry.id)}
                onBlur={() =>
                  setPreviewId((current) => (current === entry.id ? null : current))
                }
                // min-h-11 is the 44px touch target. Nothing here truncates or
                // refuses to wrap: a label breaks onto as many lines as 320px
                // and 200% text need, in a tile and in a chip alike.
                className="flex min-h-11 w-full min-w-0 items-start gap-2 rounded-2xl border border-zinc-200 bg-white px-3 py-2.5 text-left text-sm font-medium text-zinc-800 transition hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 @min-[30rem]/starters:w-auto @min-[30rem]/starters:items-center @min-[30rem]/starters:bg-transparent @min-[30rem]/starters:dark:bg-transparent"
              >
                <span
                  className={`mt-0.5 flex shrink-0 @min-[30rem]/starters:mt-0 ${ROLE_ICON_COLOUR[entry.accentRole]}`}
                >
                  {iconFor(entry)}
                </span>
                <span className="flex min-w-0 flex-col items-start gap-1 @min-[30rem]/starters:flex-row @min-[30rem]/starters:flex-wrap @min-[30rem]/starters:items-center @min-[30rem]/starters:gap-2">
                  {/*
                    The requirement comes before the label it applies to, and
                    before any click: the lock is part of the offer
                    (docs/ui-contracts/image-generation-workspace.md). Its
                    label is as loud as the card's own -- a locked card is
                    not a quieter card.
                  */}
                  {lock && (
                    <span
                      data-testid="chat-starter-lock"
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-semibold text-white dark:bg-zinc-200 dark:text-zinc-900"
                    >
                      <Lock className="h-3 w-3" aria-hidden="true" />
                      <span aria-hidden="true">{lockShortLabel(lock)}</span>
                      <span id={lockId} className="sr-only">
                        {lockLabel(lock)}
                      </span>
                    </span>
                  )}
                  <span className="min-w-0 break-words">
                    {t(entry.labelKey)}
                    {/*
                      The card declared that its question expects a file, so
                      the card says so. Read here rather than acted on: opening
                      a file dialog from a click on a sentence would be a
                      surprise, and the composer already owns the picker.
                    */}
                    {entry.seed.attachment && (
                      <span
                        data-testid="chat-starter-attachment-hint"
                        className="ml-1.5 inline-flex align-[-2px] text-zinc-500 dark:text-zinc-400"
                      >
                        <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="sr-only">{t("chat.attachFile")}</span>
                      </span>
                    )}
                  </span>
                </span>
                <span id={outcomeId} className="sr-only">
                  {t(entry.outcomeKey)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {/*
        The hint, or the full sentence behind whichever card is under the
        pointer or the keyboard. Hidden from assistive technology because both
        are already each card's description; this is the same text for the eye.
      */}
      <p
        data-testid="chat-starter-preview"
        aria-hidden="true"
        className="mx-auto mt-3 max-w-xl text-balance text-center text-[13px] leading-5 text-zinc-600 dark:text-zinc-400"
      >
        {previewed ? t(previewed.entry.outcomeKey) : t("chatStarter.hint")}
      </p>
    </section>
  );
}
