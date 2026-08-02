"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useChatConsentSlotRef } from "@/components/analytics/AnalyticsProvider";
import { ANALYTICS_PREFERENCES_OPEN_EVENT } from "@/lib/analyticsPreferencesEvents";
import { AiDisclaimerNotice } from "@/components/chat/AiDisclaimerNotice";
import { ChatApp } from "@/components/chat/ChatApp";
import { ChatInput } from "@/components/chat/ChatInput";
import type { AttachmentsChangeHandler } from "@/components/chat/useConversationDrafts";
import { useComposerPortalHost } from "@/components/chat/useComposerPortalHost";
import { ChatWelcomeScreen } from "@/components/chat/ChatWelcomeScreen";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ProviderStatusBanner } from "@/components/chat/ProviderStatusBanner";
import {
  ComparisonActionRail,
  type AiReviewAccess,
} from "@/components/chat/ComparisonActionRail";
import type { ChatAttachmentCapabilities } from "@/lib/guestAttachmentPolicy";
import { GuestVerificationSheet } from "@/components/chat/GuestVerificationSheet";
import { useGuestVerification } from "@/components/chat/GuestVerificationProvider";
import { ModeInfoSheet } from "@/components/chat/ModeInfoSheet";
import {
  useCompactBottomDock,
  useKeyboardInset,
  useVisibleViewportHeight,
} from "@/components/chat/useVisualViewport";
import { chatModelSummaryCopy } from "@/components/chat/chatModelSummaryCopy";
import { deriveComparisonReadiness } from "@/lib/comparisonReadiness";
import { buildChatModelSummary } from "@/lib/chatModelSummary";
import { openChatModelPicker } from "@/lib/chatModelPickerEvents";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import {
  type ChatAttachment,
  type Conversation,
} from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import type { WebSearchMode } from "@/lib/appDefaults";
import {
  Check,
  ChevronDown,
  Lock,
  Menu,
  Share2,
  Sparkles,
  SquarePen,
  X,
} from "lucide-react";

type PromptPayload = {
  id: string;
  text: string;
  chatId: string;
  userMessageId: string;
  attachments: ChatAttachment[];
  deepResearchDepth?: "quick" | "standard" | "deep";
};

type ModelRuntimeStatus = "idle" | "loading" | "responding" | "error" | "cancelled" | "paused";

/**
 * PROV-BANNER-001. The provider outage banner's share of the screen.
 *
 * `MAX_VISIBLE_RATIO` is the policy REAUDIT-P1-04 already approved -- a notice
 * may take up to 45% of the screen and scrolls beyond that -- re-based from the
 * layout viewport onto the viewport the user can actually see, which is the
 * only one that changes when the keyboard rises.
 *
 * `MIN_CONVERSATION_AREA_REM` is what the answer canvas (or, on a new chat, the
 * welcome copy above the composer) keeps no matter how much the banner has to
 * say. In rem, so it grows with the reader's text size instead of collapsing to
 * a sliver at 200%.
 *
 * `MIN_REM` is the banner's own floor: a two-line title plus the 44px action
 * row at the reader's text size. A `max-height` never *adds* height, so this
 * only matters when the banner genuinely has that much to say -- it stops the
 * measured budget from squeezing the notice down to a caption when the shell is
 * short, which would be the "reduce the banner to an icon" outcome the composer
 * contract forbids. It is still clamped by `MAX_VISIBLE_RATIO`.
 */
const PROVIDER_BANNER_MAX_VISIBLE_RATIO = 0.45;
const PROVIDER_BANNER_MIN_REM = 5;
const MIN_CONVERSATION_AREA_REM = 4;

type MobileChatShellProps = {
  conversations: Conversation[];
  currentChatId: string | null;
  selectedModels: string[];
  disabledPanels: string[];
  promptPayload: PromptPayload | null;
  inputValue: string;
  setInputValue: (value: string) => void;
  personalizedPrompt?: string | null;
  attachments: ChatAttachment[];
  setAttachments: AttachmentsChangeHandler;
  isSending: boolean;
  focusToken: number;
  isGuestMode: boolean;
  /** What this caller may do with the AI cross-review. */
  aiReviewAccess: AiReviewAccess;
  /** What this caller may do with file attachments. */
  attachmentCapabilities: ChatAttachmentCapabilities;
  guestPreviewMode?: boolean;
  guestMessageCount: number;
  maxGuestMessages: number;
  isModelSelectionReady: boolean;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onLock: (id: string, password: string) => void;
  onUnlock: (id: string) => void;
  onShare: (id: string, title: string) => void;
  onRevokeShare: (id: string) => void;
  onDownload: (id: string, title: string) => void;
  onToggleModel: (modelId: string) => boolean;
  onSwapModel: (removeModelId: string, addModelId: string) => boolean;
  /** Plan/guest entitlement check, so the outage banner never offers a swap this viewer cannot run. */
  canSelectModel?: (modelId: string) => boolean;
  webSearchMode: WebSearchMode;
  onWebSearchModeChange: (mode: WebSearchMode) => void;
  onOpenDeepResearchSetup: () => void;
  isDeepResearchPending: boolean;
  onDismissDeepResearchChip: () => void;
  onRequestUndoToast: (message: string, undo: () => void) => void;
  onSubmit: () => void;
  onBeforeModelSend: (chatId: string) => Promise<boolean>;
  onCompareSummary: () => void;
  isCompareSummaryLoading: boolean;
  isQuickSummaryCached?: boolean;
  availableCredits?: number | null;
  onComparisonReview: () => void;
  onGuestSignInPrompt: () => void;
  onResponseComplete: (promptId: string | null, modelId: string, responseText: string) => void;
  onFollowupSent: (modelId: string) => void;
};

export function MobileChatShell({
  conversations,
  currentChatId,
  selectedModels,
  disabledPanels,
  promptPayload,
  inputValue,
  setInputValue,
  personalizedPrompt,
  attachments,
  setAttachments,
  isSending,
  focusToken,
  isGuestMode,
  aiReviewAccess,
  attachmentCapabilities,
  guestPreviewMode = false,
  guestMessageCount,
  maxGuestMessages,
  isModelSelectionReady,
  onNewChat,
  onSelectConversation,
  onRename,
  onDelete,
  onLock,
  onUnlock,
  onShare,
  onRevokeShare,
  onDownload,
  onToggleModel,
  onSwapModel,
  canSelectModel,
  webSearchMode,
  onWebSearchModeChange,
  onOpenDeepResearchSetup,
  isDeepResearchPending,
  onDismissDeepResearchChip,
  onRequestUndoToast,
  onSubmit,
  onBeforeModelSend,
  onCompareSummary,
  isCompareSummaryLoading,
  isQuickSummaryCached = false,
  availableCredits = null,
  onComparisonReview,
  onGuestSignInPrompt,
  onResponseComplete,
  onFollowupSent,
}: MobileChatShellProps) {
  const { models: AVAILABLE_MODELS } = useModelCatalog();
  const { t, lang } = useLanguage();
  const registerChatConsentSlot = useChatConsentSlotRef();
  // The verification bottom sheet is portalled out of this tree, so while it
  // is up the whole shell behind it goes inert: no pointer input, and nothing
  // for a screen reader to wander into.
  const { isChallengeVisible: isGuestVerificationOpen } = useGuestVerification();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const drawerCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const recentDisclosureRef = useRef<HTMLButtonElement | null>(null);
  // Whatever opened the drawer gets focus back when it closes -- otherwise a
  // keyboard or screen-reader user who opened it from the welcome screen's
  // recent-chats row lands back at the top of the document.
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const openDrawer = useCallback((returnFocusTo: HTMLElement | null) => {
    drawerReturnFocusRef.current = returnFocusTo;
    setIsDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => {
    setIsDrawerOpen(false);
    const returnTarget = drawerReturnFocusRef.current;
    drawerReturnFocusRef.current = null;
    if (returnTarget && returnTarget.isConnected) {
      requestAnimationFrame(() => returnTarget.focus());
    }
  }, []);
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(
    selectedModels[0] || null
  );
  const recentConversations = useMemo(
    () =>
      conversations
        // The chat you are already in is not a chat to return to -- a brand
        // new guest conversation exists from the first render, and offering it
        // back to the user was both meaningless and (on mobile) the only thing
        // keeping the recent-chats row on screen for someone with no history.
        .filter(
          (conversation) =>
            !conversation.isLocked && conversation.id !== currentChatId
        )
        .slice(0, 3)
        .map((conversation) => ({ id: conversation.id, title: conversation.title })),
    [conversations, currentChatId]
  );
  const [modelStatuses, setModelStatuses] = useState<Record<string, ModelRuntimeStatus>>({});
  const [modelEmptyStates, setModelEmptyStates] = useState<Record<string, boolean>>({});
  const [modeSheet, setModeSheet] = useState<"guest" | null>(null);

  const handleTabRemoveClick = useCallback(
    (modelId: string) => {
      const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
      onToggleModel(modelId);
      onRequestUndoToast(
        t("chat.modelRemovedUndo").replace("{model}", model?.name || modelId),
        () => onToggleModel(modelId)
      );
    },
    [AVAILABLE_MODELS, onRequestUndoToast, onToggleModel, t]
  );
  const resolvedActiveModelId =
    activeModelId && selectedModels.includes(activeModelId)
      ? activeModelId
      : selectedModels[0] || null;
  const conversationStateKey = currentChatId || "new";
  const emptyStateKey = useCallback(
    (modelId: string) => `${conversationStateKey}:${modelId}`,
    [conversationStateKey]
  );

  // Bumped to abort every currently-responding panel at once ("stop all").
  const [stopSignal, setStopSignal] = useState(0);
  const isAnyModelResponding = Object.values(modelStatuses).some(
    (status) => status === "responding"
  );

  const handleModelStatusChange = useCallback(
    (modelId: string, nextStatus: ModelRuntimeStatus) => {
      setModelStatuses((current) =>
        current[modelId] === nextStatus
          ? current
          : { ...current, [modelId]: nextStatus }
      );
    },
    []
  );

  const handleEmptyStateChange = useCallback(
    (modelId: string, isEmpty: boolean) => {
      const key = emptyStateKey(modelId);
      setModelEmptyStates((current) =>
        current[key] === isEmpty ? current : { ...current, [key]: isEmpty }
      );
    },
    [emptyStateKey]
  );

  const activeModelIndex = resolvedActiveModelId
    ? selectedModels.indexOf(resolvedActiveModelId)
    : -1;

  const switchModelByOffset = useCallback(
    (offset: number) => {
      if (selectedModels.length < 2 || activeModelIndex < 0) return;
      const nextIndex =
        (activeModelIndex + offset + selectedModels.length) %
        selectedModels.length;
      setActiveModelId(selectedModels[nextIndex]);
    },
    [activeModelIndex, selectedModels]
  );

  useEffect(() => {
    if (!isDrawerOpen) return;

    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => {
      drawerCloseButtonRef.current?.focus();
    });

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleEscape);
    };
  }, [closeDrawer, isDrawerOpen]);

  // The drawer's own analytics-settings entry point (guest-analytics-cookie-settings
  // in AuthButton) opens the analytics preferences notice via this shared event
  // without knowing the drawer is open. The notice portals into a slot in the main
  // chat area, which sits below the drawer's fixed overlay, so without closing the
  // drawer first the notice would render but stay hidden and unreachable behind it.
  useEffect(() => {
    if (!isDrawerOpen) return;
    const closeDrawerForAnalyticsPreferences = () => setIsDrawerOpen(false);
    window.addEventListener(
      ANALYTICS_PREFERENCES_OPEN_EVENT,
      closeDrawerForAnalyticsPreferences
    );
    return () =>
      window.removeEventListener(
        ANALYTICS_PREFERENCES_OPEN_EVENT,
        closeDrawerForAnalyticsPreferences
      );
  }, [isDrawerOpen]);

  const getDrawerFocusableElements = useCallback(() => {
    const panel = drawerPanelRef.current;
    if (!panel) return [];

    return Array.from(
      panel.querySelectorAll<HTMLElement>(
        [
          "button:not([disabled])",
          "input:not([disabled])",
          "select:not([disabled])",
          "textarea:not([disabled])",
          "a[href]",
          '[tabindex]:not([tabindex="-1"])',
        ].join(",")
      )
    ).filter((element) => element.offsetParent !== null);
  }, []);

  useEffect(() => {
    if (!isDrawerOpen) return;

    const handleDrawerKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      const focusableElements = getDrawerFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
        return;
      }

      if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleDrawerKeyDown, true);
    return () => document.removeEventListener("keydown", handleDrawerKeyDown, true);
  }, [getDrawerFocusableElements, isDrawerOpen]);

  // One derivation feeds the header summary, its accessible name and (through
  // the same selectedModels/disabledPanels props) the composer's own count, so
  // the two can no longer disagree about how many models are really answering.
  const modelSummary = useMemo(
    () =>
      buildChatModelSummary({
        selectedModels,
        disabledModelIds: disabledPanels,
        primaryModelId: resolvedActiveModelId,
        models: AVAILABLE_MODELS,
      }),
    [AVAILABLE_MODELS, disabledPanels, resolvedActiveModelId, selectedModels]
  );
  const summaryCopy = chatModelSummaryCopy[lang];
  const modelSummaryLabel = summaryCopy.accessibleName({
    primaryModelName: modelSummary.primary?.name ?? null,
    extraActiveCount: modelSummary.extraActiveCount,
    activeCount: modelSummary.activeCount,
    pausedCount: modelSummary.pausedCount,
  });
  const handleOpenModelPicker = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      trackProductEvent("chat_tool_menu_opened", modelSummary.activeCount, {
        cta_location: "mobile_header_model_summary",
      });
      openChatModelPicker(event.currentTarget);
    },
    [modelSummary.activeCount]
  );
  // See DesktopChatShell's matching comment: an existing *authenticated*
  // conversation shouldn't default to "empty" before any panel has
  // actually reported in, or a still-loading panel would flash the
  // welcome screen instead of its own loading state. Only a brand-new
  // conversation defaults to empty -- guests are excluded since their
  // currentChatId is a client-generated placeholder assigned immediately
  // even for a guaranteed-empty new chat, unlike an authenticated chat's
  // server-assigned id.
  const isActiveConversationEmpty = resolvedActiveModelId
    ? modelEmptyStates[emptyStateKey(resolvedActiveModelId)] ?? (isGuestMode || !currentChatId)
    : true;
  const isConversationEmpty =
    selectedModels.length > 0 &&
    selectedModels.every(
      (modelId) => modelEmptyStates[emptyStateKey(modelId)] ?? (isGuestMode || !currentChatId)
    );
  const currentConversation = conversations.find(
    (conversation) => conversation.id === currentChatId
  );
  const [welcomeInputSlot, setWelcomeInputSlot] = useState<HTMLDivElement | null>(null);
  const [bottomInputSlot, setBottomInputSlot] = useState<HTMLDivElement | null>(null);
  const inputPortalTarget = isConversationEmpty
    ? welcomeInputSlot ?? bottomInputSlot
    : bottomInputSlot ?? welcomeInputSlot;
  // STG-F003: portal into a host we move between the two slots, never into
  // the slots themselves -- switching containers would rebuild the composer
  // and drop whatever the user had just typed into it.
  const composerPortalHost = useComposerPortalHost(inputPortalTarget);
  // Mirrors inputPortalTarget above: the composer (and so the consent
  // notice slot right next to it) lives in one of two DOM positions
  // depending on whether the welcome screen is showing.
  const [welcomeConsentSlot, setWelcomeConsentSlot] = useState<HTMLDivElement | null>(null);
  const [bottomConsentSlot, setBottomConsentSlot] = useState<HTMLDivElement | null>(null);
  const consentSlotTarget = isConversationEmpty
    ? welcomeConsentSlot ?? bottomConsentSlot
    : bottomConsentSlot ?? welcomeConsentSlot;
  useEffect(() => {
    registerChatConsentSlot(consentSlotTarget);
    return () => registerChatConsentSlot(null);
  }, [consentSlotTarget, registerChatConsentSlot]);
  const isCurrentLocked = Boolean(currentConversation?.isLocked);
  const isCurrentShared = Boolean(currentConversation?.shareEnabled);
  const respondingCount = selectedModels.filter((modelId) => {
    const status = modelStatuses[modelId];
    return status === "responding" || status === "loading";
  }).length;
  const errorCount = selectedModels.filter(
    (modelId) => modelStatuses[modelId] === "error"
  ).length;
  const isAnyError = errorCount > 0;
  // Mirrors DesktopChatShell: both shells read comparison readiness (and the
  // sentence that explains it) from the same derivation, so the mobile rail
  // can never enable an action the desktop rail would refuse.
  const comparisonReadiness = deriveComparisonReadiness({
    selectedModelIds: selectedModels,
    disabledModelIds: disabledPanels,
    modelStatuses,
    hasComparableConversation: !isConversationEmpty && Boolean(currentChatId),
    isBusy: isCompareSummaryLoading,
  });
  // REFLOW-P1-01. On a new chat the welcome copy and the composer are one
  // surface: the composer portals into the welcome screen's own slot, so
  // whatever happens to that surface happens to the composer.
  const showWelcomeSurface = isConversationEmpty && selectedModels.length > 0;
  const isCompactBottomDock = useCompactBottomDock();
  // SHORT-VIEWPORT-001: on iOS Safari and Android Chrome's default mode the
  // layout viewport keeps its full height while the keyboard is up, so a
  // `position: fixed` drawer anchored to `inset-y-0` runs underneath the
  // keyboard and takes its own footer with it. This is how many CSS px of the
  // drawer's bottom the user cannot see; 0 whenever there is nothing to
  // compensate for.
  const drawerKeyboardInset = useKeyboardInset();
  // Same number, used for the shell's own scroll region (see <main> below).
  const composerKeyboardInset = drawerKeyboardInset;
  // PROV-BANNER-001. What the user can really see, which is what the outage
  // banner's cap has to be a fraction of.
  const visibleViewportHeight = useVisibleViewportHeight();
  const headerRef = useRef<HTMLElement | null>(null);
  const bottomDockRef = useRef<HTMLDivElement | null>(null);
  // The shell rows the banner may never eat into: the header above it, the
  // bottom dock below it, and -- on a new chat, where the composer lives inside
  // the welcome surface rather than in the dock -- the composer itself.
  const [reservedShellHeight, setReservedShellHeight] = useState(0);
  const [rootFontSizePx, setRootFontSizePx] = useState(16);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const composerOutsideDock = showWelcomeSurface ? welcomeInputSlot : null;
    const measured = [
      headerRef.current,
      bottomDockRef.current,
      composerOutsideDock,
    ].filter((element): element is HTMLElement => Boolean(element));
    const measure = () => {
      const total = measured.reduce(
        (sum, element) => sum + element.getBoundingClientRect().height,
        0
      );
      // None of these rows is sized by the banner, so this measurement can
      // never chase its own result: the header and the dock are `shrink-0` and
      // the composer keeps its own height whatever the banner does.
      setReservedShellHeight((current) =>
        Math.abs(current - total) < 1 ? current : total
      );
      const rootFontSize =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setRootFontSizePx((current) =>
        current === rootFontSize ? current : rootFontSize
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    measured.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [showWelcomeSurface, visibleViewportHeight, welcomeInputSlot]);

  const providerBannerMaxHeight = useMemo(() => {
    // Not measured yet (SSR, first client render): the banner keeps its own
    // `dvh` fallback rather than being handed a number derived from nothing.
    if (!visibleViewportHeight) return null;
    const ceiling = visibleViewportHeight * PROVIDER_BANNER_MAX_VISIBLE_RATIO;
    const budget =
      visibleViewportHeight -
      reservedShellHeight -
      MIN_CONVERSATION_AREA_REM * rootFontSizePx;
    const floor = PROVIDER_BANNER_MIN_REM * rootFontSizePx;
    return Math.max(1, Math.round(Math.min(ceiling, Math.max(budget, floor))));
  }, [reservedShellHeight, rootFontSizePx, visibleViewportHeight]);
  const isAnyWorkingOrError = selectedModels.some((modelId) => {
    const status = modelStatuses[modelId];
    return status === "responding" || status === "loading" || status === "error";
  });
  // The status row used to render unconditionally, so a signed-in new chat --
  // no guest badge, no lock, no share, nothing responding -- still paid its
  // margin plus min-height (~30px) for an empty strip. One boolean decides
  // whether the row exists at all; hiding it with CSS would keep the same
  // reserved box and leave the badges in the accessibility tree.
  const hasHeaderStatus =
    isGuestMode ||
    isCurrentLocked ||
    isCurrentShared ||
    (isAnyWorkingOrError && selectedModels.length > 1);
  // A multi-model conversation renders the full model tab strip immediately
  // below this header -- every model named, the one on screen marked, each with
  // its own live status. Repeating "GPT-5.4 mini +2" plus an avatar stack one
  // row above that is the same information twice, and the duplicate cost a
  // whole header row on the state where vertical space is scarcest.
  //
  // So the header is one row in every state: the title, and a model picker
  // button beside it. With several models that button is a short "3 models"
  // (the tabs below identify which one is on screen); with a single model --
  // where there is no tab strip to fall back on -- it names the model itself.
  // Its accessible name carries the complete selection either way. One layout
  // for every state also means the header never changes height between the
  // hydration placeholder, a single-model chat and a restored comparison.
  const isMultiModelConversation = selectedModels.length > 1;
  // With a status row the badges carry their own padding and end the header;
  // without one the picker button does, and needs a real gap of its own before
  // the divider. Kept as one token instead of two ad-hoc values.
  const headerBottomPadding = hasHeaderStatus ? "pb-1.5" : "pb-2";

  return (
    // REAUDIT-P1-04. `overflow-hidden` on a `100dvh` box meant anything the
    // header, the provider outage banner, the model tabs, the composer and the
    // disclaimer needed beyond the viewport was simply cut off, with no way to
    // reach it.
    // Measured at 320x568 with an outage banner: at root 24px the composer's
    // textarea started at y=593 and its send at y=659 against a 568px viewport
    // (`elementFromPoint` returned null for both), and at root 32px the shell
    // wanted 1280px of content. The document could not scroll either -- the
    // shell's own `overflow: hidden` swallowed the overflow before it ever
    // reached `documentElement`.
    //
    // The height stays exactly `100dvh` -- that is what makes the flex box
    // distribute (and shrink) the rows the way it does today, so no
    // default-text-size layout moves by a pixel. What changes is that the
    // leftover is now *scrollable* instead of discarded: the shell itself
    // becomes the single vertical scroll owner, so a composer that no longer
    // fits is reached by one scroll rather than being unreachable. Horizontal
    // overflow keeps the old `hidden` behaviour, and the specs measure
    // per-element rects rather than the document's `scrollWidth`, so this
    // cannot quietly absorb a real sideways overflow.
    <main
      data-testid="mobile-chat-shell"
      inert={isGuestVerificationOpen || undefined}
      // `100dvh` tracks the browser's own chrome, never the on-screen
      // keyboard, so the bottom of this box sits underneath a raised keyboard
      // and the composer with it. Reserving the occluded height as padding
      // inside the shell's own scroll region means the composer can be
      // scrolled clear of the keyboard instead of being pinned under it -- the
      // same compensation the model sheet already makes (see ChatInput's
      // `keyboardInset`). Zero when there is no keyboard, so the plain layout
      // is untouched.
      style={
        composerKeyboardInset
          ? { paddingBottom: composerKeyboardInset }
          : undefined
      }
      className="flex h-[100dvh] w-full max-w-full flex-col overflow-y-auto overflow-x-hidden overscroll-contain bg-white text-[13px] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <header
        ref={headerRef}
        data-testid="mobile-chat-header"
        data-has-status={hasHeaderStatus ? "true" : "false"}
        className={`min-w-0 shrink-0 overflow-hidden border-b border-zinc-200 bg-white px-3 pt-[calc(0.45rem+env(safe-area-inset-top))] dark:border-zinc-800 dark:bg-zinc-950 ${headerBottomPadding}`}
      >
        <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(event) => openDrawer(event.currentTarget)}
          data-testid="mobile-sidebar-open"
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          aria-label={t("chat.openChatMenu")}
        >
          <Menu className="h-5 w-5" />
        </button>
        <p
          data-testid="mobile-header-title"
          className="min-w-0 flex-1 truncate text-[13px] font-bold"
        >
          {currentConversation?.title || t("sidebar.newChat")}
        </p>
        {isModelSelectionReady ? (
          <button
            type="button"
            data-testid="mobile-header-model-summary"
            onClick={handleOpenModelPicker}
            aria-haspopup="dialog"
            aria-label={modelSummaryLabel}
            className="flex h-11 min-w-0 max-w-[52%] shrink-0 items-center gap-1 rounded-xl border border-zinc-200 bg-zinc-50 px-2 text-[11px] font-bold text-zinc-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 active:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:active:bg-zinc-800"
          >
            {isMultiModelConversation ? (
              <>
                {/*
                  Glyph-sized count drawn inside a 16px badge, already
                  aria-hidden, with the same number spelled out in the label
                  beside it and in the button's accessible name. A deliberate
                  exception to the 11px consumer-text floor (UI-007), marked so
                  the audit can see it rather than infer it.
                */}
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white"
                >
                  {modelSummary.activeCount}
                </span>
                <span
                  data-testid="mobile-header-model-count"
                  className="min-w-0 truncate"
                >
                  {summaryCopy.compactLabel(modelSummary.activeCount)}
                </span>
              </>
            ) : (
              // With a single model there is no tab strip below to name it, so
              // the picker button carries the name itself.
              <>
                <ModelLogo model={modelSummary.primary?.model} size="xs" />
                <span
                  data-testid="mobile-header-primary-model"
                  className="min-w-0 truncate"
                >
                  {modelSummary.primary?.name || t("chat.modelSelect")}
                </span>
              </>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 text-zinc-400" aria-hidden="true" />
          </button>
        ) : (
          // Never paint "1 model" and correct it to "3" a frame later: until
          // the restored selection is known there is no honest number to show.
          // The placeholder is the same 44px row the real button is, so the
          // header never changes height on the way in either.
          <span
            data-testid="mobile-header-model-summary-skeleton"
            className="flex h-11 shrink-0 items-center"
            aria-hidden="true"
          >
            <span className="h-6 w-20 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />
          </span>
        )}
        {!isActiveConversationEmpty && (
          <button
            type="button"
            onClick={onNewChat}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-950/20"
            aria-label={t("sidebar.newChat")}
          >
            <SquarePen className="h-5 w-5" />
          </button>
        )}
        </div>
        {hasHeaderStatus && (
        <div
          data-testid="mobile-header-status-row"
          className="mt-1.5 flex min-h-6 max-w-full gap-1.5 overflow-x-auto overscroll-x-contain"
        >
          {isGuestMode && (
            <button
              type="button"
              onClick={() => setModeSheet("guest")}
              data-testid="mobile-guest-usage-badge"
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full bg-blue-500/10 px-2 text-[11px] font-semibold text-blue-600 dark:text-blue-300"
            >
              <Sparkles className="h-3 w-3" />
              {t("modelTiers.guest")} {guestMessageCount}/{maxGuestMessages}
            </button>
          )}
          {isCurrentLocked && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[11px] font-bold text-amber-600 dark:text-amber-300">
              <Lock className="h-3 w-3" />
              {t("sidebar.lockedBadge")}
            </span>
          )}
          {isCurrentShared && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-300">
              <Share2 className="h-3 w-3" />
              {t("sidebar.sharedBadge")}
            </span>
          )}
          {isAnyWorkingOrError && selectedModels.length > 1 && (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold ${
                isAnyError
                  ? "bg-red-500/10 text-red-600 dark:text-red-300"
                  : "bg-blue-500/10 text-blue-600 dark:text-blue-300"
              }`}
              aria-live="polite"
            >
              {isAnyError
                ? `${errorCount}/${selectedModels.length} error`
                : `${respondingCount}/${selectedModels.length} responding`}
            </span>
          )}
        </div>
        )}
      </header>

      {/*
        PROV-BANNER-001. `shrink-0`, so the banner's height is the one this
        shell measured and not whatever the flex algorithm has left over. Left
        shrinkable it was the only elastic row in the column once the welcome
        surface stopped shrinking, so a short viewport at 200% text squeezed the
        outage notice towards zero -- which is the "reduce the banner to an
        icon" outcome the composer contract forbids. It keeps its budgeted
        height and the shell scrolls instead.
      */}
      <div className="shrink-0">
        <ProviderStatusBanner
          selectedModels={selectedModels}
          compact
          onSwapModel={onSwapModel}
          canSelectModel={canSelectModel}
          maxHeight={providerBannerMaxHeight}
        />
      </div>

      {!isConversationEmpty && selectedModels.length > 1 && (
        <div className="shrink-0 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/60">
          <div className="flex min-w-0 gap-1.5" role="tablist" aria-label={t("chat.modelSelect")}>
            {selectedModels.map((modelId) => {
              const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
              const isActive = resolvedActiveModelId === modelId;
              const isDisabled = disabledPanels.includes(modelId);
              const status = isDisabled ? "paused" : modelStatuses[modelId] || "idle";

              return (
                <div
                  key={modelId}
                  role="tab"
                  aria-selected={isActive}
                  className={`relative flex h-11 min-w-0 flex-1 touch-manipulation items-center rounded-full border shadow-sm transition-colors ${
                    isActive
                      ? "border-blue-500 bg-blue-600 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
                  } ${isDisabled ? "opacity-50" : ""}`}
                >
                  <button
                    type="button"
                    data-testid="mobile-model-tab"
                    data-model-id={modelId}
                    onClick={() => setActiveModelId(modelId)}
                    aria-label={`${model?.name || modelId} ${status}`}
                    className="flex min-w-0 flex-1 shrink-0 items-center gap-1 self-stretch py-1 pl-2.5 pr-1 text-left text-[11px] font-semibold"
                  >
                    <ModelLogo model={model} size="xs" />
                    <span className="min-w-0 flex-1 truncate">{model?.name || modelId}</span>
                    {status === "responding" || status === "loading" ? (
                      <span className={`h-2 w-2 shrink-0 animate-pulse rounded-full ${isActive ? "bg-white" : "bg-blue-500"}`} />
                    ) : status === "error" ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                    ) : status === "cancelled" ? (
                      <span className={`h-2 w-2 shrink-0 rounded-full ${isActive ? "bg-white/70" : "bg-zinc-400"}`} />
                    ) : status === "paused" ? (
                      <span className="shrink-0 text-[11px] font-semibold">OFF</span>
                    ) : status === "idle" ? (
                      <Check className={`h-3 w-3 shrink-0 ${isActive ? "text-white" : "text-emerald-500"}`} />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    data-testid="mobile-model-tab-remove"
                    aria-label={t("chat.removeModelFromComparison")}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleTabRemoveClick(modelId);
                    }}
                    className={`relative mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors before:absolute before:-inset-1.5 before:content-[''] ${
                      isActive
                        ? "text-white/80 hover:bg-white/20"
                        : "text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <section
        data-testid="mobile-conversation-surface"
        data-surface={showWelcomeSurface ? "welcome" : "conversation"}
        // A conversation with answers in it is still `min-h-0 flex-1`. A
        // rem-based floor there looked like an improvement -- it stops the
        // answer canvas being squeezed -- but it moved the composer 51px down
        // at 320x568 and default text, where the section is the row that
        // absorbs the shell's last few pixels today. The composer is in the
        // bottom dock in that state, so its reachability is bought by the
        // shell's scroll owner, not by reserving space here.
        //
        // REFLOW-P1-01. A *new* chat is the opposite case, because the composer
        // portals into the welcome screen inside this section. `min-h-0 flex-1`
        // let the section shrink to nothing. Measured at 390x844 / ko / 200%
        // text with a no-fallback outage banner and a 320px keyboard, where the
        // user can see 524px:
        //
        //   header    0..215   (215px)
        //   banner  231..471   (240px, capped at 379.8px = 45dvh of 844)
        //   section            (0px -- flexed away)
        //   dock    471..524   (the disclaimer, which is all that fit)
        //   composer 588..822, textarea 601..705, send 721..809
        //
        // Every composer control was below the 524px line, inside a welcome
        // overlay that was itself 0px tall with 586px of content in it.
        // `elementFromPoint` at the textarea's centre returned
        // `mobile-chat-shell`, and after scrolling the overlay -- the nearest
        // scroll owner -- it returned `provider-status-title`: the composer was
        // not painted anywhere the user could reach. The shell could not help
        // either; with the section at 0 it had nothing left to scroll.
        //
        // So on a new chat the welcome surface is laid out in normal flow and
        // never shrinks (`flex-[1_0_auto]`): it keeps its content's height,
        // pushes the shell's content past the viewport when it has to, and the
        // shell -- the single scroll owner on the way to the composer -- scrolls
        // to it. There is no second, nested scroll region between the two any
        // more, so "at most one scroll owner" is structural rather than lucky.
        className={`relative flex flex-col bg-zinc-50 dark:bg-zinc-950 ${
          showWelcomeSurface
            ? "flex-[1_0_auto] justify-center"
            : "min-h-0 flex-1 overflow-hidden"
        }`}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchStartXRef.current = touch.clientX;
          touchStartYRef.current = touch.clientY;
        }}
        onTouchEnd={(event) => {
          const startX = touchStartXRef.current;
          const startY = touchStartYRef.current;
          touchStartXRef.current = null;
          touchStartYRef.current = null;
          if (startX === null || startY === null) return;

          const touch = event.changedTouches[0];
          const deltaX = touch.clientX - startX;
          const deltaY = touch.clientY - startY;
          if (Math.abs(deltaX) < 72 || Math.abs(deltaY) > 48) return;
          switchModelByOffset(deltaX < 0 ? 1 : -1);
        }}
      >
        {showWelcomeSurface && (
          // REAUDIT-P1-04 kept this in an absolutely positioned, independently
          // scrolling overlay so it could not paint past the section's bottom
          // edge. That solved the overlap and created the nested scroll owner
          // REFLOW-P1-01 is removing: in normal flow the welcome copy, the
          // composer and the AI disclaimer are all rows of the same scroll
          // region, so the composer can neither be clipped nor be left behind
          // by a scroll that moved the wrong surface.
          <ChatWelcomeScreen
            recentConversations={recentConversations}
            onSelectConversation={onSelectConversation}
            inputSlotRef={setWelcomeInputSlot}
            consentSlotRef={setWelcomeConsentSlot}
            recentAccess="disclosure"
            recentDisclosureRef={(node) => {
              recentDisclosureRef.current = node;
            }}
            onOpenRecentConversations={() => openDrawer(recentDisclosureRef.current)}
          />
        )}
        {selectedModels.length > 0 ? (
          selectedModels.map((modelId, panelIndex) => {
            // The panels stay mounted while the welcome surface is up -- they
            // are what reports the conversation empty in the first place -- but
            // they render no transcript in that state (ChatApp's
            // `useCenteredWelcome` branch), so they are laid out only when they
            // have something to lay out.
            const isPanelVisible =
              resolvedActiveModelId === modelId && !showWelcomeSurface;

            return (
              <div
                key={`${currentChatId || "new"}:panel:${panelIndex}`}
                className={`min-h-0 flex-1 flex-col overflow-hidden ${
                  isPanelVisible ? "flex" : "hidden"
                }`}
                style={isPanelVisible ? undefined : { contentVisibility: "hidden" }}
                aria-hidden={!isPanelVisible}
              >
                <ChatApp
                  modelId={modelId}
                  initialConversationId={currentChatId}
                  promptPayload={promptPayload}
                  isPanelDisabled={disabledPanels.includes(modelId)}
                  isGuestMode={isGuestMode}
                  webSearchMode={webSearchMode}
                  onBeforeSend={onBeforeModelSend}
                  hideModelOnlyInput
                  useCenteredWelcome
                  onEmptyStateChange={handleEmptyStateChange}
                  onStatusChange={handleModelStatusChange}
                  onResponseComplete={onResponseComplete}
                  onFollowupSent={onFollowupSent}
                  onRequestCloseModel={() => onToggleModel(modelId)}
                  hasMultipleActiveModels={selectedModels.length > 1}
                  stopSignal={stopSignal}
                />
              </div>
            );
          })
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-zinc-500">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-blue-500/10 text-blue-500">
              <Sparkles className="h-7 w-7" />
            </div>
            <p className="text-base font-bold text-zinc-800 dark:text-zinc-100">{t("chat.inactivePanel")}</p>
            <p className="mt-2 max-w-xs text-sm leading-6">{t("chat.chooseModel")}</p>
            <button
              type="button"
              onClick={onNewChat}
              className="mt-5 rounded-full bg-blue-600 px-4 py-2 text-sm font-bold text-white shadow-sm shadow-blue-950/20"
            >
              {t("sidebar.newChat")}
            </button>
          </div>
        )}
      </section>

      {/*
        Follow-up tools belong *after* the answers they act on: the rail used
        to render above the answer section, so a screen reader met "summarise
        these differences" before there were any differences to read. It now
        sits directly above the composer inside the same bottom dock, sharing
        the composer's alignment axis without becoming one of its controls.

        The dock is one measured box (PROV-BANNER-001) rather than four
        siblings, so the shell can subtract exactly what it costs from the
        outage banner's budget. It is a plain `shrink-0` column, so every row
        inside it keeps the width, order and flex behaviour it had as a direct
        child of the shell.
      */}
      <div
        ref={bottomDockRef}
        data-testid="mobile-bottom-dock"
        className="flex w-full shrink-0 flex-col"
      >
      <ComparisonActionRail
        layout="mobile"
        readiness={comparisonReadiness}
        aiReviewAccess={aiReviewAccess}
        isCompactViewport={isCompactBottomDock}
        isCompareSummaryLoading={isCompareSummaryLoading}
        isQuickSummaryCached={isQuickSummaryCached}
        availableCredits={availableCredits}
        onCompareSummary={onCompareSummary}
        onComparisonReview={onComparisonReview}
        onGuestSignInPrompt={onGuestSignInPrompt}
      />

      <div ref={setBottomConsentSlot} className="shrink-0" />
      <div ref={setBottomInputSlot} />
      {composerPortalHost &&
        createPortal(
          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            personalizedPrompt={personalizedPrompt}
            onSubmit={onSubmit}
            onCancel={() => setStopSignal((current) => current + 1)}
            isSending={isSending || isAnyModelResponding}
            focusToken={focusToken}
            isNewConversation={isActiveConversationEmpty}
            currentChatId={currentChatId}
            selectedModels={selectedModels}
            disabledModelIds={disabledPanels}
            onToggleModel={onToggleModel}
            onSwapModel={onSwapModel}
            webSearchMode={webSearchMode}
            onWebSearchModeChange={onWebSearchModeChange}
            onOpenDeepResearchSetup={onOpenDeepResearchSetup}
            isDeepResearchPending={isDeepResearchPending}
            onDismissDeepResearchChip={onDismissDeepResearchChip}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            attachmentCapabilities={attachmentCapabilities}
            onGuestSignInPrompt={onGuestSignInPrompt}
            isGuestMode={isGuestMode}
            guestPreviewMode={guestPreviewMode}
            guestMessageCount={guestMessageCount}
            maxGuestMessages={maxGuestMessages}
            variant={isConversationEmpty ? "floating" : "bar"}
            hideTopBorder={comparisonReadiness.isVisible}
            hideDisclaimer
          />,
          composerPortalHost
        )}

      <AiDisclaimerNotice testId="chat-ai-disclaimer-mobile" />
      </div>

      {isDrawerOpen && (
        <div
          className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={t("sidebar.title")}
        >
          <button
            type="button"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={closeDrawer}
            aria-label={t("auth.cancel")}
          />
          <div
            ref={drawerPanelRef}
            data-testid="mobile-sidebar-drawer"
            // SHORT-VIEWPORT-001: the bottom inset is padding on the panel, not
            // on the footer inside it, so the sidebar's own scroll region ends
            // above the home indicator instead of scrolling its last control
            // underneath it.
            className="absolute inset-y-0 left-0 z-10 flex w-[min(24rem,92vw)] max-w-full bg-zinc-50 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl dark:bg-zinc-950"
            style={
              drawerKeyboardInset ? { bottom: drawerKeyboardInset } : undefined
            }
          >
            <div className="absolute right-[-0.45rem] top-1/2 h-12 w-1.5 -translate-y-1/2 rounded-full bg-white/70 shadow dark:bg-zinc-700/80" aria-hidden="true" />
            <ChatSidebar
              conversations={conversations}
              currentChatId={currentChatId}
              onNewChat={() => {
                setIsDrawerOpen(false);
                drawerReturnFocusRef.current = null;
                onNewChat();
              }}
              onSelectConversation={(id) => {
                setIsDrawerOpen(false);
                drawerReturnFocusRef.current = null;
                onSelectConversation(id);
              }}
              onRename={onRename}
              // These open a page-level confirmation dialog that renders outside
              // the drawer. The drawer must close first or the dialog is painted
              // underneath its overlay and the action looks like it did nothing.
              onDelete={(id) => {
                setIsDrawerOpen(false);
                onDelete(id);
              }}
              isGuestMode={isGuestMode}
              guestMessageCount={guestMessageCount}
              maxGuestMessages={maxGuestMessages}
              onLock={onLock}
              onUnlock={(id) => {
                setIsDrawerOpen(false);
                onUnlock(id);
              }}
              onShare={onShare}
              onRevokeShare={(id) => {
                setIsDrawerOpen(false);
                onRevokeShare(id);
              }}
              onDownload={onDownload}
              currentModelId={resolvedActiveModelId}
              attachmentCount={attachments.length}
              isMobileDrawer
            />
            <button
              ref={drawerCloseButtonRef}
              type="button"
              onClick={closeDrawer}
              // Above the sidebar's own sticky header (z-10), which the button
              // deliberately floats over -- the header reserves pr-16 for it.
              //
              // The offset carries the top inset itself. Absolute positioning
              // resolves against the panel's border edge, so the panel's
              // `pt-[env(safe-area-inset-top)]` moves its content but not this
              // button, which otherwise settles under the notch.
              className="absolute right-3 top-[calc(0.75rem+env(safe-area-inset-top))] z-20 flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-900/80 text-white"
              aria-label={t("auth.cancel")}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      <ModeInfoSheet
        mode={modeSheet}
        onClose={() => setModeSheet(null)}
        guestMessageCount={guestMessageCount}
        maxGuestMessages={maxGuestMessages}
        activeModelCount={selectedModels.length}
      />

      {/*
        Portalled to <body>, so it is neither part of the composer's height
        calculation nor inside the message list -- and, while closed, consumes
        no layout at all.
      */}
      <GuestVerificationSheet />
    </main>
  );
}
