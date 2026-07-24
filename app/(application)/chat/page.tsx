"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Info, Loader2, Sparkles, X } from "lucide-react";
import { DesktopChatShell } from "@/components/chat/DesktopChatShell";
import { MobileChatShell } from "@/components/chat/MobileChatShell";
import { ComparisonReviewDialog } from "@/components/chat/ComparisonReviewDialog";
import { UpgradeCtaLink } from "@/components/billing/UpgradeCtaLink";
import { ModelFinder } from "@/components/onboarding/ModelFinder";
import { Conversation, type ChatAttachment } from "@/components/chat/types";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { useSession } from "next-auth/react";
import {
  useLanguage,
  type Language,
} from "@/components/LanguageProvider";
import {
  APP_DEFAULTS,
  GUEST_BRAND_TRIO_MODEL_IDS,
  GUEST_FALLBACK_MODEL_IDS,
} from "@/lib/appDefaults";
import {
  canUseModelWithPlan,
  getModelUsageProfile,
  getWeightedUsageCredits,
  type AiModel,
} from "@/lib/models";
import {
  USER_SETTINGS_UPDATED_EVENT,
  type UserSettingsUpdatedDetail,
} from "@/lib/userSettingsEvents";
import {
  APP_TOAST_EVENT,
  type AppToastEventDetail,
  type AppToastTone,
} from "@/lib/appToast";
import {
  notifyUserUsageChanged,
  useUserUsage,
} from "@/components/chat/useUserUsage";
import {
  trackProductEvent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import {
  isThemePreference,
  storeAndApplyThemePreference,
} from "@/lib/theme";
import { detectBrowserTimeZone } from "@/lib/userTimeZone";
import {
  formatChatCostSafetyDetails,
  isChatCostSafetyCode,
} from "@/lib/chatCostSafetyCore";
import {
  buildGuestImportPayload,
  consumePendingGuestImportIntent,
  GUEST_IMPORT_SEEN_KEY,
  importGuestConversation,
  isGuestConversationEmpty,
  listImportableGuestConversations,
  removeGuestConversationStorage,
  writePendingGuestImportIntent,
  type GuestConversationSummary,
} from "@/lib/guestImport";
import { GuestImportModal } from "@/components/chat/GuestImportModal";
import { GUEST_IMPORT_MODAL_OPEN_EVENT } from "@/lib/guestImportModalEvents";
import { useTurnstile } from "@/components/chat/useTurnstile";

// Persists which conversation is open in *this tab* so an F5 / crash
// recovery restores it instead of falling back to the welcome screen --
// while a brand-new tab (no sessionStorage) still lands on welcome as
// intended. Deliberately sessionStorage, not localStorage: closing the
// browser and coming back should still default to welcome.
const ACTIVE_CHAT_STORAGE_KEY = "tomverse_active_chat_id";

// Private Mode has been removed as a product concept. This key is kept only
// so a one-time effect below can clear it out of any browser that still has
// it set from before the removal -- it must never be read to restore state.
const PRIVATE_MODE_STORAGE_KEY = "tomverse_private_mode_active";

const normalizeStringArray = (value: unknown, fallback: string[]) => {
  let parsed = value;
  for (let i = 0; i < 2 && typeof parsed === "string"; i++) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fallback;
    }
  }
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : fallback;
};

const uniqueStrings = (values: string[]) => Array.from(new Set(values));
type PendingModelSettingsSync = {
  targetChatId: string;
  models: string[];
  disabled: string[];
};
type ConfirmedModelSettings = PendingModelSettingsSync;
const isLanguage = (value: unknown): value is Language =>
  value === "en" ||
  value === "ko" ||
  value === "zh" ||
  value === "fr" ||
  value === "de" ||
  value === "es" ||
  value === "pt";

const guestTrialCopy: Record<
  Language,
  { title: string; body: string; action: string; cancel: string }
> = {
  en: {
    title: "Want more model choices and saved work?",
    body: "Create a free account to access a broader model catalogue, save conversations, and unlock signed-in features.",
    action: "Create a free account",
    cancel: "Continue as guest",
  },
  ko: {
    title: "더 다양한 모델과 저장 기능이 필요하신가요?",
    body: "무료 계정을 만들면 더 넓은 모델 카탈로그, 대화 저장 및 로그인 전용 기능을 사용할 수 있습니다.",
    action: "무료 계정 만들기",
    cancel: "게스트로 계속하기",
  },
  zh: {
    title: "想要更多模型选择和保存功能吗？",
    body: "创建免费账户即可解锁更广泛的模型库、保存对话记录，并使用登录专属功能。",
    action: "创建免费账户",
    cancel: "以访客身份继续",
  },
  fr: {
    title: "Envie de plus de modèles et de sauvegarder votre travail ?",
    body: "Créez un compte gratuit pour accéder à un catalogue de modèles plus large, sauvegarder vos conversations et débloquer les fonctionnalités réservées aux comptes connectés.",
    action: "Créer un compte gratuit",
    cancel: "Continuer en tant qu’invité",
  },
  de: {
    title: "Mehr Modellauswahl und gespeicherte Arbeit gewünscht?",
    body: "Erstellen Sie ein kostenloses Konto, um auf einen breiteren Modellkatalog zuzugreifen, Unterhaltungen zu speichern und Funktionen für angemeldete Nutzer freizuschalten.",
    action: "Kostenloses Konto erstellen",
    cancel: "Als Gast fortfahren",
  },
  es: {
    title: "¿Quieres más opciones de modelos y guardar tu trabajo?",
    body: "Crea una cuenta gratuita para acceder a un catálogo de modelos más amplio, guardar conversaciones y desbloquear funciones exclusivas para usuarios con sesión iniciada.",
    action: "Crear una cuenta gratuita",
    cancel: "Continuar como invitado",
  },
  pt: {
    title: "Quer mais opções de modelos e salvar seu trabalho?",
    body: "Crie uma conta grátis para acessar um catálogo de modelos mais amplo, salvar conversas e desbloquear recursos exclusivos para quem está conectado.",
    action: "Criar uma conta grátis",
    cancel: "Continuar como convidado",
  },
};

const cloneAttachmentPreviews = async (
  items: ChatAttachment[]
): Promise<ChatAttachment[]> =>
  Promise.all(
    items.map(async (attachment) => {
      if (!attachment.data) return attachment;
      if (attachment.data.startsWith("data:")) return { ...attachment };

      try {
        const blob = await fetch(attachment.data).then((response) =>
          response.blob()
        );
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            typeof reader.result === "string"
              ? resolve(reader.result)
              : reject(new Error("Attachment preview is not readable."));
          reader.onerror = () =>
            reject(reader.error || new Error("Attachment preview failed."));
          reader.readAsDataURL(blob);
        });
        return { ...attachment, data: dataUrl };
      } catch {
        return attachment;
      }
    })
  );

type AppToast = {
  id: string;
  message: string;
  tone: AppToastTone;
  action?: { label: string; onClick: () => void };
};

type BillingSuccessState = {
  plan: string | null;
  interval: "monthly" | "annual";
  accessType: "subscription" | "founding_tester_pass";
};

const normalizeBillingPlanLabel = (value: string | null) => {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "max") return "Max";
  if (normalized === "pro") return "Pro";
  if (normalized === "free") return "Free";
  return null;
};

function ConfirmDialog({
  title,
  description,
  detail,
  confirmLabel,
  cancelLabel,
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">{title}</h2>
        {detail && (
          <p className="mt-2 rounded-xl bg-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-700 dark:bg-zinc-950 dark:text-zinc-200">
            {detail}
          </p>
        )}
        <p className="mt-3 whitespace-pre-line text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          {description}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${
              danger ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatShellSkeleton({ label }: { label: string }) {
  return (
    <main
      data-testid="chat-shell-skeleton"
      aria-busy="true"
      aria-label={label}
      className="flex h-screen overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <aside className="hidden w-[clamp(19rem,32vw,30rem)] shrink-0 flex-col border-r border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950 md:flex">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-cyan-400 via-blue-500 to-purple-500" />
          <div>
            <div className="text-lg font-black">Tomverse Insight</div>
            <div className="mt-1 h-2 w-20 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
          </div>
        </div>
        <div className="mt-6 h-12 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
        <div className="mt-3 h-12 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
        <div className="mt-7 h-11 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
        <div className="mt-4 flex-1 animate-pulse rounded-2xl bg-zinc-50 dark:bg-zinc-900/60" />
        <div className="mt-4 h-24 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-900" />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800 md:hidden">
          <div className="h-9 w-9 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />
          <span className="font-black">Tomverse Insight</span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
          <div className="h-11 w-56 max-w-[70vw] animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-900" />
          <div className="mt-4 min-h-0 flex-1 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50" />
          <div className="mt-4 h-28 animate-pulse rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" />
        </div>
        <span className="sr-only">{label}</span>
      </section>
    </main>
  );
}

export default function Home() {
  const {
    models: AVAILABLE_MODELS,
    getModel,
    isEnabledModelId,
  } = useModelCatalog();
    const { t, setLang, lang } = useLanguage();
  const formatCopy = (key: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      t(key)
    );
  const [isConversationsLoaded, setIsConversationsLoaded] = useState(false);  
  const [isInitialConversationResolved, setIsInitialConversationResolved] =
    useState(false);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const { data: session, status } = useSession();
  const sessionUserId = session?.user?.id || null;
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isViewportReady, setIsViewportReady] = useState(false);

  const isSending = false;
  const [focusToken, setFocusToken] = useState(0);

    const [userDefaultEngine, setUserDefaultEngine] = useState<string>(APP_DEFAULTS.defaultModelId);
  const [guestDefaultModelId, setGuestDefaultModelId] = useState<string>(
    APP_DEFAULTS.guestDefaultModelId
  );
  const [isGuestSettingsLoaded, setIsGuestSettingsLoaded] = useState(false);
  const [isUserSettingsLoaded, setIsUserSettingsLoaded] = useState(false);

  const [inputValue, setInputValue] = useState("");
  const [personalizedPrompt, setPersonalizedPrompt] = useState<string | null>(null);
  const [isGuestPreviewEntry] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("entry") ===
        "guest-preview"
  );
  const [showGuestSignInPrompt, setShowGuestSignInPrompt] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [promptPayload, setPromptPayload] = useState<{ id: string; text: string; chatId: string; userMessageId: string; attachments: ChatAttachment[] } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingRemoveModelId, setPendingRemoveModelId] = useState<string | null>(null);
  const [pendingRevokeShareId, setPendingRevokeShareId] = useState<string | null>(null);
  const [billingSuccess, setBillingSuccess] = useState<BillingSuccessState | null>(null);
  const [compareSummary, setCompareSummary] = useState<{
    title: string;
    result: {
      commonConclusions: string[];
      importantDifferences: string[];
      modelKeyClaims: Array<{ responseId: "A" | "B" | "C"; claims: string[] }>;
      verificationNeeded: string[];
    };
    responseMap: Array<{
      responseId: "A" | "B" | "C";
      messageId: string;
      modelId: string;
      modelName: string;
    }>;
    usageCredits: number;
    originalUsageCredits?: number;
    cached: boolean;
  } | null>(null);
  const [isCompareSummaryLoading, setIsCompareSummaryLoading] = useState(false);
  // The comparison summary is one non-streaming request, so there's no real
  // per-step progress to report -- but it does genuinely read the responses
  // before it can summarize their differences, so swapping the loading text
  // once partway through reflects that real (if coarse) sequencing instead
  // of a single static line for however long the request takes.
  const [compareSummaryStage, setCompareSummaryStage] = useState(0);
  useEffect(() => {
    if (!isCompareSummaryLoading) {
      queueMicrotask(() => setCompareSummaryStage(0));
      return;
    }
    const timer = window.setTimeout(() => setCompareSummaryStage(1), 2500);
    return () => window.clearTimeout(timer);
  }, [isCompareSummaryLoading]);
  const [showComparisonReview, setShowComparisonReview] = useState(false);
  const [upgradeModelPrompt, setUpgradeModelPrompt] = useState<AiModel | null>(null);
  const [valueUpgradeSource, setValueUpgradeSource] = useState<
    "comparison" | "ai_review" | null
  >(null);
  // Guest-only equivalent of valueUpgradeSource: shown at most once per
  // browser, only for guests who entered via the guided preview flow, at
  // the two moments they've actually seen Tomverse's value -- a full
  // multi-model comparison finishing, and (for the guest-accessible Quick
  // Difference Summary) a completed review -- rather than after a single
  // model's first reply (the removed auto-popup this replaces).
  const [showGuestSaveCompareCard, setShowGuestSaveCompareCard] = useState(false);
  const [showGuestSaveReviewCard, setShowGuestSaveReviewCard] = useState(false);
  const [unlockDialog, setUnlockDialog] = useState<{ id: string; password: string; error: string } | null>(null);
  const [lockedSelectDialog, setLockedSelectDialog] = useState<{ id: string; password: string; error: string } | null>(null);
  const [toast, setToast] = useState<AppToast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const [selectedModels, setSelectedModels] = useState<string[]>([APP_DEFAULTS.defaultModelId]);
  
  const [disabledPanels, setDisabledPanels] = useState<string[]>([]);
  const modelSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelSyncAbortRef = useRef<AbortController | null>(null);
  const pendingModelSyncRef = useRef<PendingModelSettingsSync | null>(null);
  const confirmedModelSettingsRef = useRef<ConfirmedModelSettings | null>(null);
  const comparisonCompletionsRef = useRef<Map<string, Set<string>>>(new Map());
  const comparisonTrackedRef = useRef<Set<string>>(new Set());
  const localComparisonResponsesRef = useRef<
    Map<string, Map<string, string>>
  >(new Map());
  const latestLocalComparisonPromptRef = useRef<string | null>(null);
  const localComparisonQuestionsRef = useRef<Map<string, string>>(new Map());
  const promptCountsRef = useRef<Map<string, number>>(new Map());
  const comparisonPresetAppliedRef = useRef(false);
  const comparisonPresetRequestedRef = useRef(false);
  const comparisonPreflightInFlightRef = useRef(false);

  const isGuestMode = status !== "loading" && !sessionUserId;
  const {
    containerRef: guestQuickSummaryTurnstileContainerRef,
    getToken: getGuestQuickSummaryTurnstileToken,
  } = useTurnstile(isGuestMode, "guest_quick_summary");
  const accountUsage = useUserUsage(!isGuestMode);

  // The refs above are only ever written live by handleResponseComplete, so
  // a page reload restores the visible messages (and re-enables the button,
  // since panel status is derived from the restored message status) but
  // leaves these refs empty -- clicking Quick difference summary right
  // after a refresh then silently no-ops instead of sending a request.
  // Rebuild the latest turn from the same guest_messages_* localStorage the
  // panels themselves load from, whenever the active guest chat (re)loads.
  useEffect(() => {
    if (!isGuestMode || !currentChatId) return;
    if (typeof window === "undefined") return;

    let latestUserMessage: { id: string; content: string } | null = null;
    const responses = new Map<string, string>();

    for (const modelId of selectedModels) {
      const raw = window.localStorage.getItem(
        `guest_messages_${currentChatId}_${modelId}`
      );
      if (!raw) continue;
      let stored: unknown;
      try {
        stored = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(stored) || stored.length < 2) continue;

      const lastMessage = stored[stored.length - 1] as
        | { role?: unknown; status?: unknown; content?: unknown }
        | undefined;
      const secondLastMessage = stored[stored.length - 2] as
        | { id?: unknown; role?: unknown; content?: unknown }
        | undefined;

      if (
        lastMessage?.role === "assistant" &&
        lastMessage.status === "normal" &&
        typeof lastMessage.content === "string" &&
        lastMessage.content.trim() &&
        secondLastMessage?.role === "user" &&
        typeof secondLastMessage.id === "string" &&
        typeof secondLastMessage.content === "string"
      ) {
        responses.set(modelId, lastMessage.content);
        latestUserMessage = { id: secondLastMessage.id, content: secondLastMessage.content };
      }
    }

    if (!latestUserMessage || responses.size < 2) return;
    localComparisonQuestionsRef.current.set(latestUserMessage.id, latestUserMessage.content);
    localComparisonResponsesRef.current.set(latestUserMessage.id, responses);
    latestLocalComparisonPromptRef.current = latestUserMessage.id;
  }, [currentChatId, isGuestMode, selectedModels]);
  const maxSelectableModels = isGuestMode
    ? APP_DEFAULTS.maxGuestSelectedModels
    : accountUsage?.limits.maxModels || APP_DEFAULTS.maxSelectedModels;
  // Server-authoritative: mirrors the exact day-bucket acquireChatAccess
  // enforces, refreshed after every completed response (see
  // refreshGuestUsage below) instead of a client-only counter that could
  // show "plenty left" while the server's real bucket was already spent.
  const [guestUsage, setGuestUsage] = useState<{ used: number; limit: number } | null>(null);
  const guestMessageCount = guestUsage?.used ?? 0;
  const MAX_GUEST_MESSAGES = guestUsage?.limit ?? 20;
  const refreshGuestUsage = useCallback(() => {
    if (!isGuestMode) return;
    fetch("/api/user/guest-usage", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.used === "number" && typeof data.limit === "number") {
          setGuestUsage({ used: data.used, limit: data.limit });
        }
      })
      .catch(() => {
        // Keep the last known snapshot; the next successful refresh (after
        // the next response, or the periodic one below) will correct it.
      });
  }, [isGuestMode]);
  const currentAccessPlan = isGuestMode ? "Guest" : accountUsage?.plan ?? "Free";
  const planLockedModelIds = useMemo(
    () =>
      selectedModels.filter((modelId) => {
        const model = getModel(modelId);
        return Boolean(model && !canUseModelWithPlan(currentAccessPlan, model));
      }),
    [currentAccessPlan, getModel, selectedModels]
  );
  const effectiveDisabledPanels = useMemo(
    () => uniqueStrings([...disabledPanels, ...planLockedModelIds]),
    [disabledPanels, planLockedModelIds]
  );
  const activeModelCount = selectedModels.filter(
    (modelId) => !effectiveDisabledPanels.includes(modelId)
  ).length;

  // Mirrors ChatInput's own estimate so the guest daily-credit gate and
  // display reflect each selected model's real weighted cost (Standard=1,
  // Advanced=4, Premium=8, ...) instead of a flat 1-per-model count, which
  // let combinations of higher-tier models pass this client-side check
  // while the server's weighted day-credit bucket still rejected them.
  const estimateWeightedRequestCredits = useCallback(
    (text: string, attachments: ChatAttachment[]) => {
      const textParts = [
        text,
        ...attachments
          .filter((attachment) => attachment.kind === "text" && attachment.data)
          .map((attachment) => attachment.data || ""),
      ];
      const textBytes = new TextEncoder().encode(textParts.join("\n\n")).byteLength;
      const binaryAttachmentTokens =
        attachments.filter((attachment) => attachment.kind === "file").length * 16_000;
      const estimatedInputTokens = Math.max(
        1,
        Math.ceil(textBytes / 4) + binaryAttachmentTokens
      );
      return selectedModels
        .filter((modelId) => !effectiveDisabledPanels.includes(modelId))
        .reduce((sum, modelId) => {
          const model = AVAILABLE_MODELS.find((item) => item.id === modelId);
          return sum + (model ? getWeightedUsageCredits(model, estimatedInputTokens) : 0);
        }, 0);
    },
    [AVAILABLE_MODELS, effectiveDisabledPanels, selectedModels]
  );

  const isInitialSelectedRef = useRef(false);
  const guestCarryoverAppliedRef = useRef(false);
  const currentChatIdRef = useRef(currentChatId);

  useEffect(() => {
    currentChatIdRef.current = currentChatId;
  }, [currentChatId]);

  // One-time cleanup for browsers that still have the old Private Mode flag
  // set from before the feature was removed -- must never be restored from.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(PRIVATE_MODE_STORAGE_KEY);
  }, []);

  // Consumes the "log in and continue this conversation" CTA's intent flag
  // (see lib/guestImport.ts) after a fresh, full-page login redirect lands
  // back here. The effect itself is defined further down (right after
  // handleSelectConversation, which it calls, is declared -- referencing it
  // from up here would be a forward reference the React Compiler rejects).
  // This ref still lives here so the guest-bootstrap/carryover effects
  // below, which only read it, can bail out without needing to know
  // anything else about the import flow.
  const pendingGuestImportRef = useRef(false);

  // Generic (non-CTA) login: if this browser has any guest conversation
  // data at all, offer the one-time import choice modal. Skipped entirely
  // when the CTA-path effect (further down) already claimed this mount (it
  // either already imported, or found nothing to import for that one
  // specific conversation -- either way, offering the broader "import
  // everything" modal on the same login would be a confusing double
  // prompt).
  const [isGuestImportModalOpen, setIsGuestImportModalOpen] = useState(false);
  const [guestImportCandidates, setGuestImportCandidates] = useState<GuestConversationSummary[]>([]);
  const [guestImportDefaultId, setGuestImportDefaultId] = useState<string | null>(null);

  useEffect(() => {
    if (isGuestMode || !sessionUserId || !isUserSettingsLoaded) return;
    if (pendingGuestImportRef.current) return;
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(GUEST_IMPORT_SEEN_KEY) === "1") return;

    const importable = listImportableGuestConversations();
    if (importable.length === 0) return;

    queueMicrotask(() => {
      setGuestImportCandidates(importable);
      setGuestImportDefaultId(window.sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY));
      setIsGuestImportModalOpen(true);
    });
  }, [isGuestMode, sessionUserId, isUserSettingsLoaded]);

  const openGuestImportPicker = useCallback(() => {
    const importable = listImportableGuestConversations();
    setGuestImportCandidates(importable);
    setGuestImportDefaultId(
      typeof window !== "undefined" ? window.sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY) : null
    );
    setIsGuestImportModalOpen(true);
  }, []);

  const closeGuestImportModal = useCallback((markSeen: boolean) => {
    if (markSeen && typeof window !== "undefined") {
      window.localStorage.setItem(GUEST_IMPORT_SEEN_KEY, "1");
    }
    setIsGuestImportModalOpen(false);
  }, []);

  // Gated on isInitialConversationResolved so this doesn't run before the
  // welcome-vs-restore decision below has had a chance to read the saved
  // id: currentChatId starts out null on every mount (restored or not)
  // until that decision resolves it, and this effect would otherwise wipe
  // the very value that decision needs to read.
  useEffect(() => {
    if (typeof window === "undefined" || !isInitialConversationResolved) return;
    if (!currentChatId) {
      window.sessionStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, currentChatId);
  }, [currentChatId, isInitialConversationResolved]);

  useEffect(() => {
    if (!isGuestPreviewEntry) return;

    localStorage.setItem("tomverse_sidebar_organizer_v1", "collapsed");
    window.dispatchEvent(new Event("tomverse-sidebar-organizer-change"));
  }, [isGuestPreviewEntry]);

  const isGuestEligibleModel = useCallback(
    (modelId: string) => {
      const model = getModel(modelId);
      return Boolean(
        model?.enabled &&
          canUseModelWithPlan("Guest", model) &&
          getModelUsageProfile(model).category === "Standard"
      );
    },
    [getModel]
  );

  const clampSelectedModels = useCallback(
    (models: string[]) =>
      Array.from(new Set(models))
        .filter(isEnabledModelId)
        .slice(0, APP_DEFAULTS.maxSelectedModels),
    [isEnabledModelId]
  );

  const clampGuestSelectedModels = useCallback(
    (models: string[]) =>
      clampSelectedModels(models)
        .filter(isGuestEligibleModel)
        .slice(0, APP_DEFAULTS.maxGuestSelectedModels),
    [clampSelectedModels, isGuestEligibleModel]
  );

  const guestDefaultSelectedModels = useMemo(() => {
    // The GPT/Claude/Gemini brand trio is always guaranteed for guests;
    // the admin-configured guestDefaultModelId only reorders which of the
    // three leads, and is ignored if it names a model outside the trio.
    // A brand-trio model that's currently ineligible falls through to the
    // fallback pool instead of silently collapsing the default to 2 models.
    const orderedTrio = GUEST_BRAND_TRIO_MODEL_IDS.includes(guestDefaultModelId)
      ? [
          guestDefaultModelId,
          ...GUEST_BRAND_TRIO_MODEL_IDS.filter((id) => id !== guestDefaultModelId),
        ]
      : GUEST_BRAND_TRIO_MODEL_IDS;
    const candidates = [...orderedTrio, ...GUEST_FALLBACK_MODEL_IDS];
    const trio: string[] = [];
    for (const modelId of candidates) {
      if (trio.includes(modelId) || !isGuestEligibleModel(modelId)) continue;
      trio.push(modelId);
      if (trio.length >= APP_DEFAULTS.maxGuestSelectedModels) break;
    }
    return clampGuestSelectedModels(trio);
  }, [clampGuestSelectedModels, guestDefaultModelId, isGuestEligibleModel]);

  const isNewAccountEligibleModel = useCallback(
    (modelId: string) => {
      const model = getModel(modelId);
      return Boolean(
        model?.enabled &&
          canUseModelWithPlan("Free", model) &&
          getModelUsageProfile(model).category === "Standard"
      );
    },
    [getModel]
  );

  // Shown the first time a freshly created account loads chat, so a new
  // signed-in user starts with the same 3-model side-by-side comparison a
  // guest already sees instead of a single panel. Same brand-trio-plus-
  // fallback selection as guestDefaultSelectedModels above, just checked
  // against "Free" (every guest-eligible model is Free-eligible too).
  const newAccountDefaultSelectedModels = useMemo(() => {
    const candidates = [...GUEST_BRAND_TRIO_MODEL_IDS, ...GUEST_FALLBACK_MODEL_IDS];
    const trio: string[] = [];
    for (const modelId of candidates) {
      if (trio.includes(modelId) || !isNewAccountEligibleModel(modelId)) continue;
      trio.push(modelId);
      if (trio.length >= APP_DEFAULTS.maxSelectedModels) break;
    }
    return clampSelectedModels(trio);
  }, [clampSelectedModels, isNewAccountEligibleModel]);

  useEffect(() => {
    if (!isGuestMode) {
      queueMicrotask(() => setIsGuestSettingsLoaded(true));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setIsGuestSettingsLoaded(false);
    });
    fetch("/api/app-settings", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`App settings load failed: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const nextGuestModel =
          typeof data?.guestDefaultModelId === "string" &&
          isGuestEligibleModel(data.guestDefaultModelId)
            ? data.guestDefaultModelId
            : APP_DEFAULTS.guestDefaultModelId;
        if (cancelled) return;
        setGuestDefaultModelId(nextGuestModel);
        setIsGuestSettingsLoaded(true);
      })
      .catch((error) => {
        console.error("Failed to load public app settings:", error);
        if (!cancelled) {
          setIsGuestSettingsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isGuestEligibleModel, isGuestMode]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const updateViewport = () => {
      setIsMobileViewport(mediaQuery.matches);
      setIsViewportReady(true);
    };

    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  const showToast = useCallback(
    (message: string, tone: AppToast["tone"] = "info", action?: AppToast["action"]) => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }

      setToast({
        id: crypto.randomUUID(),
        message,
        tone,
        action,
      });

      toastTimerRef.current = setTimeout(() => {
        setToast(null);
        toastTimerRef.current = null;
      }, action ? 5000 : 3200);
    },
    []
  );

  const runComparisonPreflight = useCallback(
    async ({
      comparisonId,
      conversationId,
      prompt,
      promptAttachments,
    }: {
      comparisonId: string;
      conversationId: string;
      prompt: string;
      promptAttachments: ChatAttachment[];
    }) => {
      const modelIds = selectedModels.filter(
        (modelId) => !effectiveDisabledPanels.includes(modelId)
      );
      if (isGuestMode || modelIds.length < 2) return true;
      if (comparisonPreflightInFlightRef.current) return false;

      comparisonPreflightInFlightRef.current = true;
      const clientTraceId = crypto.randomUUID();
      try {
        const requestBody = JSON.stringify({
          comparisonId,
          conversationId,
          modelIds,
          prompt,
          attachments: promptAttachments.map((attachment) => ({
            mediaType: attachment.mediaType,
            size: attachment.size,
          })),
        });
        const requestPreflight = () =>
          fetch("/api/chat/preflight", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Client-Request-ID": clientTraceId,
            },
            body: requestBody,
          });

        let response: Response | null = null;
        let errorBody: {
          code?: unknown;
          error?: unknown;
          traceId?: unknown;
          details?: unknown;
        } | null = null;
        let code = "";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            response = await requestPreflight();
          } catch (error) {
            if (attempt === 0) {
              await new Promise((resolve) => window.setTimeout(resolve, 500));
              continue;
            }
            console.error(
              JSON.stringify({
                event: "chat_comparison_preflight_request_failed",
                traceId: clientTraceId,
                errorName: error instanceof Error ? error.name : "UnknownError",
              })
            );
            showToast(
              `${t("chat.comparisonPreflightFailed")} (${t("chat.traceId")}: ${clientTraceId})`,
              "error"
            );
            return false;
          }

          if (response.ok) return true;
          errorBody = await response.json().catch(() => null);
          code = typeof errorBody?.code === "string" ? errorBody.code : "";

          const retryableResponse =
            response.status === 502 ||
            response.status === 504 ||
            (response.status === 503 &&
              code === "COMPARISON_PREFLIGHT_TEMPORARILY_UNAVAILABLE") ||
            (response.status === 500 &&
              code === "COMPARISON_PREFLIGHT_FAILED");
          if (attempt === 0 && retryableResponse) {
            const retryAfterSeconds = Number(
              response.headers.get("Retry-After")
            );
            const retryDelayMs = Number.isFinite(retryAfterSeconds)
              ? Math.min(2_000, Math.max(250, retryAfterSeconds * 1_000))
              : 500;
            await new Promise((resolve) =>
              window.setTimeout(resolve, retryDelayMs)
            );
            continue;
          }
          break;
        }

        if (!response) {
          showToast(
            `${t("chat.comparisonPreflightFailed")} (${t("chat.traceId")}: ${clientTraceId})`,
            "error"
          );
          return false;
        }
        if (
          response.status === 500 &&
          code === "COMPARISON_PREFLIGHT_FAILED"
        ) {
          const traceId =
            typeof errorBody?.traceId === "string"
              ? errorBody.traceId
              : response.headers.get("X-Request-ID") || clientTraceId;
          // The comparison preflight is an all-or-nothing UX guard, not the
          // security boundary. Every /api/chat request revalidates the model,
          // conversation ownership, plan, credits, and cost limits before a
          // provider call. If only this aggregate check fails unexpectedly,
          // continue through those authoritative per-model checks.
          console.warn(
            JSON.stringify({
              event: "chat_comparison_preflight_degraded",
              traceId,
            })
          );
          window.localStorage.setItem(
            "tomverse_last_preflight_trace_id",
            traceId
          );
          return true;
        }
        const localizedMessage =
          code === "CREDIT_BALANCE_INSUFFICIENT" ||
          code === "CREDIT_COST_ALLOWANCE_INSUFFICIENT"
            ? t("chat.comparisonCreditsInsufficient")
            : code === "INTERNAL_DAILY_COST_SAFETY_LIMIT"
              ? t("chat.internalDailyCostSafetyLimit")
              : code === "INTERNAL_MONTHLY_COST_SAFETY_LIMIT"
                ? t("chat.internalMonthlyCostSafetyLimit")
                : code === "PROVIDER_DAILY_SPEND_LIMIT_REACHED" ||
                    code === "PROVIDER_SPEND_LIMIT_REACHED"
                  ? t("chat.providerCostSafetyLimit")
                  : code === "PLAN_DAILY_CREDIT_LIMIT_REACHED"
                    ? t("chat.dailyPlanCreditsUnavailable")
                    : code === "CHAT_QUOTA_EXCEEDED"
                    ? t("chat.comparisonDailyCreditsInsufficient")
                    : code === "CHAT_CONCURRENCY_EXCEEDED"
                      ? t("chat.comparisonConcurrencyLimit")
                      : code === "FREE_PRO_MODEL_QUOTA_EXCEEDED"
                        ? t("chat.comparisonHigherCostQuotaExceeded")
                        : typeof errorBody?.error === "string" &&
                            errorBody.error.trim()
                          ? errorBody.error.trim()
                          : t("chat.comparisonPreflightFailed");
        const traceId =
          typeof errorBody?.traceId === "string"
            ? errorBody.traceId
            : response.headers.get("X-Request-ID") || clientTraceId;
        const costSafetyDetails = isChatCostSafetyCode(code)
          ? formatChatCostSafetyDetails(errorBody?.details)
          : "";
        showToast(
          `${localizedMessage}${
            costSafetyDetails ? ` ${costSafetyDetails}` : ""
          }${
            traceId ? ` (${t("chat.traceId")}: ${traceId})` : ""
          }`,
          "error"
        );
        return false;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "chat_comparison_preflight_client_failed",
            traceId: clientTraceId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          })
        );
        showToast(
          `${t("chat.comparisonPreflightFailed")} (${t("chat.traceId")}: ${clientTraceId})`,
          "error"
        );
        return false;
      } finally {
        comparisonPreflightInFlightRef.current = false;
      }
    }, [effectiveDisabledPanels, isGuestMode, selectedModels, showToast, t]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") !== "success") return;

    const plan = params.get("plan");
    const interval = params.get("interval");
    const accessType =
      params.get("access") === "founding-tester-pass"
        ? "founding_tester_pass"
        : "subscription";
    const urlLanguage = params.get("lang");
    if (isLanguage(urlLanguage)) {
      setLang(urlLanguage);
    }
    queueMicrotask(() => {
      setBillingSuccess({
        plan: normalizeBillingPlanLabel(plan),
        interval: interval === "annual" ? "annual" : "monthly",
        accessType,
      });
    });

    if (!normalizeBillingPlanLabel(plan)) {
      fetch("/api/user/usage", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((usage) => {
          const accountPlan = normalizeBillingPlanLabel(usage?.plan);
          if (accountPlan && accountPlan !== "Free") {
            setBillingSuccess((current) =>
              current ? { ...current, plan: accountPlan } : current
            );
          }
        })
        .catch(() => undefined);
    }

    params.delete("billing");
    params.delete("plan");
    params.delete("interval");
    params.delete("access");
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`
    );
  }, [setLang]);

  useEffect(() => {
    const handleToast = (event: Event) => {
      const detail = (event as CustomEvent<AppToastEventDetail>).detail;
      if (!detail?.message) return;
      showToast(detail.message, detail.tone ?? "info");
    };

    window.addEventListener(APP_TOAST_EVENT, handleToast);
    return () => window.removeEventListener(APP_TOAST_EVENT, handleToast);
  }, [showToast]);

  useEffect(() => {
    window.addEventListener(GUEST_IMPORT_MODAL_OPEN_EVENT, openGuestImportPicker);
    return () => window.removeEventListener(GUEST_IMPORT_MODAL_OPEN_EVENT, openGuestImportPicker);
  }, [openGuestImportPicker]);

    const applyConversationSettings = useCallback((data: {
        selectedModels?: unknown;
        disabledPanels?: unknown;
        messages?: Array<{ role?: string; modelId?: string | null }>;
    }, targetChatId?: string) => {
        const savedModels = normalizeStringArray(data.selectedModels, [userDefaultEngine]);
        const nextModels = clampSelectedModels(uniqueStrings(savedModels));
        const nextDisabled = normalizeStringArray(data.disabledPanels, []).filter(
            (modelId) => nextModels.includes(modelId)
        );

        setSelectedModels(nextModels.length > 0 ? nextModels : [userDefaultEngine]);
        setDisabledPanels(nextDisabled);
        if (targetChatId) {
          confirmedModelSettingsRef.current = {
            targetChatId,
            models: nextModels.length > 0 ? nextModels : [userDefaultEngine],
            disabled: nextDisabled,
          };
        }
    }, [clampSelectedModels, userDefaultEngine]);

  useEffect(() => {
    if (isGuestMode && !isGuestSettingsLoaded) return;
    if (isGuestMode) {
      let cancelled = false;
      queueMicrotask(() => {
      if (cancelled) return;
      setUserDefaultEngine(guestDefaultModelId);
      setSelectedModels(guestDefaultSelectedModels);
      refreshGuestUsage();

      const savedConversations = localStorage.getItem("guest_conversations");
      if (savedConversations) {
        try {
          const parsed = JSON.parse(savedConversations);
          const savedChatId = window.sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);

          // Repeatedly clicking "New Chat" used to pile up empty guest
          // conversations forever (each one written straight to
          // localStorage, none ever cleaned up). Sweep them here on every
          // load/refresh -- except the one this tab is about to restore
          // (if it happens to itself be an empty draft, F5-restoring the
          // user onto it is still correct; only the *other*, abandoned
          // empty ones are stale).
          const keepEmptyId = savedChatId;
          let keptOneEmpty = false;
          const cleaned = Array.isArray(parsed)
            ? parsed.filter((conversation) => {
                if (!conversation || typeof conversation.id !== "string") return false;
                if (!isGuestConversationEmpty(conversation)) return true;
                if (!keptOneEmpty && conversation.id === keepEmptyId) {
                  keptOneEmpty = true;
                  return true;
                }
                removeGuestConversationStorage(conversation.id);
                return false;
              })
            : parsed;
          if (Array.isArray(parsed) && cleaned.length !== parsed.length) {
            localStorage.setItem("guest_conversations", JSON.stringify(cleaned));
          }
          setConversations(cleaned);

          // Restore the tab's previously open conversation (F5, crash
          // recovery) if it's still there -- inlined rather than calling
          // handleSelectConversation because `conversations` state from
          // setConversations above hasn't committed yet in this closure.
          const restoredConversation = savedChatId && Array.isArray(cleaned)
            ? cleaned.find((conversation) => conversation?.id === savedChatId)
            : null;
          if (restoredConversation) {
            setCurrentChatId(restoredConversation.id);
            const restoredModels = clampGuestSelectedModels(
              normalizeStringArray(
                restoredConversation.selectedModels,
                guestDefaultSelectedModels
              )
            );
            setSelectedModels(
              restoredModels.length ? restoredModels : guestDefaultSelectedModels
            );
            setDisabledPanels(
              normalizeStringArray(restoredConversation.disabledPanels, []).filter(
                (modelId: string) => restoredModels.includes(modelId)
              )
            );
          }
        } catch (e) {
          console.error("Failed to parse guest conversations:", e);
        }
      } else {
        const initialChatId = `guest_${Date.now()}`;
        const initialChat = {
          id: initialChatId,
          title: t("sidebar.newChat"),
            selectedModels: guestDefaultSelectedModels,
          disabledPanels: [],
          createdAt: new Date().toISOString(),
        };
        setConversations([initialChat]);
        setCurrentChatId(initialChatId);
        localStorage.setItem("guest_conversations", JSON.stringify([initialChat]));
      }

      setIsConversationsLoaded(true);
      setIsInitialConversationResolved(true);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [
    clampGuestSelectedModels,
    guestDefaultModelId,
    guestDefaultSelectedModels,
    isGuestMode,
    isGuestSettingsLoaded,
    refreshGuestUsage,
    t,
  ]);

  useEffect(() => {
    if (isGuestMode && isConversationsLoaded && conversations.length > 0) {
      localStorage.setItem("guest_conversations", JSON.stringify(conversations));
    }
  }, [conversations, isGuestMode, isConversationsLoaded]);

    useEffect(() => {
        if (
            isGuestMode ||
            !isUserSettingsLoaded ||
            !isConversationsLoaded ||
            conversations.length > 0 ||
            pendingGuestImportRef.current
        ) {
            return;
        }

        // A brand-new account (never had a conversation) inherits whatever
        // model configuration this browser's guest session was using, so
        // signing up doesn't feel like a downgrade from a 3-model comparison
        // back to a single default model. Only ever applied once.
        if (!guestCarryoverAppliedRef.current) {
            guestCarryoverAppliedRef.current = true;
            try {
                const savedGuestConversations = localStorage.getItem("guest_conversations");
                const parsedGuestConversations = savedGuestConversations
                    ? JSON.parse(savedGuestConversations)
                    : null;
                const lastGuestModels = Array.isArray(parsedGuestConversations)
                    ? parsedGuestConversations[0]?.selectedModels
                    : null;
                const carriedOverModels = Array.isArray(lastGuestModels)
                    ? clampSelectedModels(lastGuestModels.filter((id): id is string => typeof id === "string"))
                    : [];
                if (carriedOverModels.length > 0) {
                    queueMicrotask(() => setSelectedModels(carriedOverModels));
                }
            } catch (error) {
                console.error("Failed to read guest model configuration for carryover:", error);
            }
        }

        queueMicrotask(() => setIsInitialConversationResolved(true));
    }, [
        clampSelectedModels,
        conversations.length,
        isConversationsLoaded,
        isGuestMode,
        isUserSettingsLoaded,
    ]);

    useEffect(() => {
        const handleSettingsUpdated = (event: Event) => {
            const detail = (event as CustomEvent<UserSettingsUpdatedDetail>).detail;
            if (!detail || !isEnabledModelId(detail.defaultModel)) return;

            setUserDefaultEngine(detail.defaultModel);
            if (!currentChatId) {
                setSelectedModels([detail.defaultModel]);
                setDisabledPanels([]);
            }
        };

        window.addEventListener(
            USER_SETTINGS_UPDATED_EVENT,
            handleSettingsUpdated
        );
        return () => {
            window.removeEventListener(
                USER_SETTINGS_UPDATED_EVENT,
                handleSettingsUpdated
            );
        };
    }, [currentChatId, isEnabledModelId]);

  const fetchConversations = useCallback(async () => {
    if (!sessionUserId) return;

    try {
	  const res = await fetch(`/api/conversations`, { cache: "no-store" });
      if (res.ok) setConversations(await res.json());
    } catch (error) {
      console.error("Failed to load conversations:", error);
    } finally {
      setIsConversationsLoaded(true);
    }
    }, [sessionUserId]);

    useEffect(() => {
        if (sessionUserId) {
            queueMicrotask(() => setIsUserSettingsLoaded(false));
            queueMicrotask(() => setIsConversationsLoaded(false));
            queueMicrotask(() => setIsInitialConversationResolved(false));
            queueMicrotask(() => {
                void fetchConversations();
            });

            const urlLanguage = new URLSearchParams(window.location.search).get("lang");
            const settingsUrl = isLanguage(urlLanguage)
                ? `/api/user/settings?lang=${encodeURIComponent(urlLanguage)}`
                : "/api/user/settings";

            fetch(settingsUrl)
                .then((res) => {
                    if (!res.ok) throw new Error(`Settings load failed: ${res.status}`);
                    return res.json();
                })
                .then((data) => {
                    if (data && isEnabledModelId(data.defaultModel)) {
                        setUserDefaultEngine(data.defaultModel);
                        if (!currentChatIdRef.current) {
                            setSelectedModels(
                                data.isNewAccount
                                    ? newAccountDefaultSelectedModels
                                    : [data.defaultModel]
                            );
                        }
                    }

                    if (data && isThemePreference(data.theme)) {
                        storeAndApplyThemePreference(data.theme);
                    }

                    // The account's saved language always wins once we know it --
                    // ?lang= only ever seeds a brand-new account's row (see
                    // /api/user/settings), it never overrides an existing one, so
                    // there's no case where deferring to the URL here is correct.
                    // (A guest signing in from an English session used to get
                    // stuck in English even with a Korean account preference,
                    // because ?lang=en carried over from the guest callback URL
                    // suppressed this entirely.)
                    if (data && isLanguage(data.language)) {
                        setLang(data.language);
                        if (
                            isLanguage(urlLanguage) &&
                            urlLanguage !== data.language &&
                            typeof window !== "undefined"
                        ) {
                            const url = new URL(window.location.href);
                            url.searchParams.delete("lang");
                            window.history.replaceState(null, "", url.toString());
                        }
                    }

                    const detectedTimeZone = detectBrowserTimeZone();
                    if (detectedTimeZone && !data?.timeZoneInitializedAt) {
                        void fetch("/api/user/settings", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                timeZone: detectedTimeZone,
                                timeZoneSource: "browser",
                            }),
                        })
                            .then((response) => {
                                if (response.ok) notifyUserUsageChanged();
                            })
                            .catch((error) => {
                                console.error("Failed to initialize account time zone:", error);
                            });
                    }
                })
                .catch((err) => {
                    console.error("Failed to load user settings:", err);
                    setUserDefaultEngine(APP_DEFAULTS.defaultModelId);
                    if (!currentChatIdRef.current) {
                        setSelectedModels([APP_DEFAULTS.defaultModelId]);
                    }
                })
                .finally(() => setIsUserSettingsLoaded(true));
        } else if (status !== "loading") {
            queueMicrotask(() => setIsUserSettingsLoaded(true));
        }
    }, [
        fetchConversations,
        isEnabledModelId,
        newAccountDefaultSelectedModels,
        sessionUserId,
        setLang,
        status,
    ]);

    const handleNewChat = () => {
        localComparisonResponsesRef.current.clear();
        latestLocalComparisonPromptRef.current = null;
    if (isGuestMode) {
      const existingCurrent = conversations.find((c) => c.id === currentChatIdRef.current);
      if (
        currentChatIdRef.current &&
        existingCurrent &&
        isGuestConversationEmpty(existingCurrent)
      ) {
        // Already sitting on an empty draft -- reset it in place instead of
        // piling up another empty conversation (repeatedly clicking "New
        // Chat" used to create one every time, with no cap).
        removeGuestConversationStorage(existingCurrent.id);
        const resetChat = {
          ...existingCurrent,
          title: t("sidebar.autoGeneratedNewRoom"),
          selectedModels: guestDefaultSelectedModels,
          disabledPanels: [],
        };
        setConversations((prev) => prev.map((c) => (c.id === resetChat.id ? resetChat : c)));
      } else {
        const newGuestChat = {
          id: `guest_${Date.now()}`,
            title: t("sidebar.autoGeneratedNewRoom"),
            selectedModels: guestDefaultSelectedModels,
          disabledPanels: [],
          createdAt: new Date().toISOString(),
        };
          setConversations((prev) => [newGuestChat, ...prev]);
        setCurrentChatId(newGuestChat.id);
        currentChatIdRef.current = newGuestChat.id;
      }
    } else {
        currentChatIdRef.current = null;
        setCurrentChatId(null);
        setSelectedModels([userDefaultEngine]);
    }

    setDisabledPanels([]);
    setInputValue("");
      setPromptPayload(null);
      setIsInitialConversationResolved(true);

      setFocusToken((prev) => prev + 1);
  };

    const handleSelectConversation = async (id: string, skipLockCheck = false) => {
        if (isSending) return;
        localComparisonResponsesRef.current.clear();
        latestLocalComparisonPromptRef.current = null;

        if (!isGuestMode && !skipLockCheck) {
            const targetConv = conversations.find((c) => c.id === id);

            if (targetConv && targetConv.isLocked) {
                setLockedSelectDialog({ id, password: "", error: "" });
                return;

            }
        }

        if (isGuestMode) {
          const previousId = currentChatIdRef.current;
          if (previousId && previousId !== id) {
            const previousConv = conversations.find((c) => c.id === previousId);
            if (previousConv && isGuestConversationEmpty(previousConv)) {
              setConversations((prev) => prev.filter((c) => c.id !== previousId));
              removeGuestConversationStorage(previousId);
            }
          }
        }

	  currentChatIdRef.current = id;
      setCurrentChatId(id);
	  setPromptPayload(null);

    if (isGuestMode) {
      const targetConv = conversations.find((c) => c.id === id);
      if (targetConv) {
          const restoredModels = clampGuestSelectedModels(
            normalizeStringArray(
              targetConv.selectedModels,
              guestDefaultSelectedModels
            )
          );
          setSelectedModels(
            restoredModels.length
              ? restoredModels
              : guestDefaultSelectedModels
          );
          setDisabledPanels(
            normalizeStringArray(targetConv.disabledPanels, []).filter(
              (modelId) => restoredModels.includes(modelId)
            )
          );
        }
      return;
    }

    if (!sessionUserId) return;

	try {
	  const res = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
          applyConversationSettings(data, id);
	  }
    } catch (error) {
      console.error("Failed to load conversation settings:", error);
    }	

        setFocusToken((prev) => prev + 1);

    };

  // Consumes the "log in and continue this conversation" CTA's intent flag
  // (see lib/guestImport.ts) after a fresh, full-page login redirect lands
  // back here. Declared here (after handleSelectConversation/
  // fetchConversations/showToast) rather than up near the other early
  // effects because it calls all three. Still runs before the F5-restore
  // effect right below -- both fire in the same post-login render pass, and
  // this one is declared first, so it wins the race for currentChatId /
  // isInitialConversationResolved. Absence of the pending-intent flag means
  // either a plain guest session or a generic (non-CTA) login -- the latter
  // is handled by the modal-trigger effect declared further up.
  useEffect(() => {
    if (isGuestMode || !sessionUserId || !isUserSettingsLoaded) return;
    if (pendingGuestImportRef.current) return;

    const pending = consumePendingGuestImportIntent();
    if (!pending) return;

    const payload = buildGuestImportPayload(pending.conversationId);
    if (!payload || payload.messages.length === 0) return;

    pendingGuestImportRef.current = true;
    isInitialSelectedRef.current = true;

    queueMicrotask(async () => {
      const result = await importGuestConversation(payload);
      if (result.success) {
        await fetchConversations();
        void handleSelectConversation(result.conversationId);
        showToast(t("chat.guestImportCurrentSuccess"), "success");
      } else {
        showToast(t("chat.guestImportFailed"), "error");
      }
      setIsInitialConversationResolved(true);
      pendingGuestImportRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGuestMode, sessionUserId, isUserSettingsLoaded]);

  const handleGuestImportComplete = useCallback(
    async (conversationIdToOpen: string | null) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(GUEST_IMPORT_SEEN_KEY, "1");
      }
      await fetchConversations();
      if (conversationIdToOpen) {
        void handleSelectConversation(conversationIdToOpen);
      }
      setIsGuestImportModalOpen(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

    useEffect(() => {
        if (
            isGuestMode ||
            !isUserSettingsLoaded ||
            conversations.length === 0 ||
            currentChatId ||
            isInitialSelectedRef.current ||
            comparisonPresetRequestedRef.current ||
            new URLSearchParams(window.location.search).has("models") ||
            new URLSearchParams(window.location.search).has("prompt")
        ) return;

        isInitialSelectedRef.current = true;

        // A same-tab reload (F5, crash recovery) should return to whatever
        // conversation was open, not send the user back through the welcome
        // screen the way an actual new tab/session does. Only restore if the
        // saved id still belongs to this user's just-loaded conversation
        // list -- covers a deleted conversation, another user's leftover id
        // after a sign-out/sign-in in the same tab, etc. -- and
        // handleSelectConversation itself still re-prompts for a locked
        // conversation's password rather than silently opening it.
        const savedChatId = window.sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
        const restorableChatId =
            savedChatId && conversations.some((conversation) => conversation.id === savedChatId)
                ? savedChatId
                : null;

        // Returning users with nothing to restore land on the welcome-home
        // screen instead of having their most recent conversation
        // auto-opened (privacy + lets them choose continue-vs-new rather
        // than deciding for them). Existing conversations remain one tap
        // away via the sidebar / recent cards.
        queueMicrotask(() => {
            if (restorableChatId) {
                void handleSelectConversation(restorableChatId);
            }
            setIsInitialConversationResolved(true);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversations, currentChatId, isGuestMode, isUserSettingsLoaded]);

    const handleLock = async (id: string, password: string) => {
        try {
            const response = await fetch(`/api/conversations/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => null);
                showToast(
                    data?.code === "INVALID_LOCK_PASSWORD"
                        ? t("sidebar.passwordLength")
                        : t("sidebar.wrongPassword"),
                    "error"
                );
                return;
            }
            setConversations((prev) =>
                prev.map((c) => (c.id === id ? { ...c, isLocked: true } : c))
            );
        } catch (e) {
            console.error("Failed to lock conversation:", e);
        }
    };

    const submitUnlock = async (id: string, currentPassword: string) => {
        const targetConv = conversations.find((c) => c.id === id);
        if (!targetConv?.isLocked) return;

        try {
            const response = await fetch(`/api/conversations/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: null, currentPassword }),
            });
            if (!response.ok) {
                const data = await response.json().catch(() => null);
                setUnlockDialog({
                    id,
                    password: "",
                    error: data?.code === "LOCK_RATE_LIMITED"
                        ? t("sidebar.lockRateLimited")
                        : t("sidebar.wrongPassword"),
                });
                return;
            }
            setConversations((prev) =>
                prev.map((c) => (c.id === id ? { ...c, isLocked: false } : c))
            );
            setUnlockDialog(null);
        } catch (e) {
            console.error("Failed to unlock conversation:", e);
        }
    };

    const handleUnlock = async (id: string) => {
        const targetConv = conversations.find((c) => c.id === id);
        if (!targetConv?.isLocked) return;
        setUnlockDialog({ id, password: "", error: "" });
    };

  const handleRename = async (id: string, newTitle: string) => {
    if (isGuestMode) {
        setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c))
      );
    } else {      
      try {
        await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: newTitle }),
        });
        fetchConversations();
      } catch (error) {
        console.error("Failed to rename conversation:", error);
      }
    }
  };

  const executeDelete = async (id: string) => {
    if (isGuestMode) {
      const updated = conversations.filter((c) => c.id !== id);
      setConversations(updated);
      removeGuestConversationStorage(id);

      if (currentChatId === id) {
        setCurrentChatId(updated.length > 0 ? updated[0].id : null);
      }
      if (updated.length === 0) {
        localStorage.removeItem("guest_conversations");
      }
    } else {    
      try {
        await fetch(`/api/conversations/${id}`, {
          method: "DELETE",
        });
        
        if (currentChatId === id) {
          handleNewChat();
        }
        fetchConversations();
      } catch (error) {
        console.error("Failed to delete conversation:", error);
      }
    }
  };

  const handleDelete = async (id: string) => {
    setPendingDeleteId(id);
  };
  
  const persistModelSettingsToServer = async (
    pending: PendingModelSettingsSync
  ) => {
    modelSyncAbortRef.current?.abort();
    const controller = new AbortController();
    modelSyncAbortRef.current = controller;
    try {
      const response = await fetch(
        `/api/conversations/${pending.targetChatId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selectedModels: pending.models,
            disabledPanels: pending.disabled,
          }),
          signal: controller.signal,
        }
      );
      if (!response.ok) {
        throw new Error(`Model settings sync failed: ${response.status}`);
      }
      confirmedModelSettingsRef.current = pending;
      if (pendingModelSyncRef.current === pending) {
        pendingModelSyncRef.current = null;
      }
      return true;
    } catch (error: unknown) {
      const wasAborted = error instanceof Error && error.name === "AbortError";
      if (!wasAborted) {
        console.error("Failed to sync model settings:", error);
        if (pendingModelSyncRef.current === pending) {
          const confirmed = confirmedModelSettingsRef.current;
          if (confirmed?.targetChatId === pending.targetChatId) {
            setSelectedModels(confirmed.models);
            setDisabledPanels(confirmed.disabled);
          }
          pendingModelSyncRef.current = null;
        }
      }
      return false;
    } finally {
      if (modelSyncAbortRef.current === controller) {
        modelSyncAbortRef.current = null;
      }
    }
  };

  const syncModelSettingsToServer = (
    targetChatId: string,
    updatedModels: string[],
    updatedDisabled: string[]
  ) => {
    if (!targetChatId || !sessionUserId) {
      return;
    }

    if (modelSyncTimerRef.current) {
      clearTimeout(modelSyncTimerRef.current);
      modelSyncTimerRef.current = null;
    }
    modelSyncAbortRef.current?.abort();

    const models = clampSelectedModels(updatedModels);
    const pending: PendingModelSettingsSync = {
      targetChatId,
      models,
      disabled: uniqueStrings(updatedDisabled).filter((modelId) =>
        models.includes(modelId)
      ),
    };
    pendingModelSyncRef.current = pending;
    modelSyncTimerRef.current = setTimeout(() => {
      modelSyncTimerRef.current = null;
      void persistModelSettingsToServer(pending);
    }, 250);
  };

  const flushModelSettingsToServer = async (targetChatId: string) => {
    const pending = pendingModelSyncRef.current;
    if (!pending || pending.targetChatId !== targetChatId) return true;
    if (modelSyncTimerRef.current) {
      clearTimeout(modelSyncTimerRef.current);
      modelSyncTimerRef.current = null;
    }
    return persistModelSettingsToServer(pending);
  };

  const ensureModelSettingsReady = async (targetChatId: string) => {
    if (isGuestMode || !sessionUserId) {
      return true;
    }
    const ready = await flushModelSettingsToServer(targetChatId);
    if (ready) return true;

    const traceId = crypto.randomUUID();
    console.error(JSON.stringify({
      event: "chat_model_settings_flush_failed",
      traceId,
      conversationId: targetChatId,
    }));
    showToast(
      `${t("chat.comparisonPreflightFailed")} (${t("chat.traceId")}: ${traceId})`,
      "error"
    );
    return false;
  };

  useEffect(() => {
    if (
      comparisonPresetAppliedRef.current ||
      status === "loading" ||
      !isUserSettingsLoaded ||
      (isGuestMode && !isGuestSettingsLoaded)
    ) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const requestedModels = uniqueStrings(
      (params.get("models") || "")
        .split(",")
        .map((modelId) => modelId.trim())
        .filter(isEnabledModelId)
    ).slice(0, APP_DEFAULTS.maxSelectedModels);
    const requestedPrompt = (params.get("prompt") || "").trim().slice(0, 1200);

    if (requestedModels.length === 0 && !requestedPrompt) {
      comparisonPresetAppliedRef.current = true;
      return;
    }

    comparisonPresetRequestedRef.current = true;
    let cancelled = false;
    const presetModels = isGuestMode
      ? clampGuestSelectedModels(requestedModels)
      : clampSelectedModels(requestedModels).slice(0, maxSelectableModels);

    queueMicrotask(() => {
      if (cancelled) return;
      comparisonPresetAppliedRef.current = true;
      if (presetModels.length > 0) {
        setSelectedModels(presetModels);
        setDisabledPanels([]);
        if (currentChatId) {
          setConversations((current) =>
            current.map((conversation) =>
              conversation.id === currentChatId
                ? {
                    ...conversation,
                    selectedModels: presetModels,
                    disabledPanels: [],
                  }
                : conversation
            )
          );
        }
      }
      if (requestedPrompt) {
        setInputValue((current) => current || requestedPrompt);
      }

      params.delete("models");
      params.delete("prompt");
      params.delete("source");
      const nextSearch = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`
      );
    });

    return () => {
      cancelled = true;
    };
  }, [
    currentChatId,
    clampGuestSelectedModels,
    clampSelectedModels,
    isGuestMode,
    isGuestSettingsLoaded,
    isUserSettingsLoaded,
    maxSelectableModels,
    isEnabledModelId,
    status,
  ]);
  
  const handleGlobalSubmit = async () => {
    const trimmed = inputValue.trim();
    if ((!trimmed && attachments.length === 0) || selectedModels.length === 0) return;
    if (activeModelCount === 0) {
      showToast(t("chat.chooseModel"), "error");
      return;
    }
    const promptAttachments = await cloneAttachmentPreviews(attachments);
	
    if (isGuestMode) {
      const requestCredits = estimateWeightedRequestCredits(trimmed, promptAttachments);
      if (guestMessageCount + requestCredits > MAX_GUEST_MESSAGES) {
          showToast(t("sidebar.exceedDailyLimit"), "error");
        return;
      }
    }

	let activeChatId = currentChatId;

    if (!activeChatId) {
      if (isGuestMode) {
        // Reuse the conversation the guest-bootstrap effect already created
        // (and put in the sidebar's `conversations`/`guest_conversations`)
        // instead of a hardcoded id disconnected from it -- otherwise this
        // send saves its messages under a different key than the sidebar
        // entry points at, so clicking that entry after a refresh only ever
        // finds the placeholder welcome message.
        activeChatId = conversations[0]?.id;
        if (!activeChatId) {
          activeChatId = `guest_${Date.now()}`;
          const initialChat = {
            id: activeChatId,
            title: t("sidebar.newChat"),
            selectedModels,
            disabledPanels,
            createdAt: new Date().toISOString(),
          };
          setConversations([initialChat]);
          localStorage.setItem("guest_conversations", JSON.stringify([initialChat]));
        }
        setCurrentChatId(activeChatId);
      } else {
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            title: (trimmed || attachments[0]?.name || t("sidebar.newChat")).slice(0, 30),
            selectedModels,
            disabledPanels
          }),
        });
        
        if (res.ok) {
          const data = await res.json();
          activeChatId = data.id;
          confirmedModelSettingsRef.current = {
            targetChatId: data.id,
            models: clampSelectedModels(selectedModels),
            disabled: uniqueStrings(disabledPanels).filter((modelId) =>
              selectedModels.includes(modelId)
            ),
          };
          setCurrentChatId(activeChatId);
          fetchConversations();
        }
      } catch (error) {
        console.error("Failed to create conversation:", error);
        return;
      }
    }
    }
    
    if (activeChatId) {
      if (!isGuestMode) {
        const modelSettingsReady = await ensureModelSettingsReady(activeChatId);
        if (!modelSettingsReady) return;
      }
      const comparisonId = Date.now().toString();
      const preflightAllowed = await runComparisonPreflight({
        comparisonId,
        conversationId: activeChatId,
        prompt: trimmed,
        promptAttachments,
      });
      if (!preflightAllowed) return;
	  const userMsgId = crypto.randomUUID();
      const conversation = conversations.find((item) => item.id === activeChatId);
      const previousCount =
        promptCountsRef.current.get(activeChatId) ??
        (conversation?.messageCount ? 1 : 0);
      trackProductEvent(
        previousCount === 0 ? "chat_started" : "followup_sent",
        activeModelCount,
        { conversation_mode: isGuestMode ? "guest" : "account" }
      );
      promptCountsRef.current.set(activeChatId, previousCount + 1);

      if (!isGuestMode) {
      try {
        const saveResponse = await fetch(`/api/conversations/${activeChatId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            messages: [{
              id: userMsgId,
              role: "user",
              content: trimmed || attachments.map((item) => item.name).join(", "),
            }]
          }),
        });
        if (!saveResponse.ok) {
          console.error("Failed to pre-save user message:", saveResponse.status);
        }
      } catch (e) {
        console.error("Failed to pre-save user message:", e);
      }
    }

      localComparisonQuestionsRef.current.set(comparisonId, trimmed);
      setPromptPayload({
        id: comparisonId,
        text: trimmed,
        chatId: activeChatId,
        userMessageId: userMsgId,
        attachments: promptAttachments,
      });
      setInputValue("");
      setAttachments([]);
      setConversations((current) =>
        current.map((item) =>
          item.id === activeChatId
            ? { ...item, messageCount: (item.messageCount || 0) + 1 }
            : item
        )
      );
    }
  };

  const handleAttachmentsChange = useCallback(
    (nextAttachments: ChatAttachment[]) => {
      const addedCount = Math.max(0, nextAttachments.length - attachments.length);
      if (addedCount > 0) {
        trackProductEvent("file_attached", activeModelCount, {
          attachment_count: addedCount,
        });
      }
      setAttachments(nextAttachments);
    },
    [activeModelCount, attachments.length]
  );

  const maybeShowValueUpgradePrompt = useCallback(
    (source: "comparison" | "ai_review") => {
      if (isGuestMode || accountUsage?.plan !== "Free") return;
      const storageKey = "tomverse_value_upgrade_prompt_seen_v1";
      if (localStorage.getItem(storageKey) === "1") return;
      setValueUpgradeSource(source);
    },
    [accountUsage?.plan, isGuestMode]
  );

  useEffect(() => {
    if (!valueUpgradeSource) return;
    localStorage.setItem("tomverse_value_upgrade_prompt_seen_v1", "1");
  }, [valueUpgradeSource]);

  const maybeShowGuestSaveCompareCard = useCallback(() => {
    if (!isGuestMode || !isGuestPreviewEntry) return;
    if (localStorage.getItem("tomverse_guest_save_compare_seen_v1") === "1") return;
    setShowGuestSaveCompareCard(true);
  }, [isGuestMode, isGuestPreviewEntry]);

  useEffect(() => {
    if (!showGuestSaveCompareCard) return;
    localStorage.setItem("tomverse_guest_save_compare_seen_v1", "1");
  }, [showGuestSaveCompareCard]);

  const maybeShowGuestSaveReviewCard = useCallback(() => {
    if (!isGuestMode || !isGuestPreviewEntry) return;
    if (localStorage.getItem("tomverse_guest_save_review_seen_v1") === "1") return;
    setShowGuestSaveReviewCard(true);
  }, [isGuestMode, isGuestPreviewEntry]);

  useEffect(() => {
    if (!showGuestSaveReviewCard) return;
    localStorage.setItem("tomverse_guest_save_review_seen_v1", "1");
  }, [showGuestSaveReviewCard]);

  const handleResponseComplete = useCallback(
    (promptId: string | null, modelId: string, responseText: string) => {
      if (promptId && responseText.trim()) {
        const responses =
          localComparisonResponsesRef.current.get(promptId) ||
          new Map<string, string>();
        responses.set(modelId, responseText);
        localComparisonResponsesRef.current.set(promptId, responses);
        latestLocalComparisonPromptRef.current = promptId;
      }
      if (isGuestMode) {
        refreshGuestUsage();
      } else {
        notifyUserUsageChanged();
      }
      trackProductEventOnce(
        "first_response_completed",
        "first_response_completed",
        activeModelCount,
        { model_id: modelId }
      );
      if (!promptId || activeModelCount < 2) return;

      const completedModels =
        comparisonCompletionsRef.current.get(promptId) || new Set<string>();
      completedModels.add(modelId);
      comparisonCompletionsRef.current.set(promptId, completedModels);
      if (
        completedModels.size >= activeModelCount &&
        !comparisonTrackedRef.current.has(promptId)
      ) {
        comparisonTrackedRef.current.add(promptId);
        trackProductEvent(
          "multi_model_compare_completed",
          activeModelCount
        );
        if (isGuestMode) {
          maybeShowGuestSaveCompareCard();
        } else {
          maybeShowValueUpgradePrompt("comparison");
        }
      }
    },
    [
      activeModelCount,
      isGuestMode,
      maybeShowGuestSaveCompareCard,
      maybeShowValueUpgradePrompt,
      refreshGuestUsage,
    ]
  );

  const handleModelFollowupSent = useCallback(
    (modelId: string) => {
      trackProductEvent("followup_sent", activeModelCount, {
        model_id: modelId,
      });
    },
    [activeModelCount]
  );

  const toggleModel = (modelId: string) => {
    const model = getModel(modelId);
    const isSelected = selectedModels.includes(modelId);
    if (
      !isSelected &&
      (!model || !canUseModelWithPlan(currentAccessPlan, model))
    ) {
      if (!model) return false;
      if (isGuestMode) {
        setShowGuestSignInPrompt(true);
      } else {
        setUpgradeModelPrompt(model);
      }
      return false;
    }
    if (
      isGuestMode &&
      !isSelected &&
      !clampGuestSelectedModels([modelId]).includes(modelId)
    ) {
      return false;
    }
	let nextModels = [...selectedModels];
    let nextDisabled = [...disabledPanels];

	if (nextModels.includes(modelId)) {
      if (nextModels.length === 1) return false; 
      nextModels = nextModels.filter((id) => id !== modelId);
      nextDisabled = nextDisabled.filter((id) => id !== modelId);
    } else {
        const maxModels = maxSelectableModels;
        if (nextModels.length >= maxModels) {
            showToast(isGuestMode ? t("chat.maxGuestModelCompare") : t("chat.maxModelCompare"), "info");
            return false;
        }

        nextModels.push(modelId);
      }
    
    nextModels = isGuestMode
      ? clampGuestSelectedModels(nextModels)
      : clampSelectedModels(nextModels).slice(0, maxSelectableModels);
	setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
    if (currentChatId) {
      syncModelSettingsToServer(currentChatId, nextModels, nextDisabled);
    }
    return true;
  };

  // Swaps one already-selected model for another in a single state update --
  // used when the picker is already at the model cap, so the two selections
  // change atomically instead of racing two separate toggleModel() calls
  // against the same stale selectedModels closure.
  const swapSelectedModel = (removeModelId: string, addModelId: string) => {
    const model = getModel(addModelId);
    if (!model) return false;
    if (!canUseModelWithPlan(currentAccessPlan, model)) {
      if (isGuestMode) {
        setShowGuestSignInPrompt(true);
      } else {
        setUpgradeModelPrompt(model);
      }
      return false;
    }
    if (isGuestMode && !clampGuestSelectedModels([addModelId]).includes(addModelId)) {
      return false;
    }
    let nextModels = selectedModels.filter((id) => id !== removeModelId);
    nextModels.push(addModelId);
    nextModels = isGuestMode
      ? clampGuestSelectedModels(nextModels)
      : clampSelectedModels(nextModels).slice(0, maxSelectableModels);
    const nextDisabled = disabledPanels.filter((id) => id !== removeModelId);
    setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
    if (currentChatId) {
      syncModelSettingsToServer(currentChatId, nextModels, nextDisabled);
    }
    return true;
  };

  const handleModelFinderComplete = ({
      modelIds,
      promptExample,
    }: {
      modelIds: string[];
      promptExample?: string;
    }) => {
      const nextModels = clampSelectedModels(
        modelIds.filter(isEnabledModelId)
      ).slice(0, maxSelectableModels);
      const applied = nextModels.length ? nextModels : selectedModels;

      // Land the recommended combination on a fresh chat instead of
      // swapping the models under an already-active conversation, which
      // would silently drop whatever models the user had mid-conversation.
      localComparisonResponsesRef.current.clear();
      latestLocalComparisonPromptRef.current = null;
      currentChatIdRef.current = null;
      setCurrentChatId(null);
      setUserDefaultEngine(applied[0]);
      setSelectedModels(applied);
      setDisabledPanels([]);
      setPersonalizedPrompt(promptExample || null);
      setInputValue("");
      setPromptPayload(null);
      setFocusToken((current) => current + 1);
    };

  const handleRemoveModel = async (modelId: string) => {
    setPendingRemoveModelId(modelId);
  };

  const executeRemoveModel = async (modelId: string) => {
    const nextModels = selectedModels.filter((id) => id !== modelId);
    const nextDisabled = disabledPanels.filter((id) => id !== modelId);
    
    setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
    
    if (currentChatId) {
      syncModelSettingsToServer(currentChatId, nextModels, nextDisabled);
      try {
        await fetch(`/api/conversations/${currentChatId}/messages?modelId=${modelId}`, {
          method: "DELETE"
        });
      } catch (error) {
        console.error("Failed to delete model history:", error);
      }
    }
  };

  const togglePanelDisable = (modelId: string) => {
    setDisabledPanels((currentDisabled) => {
      const nextDisabled = currentDisabled.includes(modelId)
        ? currentDisabled.filter((id) => id !== modelId)
        : [...currentDisabled, modelId];

      if (currentChatId) {
        syncModelSettingsToServer(currentChatId, selectedModels, nextDisabled);
      }
      return nextDisabled;
    });
  };
  
  const changePanelModel = (oldModelId: string, newModelId: string) => {
    if (newModelId !== oldModelId && selectedModels.includes(newModelId)) {
      return;
    }
    const nextModel = getModel(newModelId);
    if (!nextModel || !canUseModelWithPlan(currentAccessPlan, nextModel)) {
      if (nextModel && !isGuestMode) {
        setUpgradeModelPrompt(nextModel);
      } else {
        showToast(t("modelStatusReasons.loginRequired"), "info");
      }
      return;
    }
    const nextModels = clampSelectedModels(
      selectedModels.map((id) => (id === oldModelId ? newModelId : id))
    );
    let nextDisabled = [...disabledPanels];
    
    if (nextDisabled.includes(oldModelId)) {
      nextDisabled = [...nextDisabled.filter((id) => id !== oldModelId), newModelId];
    }

    setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
	if (currentChatId) syncModelSettingsToServer(currentChatId, nextModels, nextDisabled);
  };  
  
    const blendedConversations = conversations; 
  
    const handleDownloadConversation = (convId: string) => {
        if (isGuestMode) return;
        window.location.href = `/api/conversations/${convId}/export`;
    };

    const handleShareConversation = async (convId: string) => {
        if (isGuestMode) return;

        try {
            const res = await fetch(`/api/conversations/${convId}/share`, {
                method: "POST",
            });
            const data = await res.json().catch(() => null);

            if (!res.ok) {
                showToast(
                    res.status === 423 ||
                        data?.code === "CONVERSATION_LOCKED"
                        ? t("sidebar.shareLocked")
                        : t("sidebar.shareFailed"),
                    "error"
                );
                return;
            }

            setConversations((prev) =>
                prev.map((conversation) =>
                    conversation.id === convId
                        ? {
                            ...conversation,
                            shareEnabled: true,
                            shareExpiresAt: data.expiresAt || null,
                        }
                        : conversation
                )
            );
            const sharedConversation = conversations.find(
              (conversation) => conversation.id === convId
            );
            const sharedModelCount = Math.max(
              1,
              (sharedConversation?.selectedModels || selectedModels).filter(
                (modelId) =>
                  !(sharedConversation?.disabledPanels || disabledPanels).includes(
                    modelId
                  )
              ).length
            );
            trackProductEvent("share_created", sharedModelCount, {
              conversation_mode: "account",
            });
            await navigator.clipboard.writeText(data.url);
            showToast(t("sidebar.shareCopied"), "success");
        } catch {
            showToast(t("sidebar.shareFailed"), "error");
        }
    };

    const handleRevokeShare = async (convId: string) => {
        if (isGuestMode) {
            return;
        }
        setPendingRevokeShareId(convId);
    };

    const executeRevokeShare = async (convId: string) => {
        const response = await fetch(
            `/api/conversations/${convId}/share`,
            { method: "DELETE" }
        );
        if (!response.ok) {
            showToast(t("sidebar.shareRevokeFailed"), "error");
            return;
        }

        setConversations((prev) =>
            prev.map((conversation) =>
                conversation.id === convId
                    ? {
                        ...conversation,
                        shareEnabled: false,
                        shareExpiresAt: null,
                    }
                    : conversation
            )
        );
        showToast(t("sidebar.shareRevoked"), "success");
    };

    const executeCompareSummary = async (conversationId: string) => {
      setIsCompareSummaryLoading(true);
      try {
        const response = await fetch(
          `/api/conversations/${conversationId}/compare-summary`,
          { method: "POST", cache: "no-store" }
        );
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { code?: string }
            | null;
          const message =
            payload?.code === "COMPARISON_RESPONSES_REQUIRED"
              ? t("chat.aiReviewResponsesRequired")
              : payload?.code === "API_RATE_LIMITED"
                ? t("chat.compareRateLimited")
                : payload?.code === "QUICK_COMPARISON_REVIEWER_UNAVAILABLE"
                  ? t("chat.compareServiceUnavailable")
                  : payload?.code === "QUICK_COMPARISON_FAILED"
                    ? t("chat.compareGenerationFailed")
                    : t("chat.compareUnavailable");
          showToast(message, "error");
          return;
        }
        setCompareSummary(await response.json());
        maybeShowValueUpgradePrompt("comparison");
      } catch {
        showToast(t("chat.compareUnavailable"), "error");
      } finally {
        setIsCompareSummaryLoading(false);
      }
    };

    const guestCompareSummaryErrorMessage = (code?: string) =>
      code === "GUEST_QUICK_SUMMARY_LIMIT_REACHED"
        ? t("chat.guestQuickSummaryLimitReached")
        : code === "API_RATE_LIMITED"
          ? t("chat.compareRateLimited")
          : code === "QUICK_COMPARISON_REVIEWER_UNAVAILABLE"
            ? t("chat.compareServiceUnavailable")
            : code === "QUICK_COMPARISON_FAILED"
              ? t("chat.compareGenerationFailed")
              : t("chat.compareUnavailable");

    const executeGuestCompareSummary = async () => {
      const promptId = latestLocalComparisonPromptRef.current;
      const question = promptId
        ? localComparisonQuestionsRef.current.get(promptId)
        : undefined;
      const responseMap = promptId
        ? localComparisonResponsesRef.current.get(promptId)
        : undefined;
      if (!promptId || !question || !responseMap || responseMap.size < 2) {
        showToast(t("chat.aiReviewResponsesRequired"), "info");
        return;
      }
      setIsCompareSummaryLoading(true);
      try {
        const responses = Array.from(responseMap.entries()).map(
          ([modelId, content]) => ({
            messageId: `${promptId}:${modelId}`,
            modelId,
            content,
          })
        );
        const sendRequest = (turnstileToken?: string) =>
          fetch("/api/chat/compare-summary", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
              question,
              responses,
              language: lang,
              ...(turnstileToken ? { turnstileToken } : {}),
            }),
          });

        let response = await sendRequest();
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { code?: string }
            | null;
          if (payload?.code === "TURNSTILE_REQUIRED") {
            const turnstileToken = await getGuestQuickSummaryTurnstileToken();
            response = await sendRequest(turnstileToken);
            if (!response.ok) {
              const retryPayload = (await response.json().catch(() => null)) as
                | { code?: string }
                | null;
              showToast(guestCompareSummaryErrorMessage(retryPayload?.code), "error");
              return;
            }
          } else {
            showToast(guestCompareSummaryErrorMessage(payload?.code), "error");
            return;
          }
        }
        setCompareSummary(await response.json());
        maybeShowGuestSaveReviewCard();
      } catch {
        showToast(t("chat.compareUnavailable"), "error");
      } finally {
        setIsCompareSummaryLoading(false);
      }
    };

    const handleCompareSummary = async () => {
      if (!currentChatId || isCompareSummaryLoading) return;
      if (isGuestMode) {
        await executeGuestCompareSummary();
        return;
      }
      await executeCompareSummary(currentChatId);
    };

  const pendingRemoveModel = pendingRemoveModelId
    ? AVAILABLE_MODELS.find((model) => model.id === pendingRemoveModelId)
    : null;
  const pendingDeleteConversation = pendingDeleteId
    ? conversations.find((conversation) => conversation.id === pendingDeleteId)
    : null;
  const pendingRevokeConversation = pendingRevokeShareId
    ? conversations.find((conversation) => conversation.id === pendingRevokeShareId)
    : null;
  const ToastIcon =
    toast?.tone === "success"
      ? CheckCircle2
      : toast?.tone === "error"
        ? AlertCircle
        : Info;
  const trialCopy = guestTrialCopy[lang];
  const guestCompareSignInHref = `/auth/signin?callbackUrl=${encodeURIComponent(
    `/chat?lang=${encodeURIComponent(lang)}`
  )}`;

  return (
    <>
      <ModelFinder
        enabled={Boolean(sessionUserId && isUserSettingsLoaded)}
        onComplete={handleModelFinderComplete}
      />
      <GuestImportModal
        open={isGuestImportModalOpen}
        conversations={guestImportCandidates}
        defaultConversationId={guestImportDefaultId}
        onSkip={() => closeGuestImportModal(true)}
        onComplete={handleGuestImportComplete}
      />
      {isGuestMode ? (
        <div
          ref={guestQuickSummaryTurnstileContainerRef}
          className="fixed bottom-2 right-2 z-[70]"
        />
      ) : null}
      {!isViewportReady ? (
        <ChatShellSkeleton label={t("auth.loading")} />
      ) : isMobileViewport ? (
        <MobileChatShell
          conversations={blendedConversations}
          currentChatId={currentChatId}
          selectedModels={selectedModels}
          disabledPanels={effectiveDisabledPanels}
          promptPayload={promptPayload}
          inputValue={inputValue}
          setInputValue={setInputValue}
          personalizedPrompt={personalizedPrompt}
          attachments={attachments}
          setAttachments={handleAttachmentsChange}
          isSending={isSending}
          focusToken={focusToken}
          isGuestMode={isGuestMode}
          guestPreviewMode={isGuestPreviewEntry}
          guestMessageCount={guestMessageCount}
          maxGuestMessages={MAX_GUEST_MESSAGES}
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onRename={handleRename}
          onDelete={handleDelete}
          onLock={handleLock}
          onUnlock={handleUnlock}
          onShare={handleShareConversation}
          onRevokeShare={handleRevokeShare}
          onDownload={handleDownloadConversation}
          onToggleModel={toggleModel}
          onSwapModel={swapSelectedModel}
          onRequestUndoToast={(message, undo) =>
            showToast(message, "info", { label: t("chat.undo"), onClick: undo })
          }
          onSubmit={handleGlobalSubmit}
          onBeforeModelSend={ensureModelSettingsReady}
          onCompareSummary={handleCompareSummary}
          isCompareSummaryLoading={isCompareSummaryLoading}
          onComparisonReview={() => setShowComparisonReview(true)}
          onGuestSignInPrompt={() => setShowGuestSignInPrompt(true)}
          onResponseComplete={handleResponseComplete}
          onFollowupSent={handleModelFollowupSent}
        />
      ) : (
        <DesktopChatShell
          conversations={blendedConversations}
          currentChatId={currentChatId}
          selectedModels={selectedModels}
          disabledPanels={effectiveDisabledPanels}
          promptPayload={promptPayload}
          inputValue={inputValue}
          setInputValue={setInputValue}
          personalizedPrompt={personalizedPrompt}
          attachments={attachments}
          setAttachments={handleAttachmentsChange}
          isSending={isSending}
          focusToken={focusToken}
          isGuestMode={isGuestMode}
          guestPreviewMode={isGuestPreviewEntry}
          guestMessageCount={guestMessageCount}
          maxGuestMessages={MAX_GUEST_MESSAGES}
          isModelSelectionReady={
            isGuestMode ||
            (isUserSettingsLoaded &&
              isConversationsLoaded &&
              isInitialConversationResolved)
          }
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onRename={handleRename}
          onDelete={handleDelete}
          onLock={handleLock}
          onUnlock={handleUnlock}
          onShare={handleShareConversation}
          onRevokeShare={handleRevokeShare}
          onDownload={handleDownloadConversation}
          onToggleModel={toggleModel}
          onSwapModel={swapSelectedModel}
          onSubmit={handleGlobalSubmit}
          onBeforeModelSend={ensureModelSettingsReady}
          onChangePanelModel={changePanelModel}
          onTogglePanelDisable={togglePanelDisable}
          onRemoveModel={handleRemoveModel}
          onCompareSummary={handleCompareSummary}
          isCompareSummaryLoading={isCompareSummaryLoading}
          onComparisonReview={() => setShowComparisonReview(true)}
          onGuestSignInPrompt={() => setShowGuestSignInPrompt(true)}
          onResponseComplete={handleResponseComplete}
          onFollowupSent={handleModelFollowupSent}
        />
      )}
    {showGuestSignInPrompt && isGuestMode && (
      <div className="fixed inset-0 z-[78] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="guest-compare-signin-title"
          className="w-full max-w-sm rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 id="guest-compare-signin-title" className="mt-4 text-xl font-black">{trialCopy.title}</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{trialCopy.body}</p>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <a
              href={guestCompareSignInHref}
              onClick={() => {
                trackProductEvent("signup_started", 1, {
                  trigger: "proactive",
                  cta_location: "guest_multi_model",
                });
                if (currentChatId) writePendingGuestImportIntent(currentChatId);
              }}
              className="flex min-h-11 flex-col items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-center text-white hover:bg-blue-500"
            >
              <span className="text-sm font-black">{t("chat.continueConversationCta")}</span>
              <span className="text-[11px] font-medium text-blue-100">
                {t("chat.continueConversationCtaSubtext")}
              </span>
            </a>
            <button
              type="button"
              onClick={() => setShowGuestSignInPrompt(false)}
              className="min-h-11 rounded-xl border border-zinc-200 px-4 py-2 text-sm font-bold text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {trialCopy.cancel}
            </button>
          </div>
        </section>
      </div>
    )}
    {toast && (
      <div
        key={toast.id}
        role="status"
        aria-live="polite"
        className="fixed bottom-5 left-1/2 z-[70] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold text-zinc-900 shadow-2xl shadow-zinc-900/15 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${
            toast.tone === "success"
              ? "bg-emerald-500/10 text-emerald-500"
              : toast.tone === "error"
                ? "bg-red-500/10 text-red-500"
                : "bg-blue-500/10 text-blue-500"
          }`}
        >
          <ToastIcon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 whitespace-pre-line break-words">{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              setToast(null);
              if (toastTimerRef.current) {
                clearTimeout(toastTimerRef.current);
                toastTimerRef.current = null;
              }
            }}
            className="shrink-0 rounded-lg px-2 py-1 text-sm font-black text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
          >
            {toast.action.label}
          </button>
        )}
      </div>
    )}
    {upgradeModelPrompt && accountUsage && (
      <div className="fixed inset-0 z-[78] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="locked-model-upgrade-title"
          className="w-full max-w-sm rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2
            id="locked-model-upgrade-title"
            className="mt-4 text-lg font-black text-zinc-950 dark:text-white"
          >
            {t("upgrade.lockedModelTitle")}
          </h2>
          <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            {formatCopy("upgrade.lockedModelBody", {
              model: upgradeModelPrompt.name,
            })}
          </p>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <UpgradeCtaLink
              targetPlan="Pro"
              currentPlan={accountUsage.plan}
              trigger="proactive"
              ctaLocation="chat_locked_model"
              planCreditsRemaining={accountUsage.balances.planRemainingCredits}
              addonCreditsRemaining={accountUsage.balances.purchasedRemainingCredits}
              testId="locked-model-plan-cta"
              onClick={() => setUpgradeModelPrompt(null)}
              className="flex min-h-11 items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white hover:bg-blue-500"
            >
              {t("upgrade.viewProPlan")}
            </UpgradeCtaLink>
            <button
              type="button"
              onClick={() => setUpgradeModelPrompt(null)}
              data-testid="locked-model-choose-another"
              className="min-h-11 rounded-xl border border-zinc-200 px-4 py-2 text-sm font-bold text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {t("upgrade.chooseAnotherModel")}
            </button>
          </div>
        </section>
      </div>
    )}
    {valueUpgradeSource && accountUsage?.plan === "Free" && (
      <aside
        data-testid="value-upgrade-prompt"
        className="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[76] mx-auto w-auto max-w-sm rounded-2xl border border-blue-200 bg-white p-4 shadow-2xl shadow-zinc-900/20 dark:border-blue-900/60 dark:bg-zinc-900 md:inset-x-auto md:right-5 md:top-5 md:w-[22rem]"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black text-zinc-950 dark:text-white">
              {t("upgrade.valuePromptTitle")}
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
              {t("upgrade.valuePromptBody")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setValueUpgradeSource(null)}
            aria-label={t("auth.cancel")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <UpgradeCtaLink
          targetPlan="Pro"
          currentPlan="Free"
          trigger="proactive"
          ctaLocation={`chat_value_moment_${valueUpgradeSource}`}
          planCreditsRemaining={accountUsage.balances.planRemainingCredits}
          addonCreditsRemaining={accountUsage.balances.purchasedRemainingCredits}
          onClick={() => setValueUpgradeSource(null)}
          className="mt-3 flex min-h-10 w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white hover:bg-blue-500"
        >
          {t("upgrade.compareProPlan")}
        </UpgradeCtaLink>
      </aside>
    )}
    {showGuestSaveCompareCard && (
      <aside
        data-testid="guest-save-compare-prompt"
        className="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[76] mx-auto w-auto max-w-sm rounded-2xl border border-blue-200 bg-white p-4 shadow-2xl shadow-zinc-900/20 dark:border-blue-900/60 dark:bg-zinc-900 md:inset-x-auto md:right-5 md:top-5 md:w-[22rem]"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black text-zinc-950 dark:text-white">
              {t("chat.guestSaveCompareTitle")}
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
              {t("chat.guestSaveCompareBody")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowGuestSaveCompareCard(false)}
            aria-label={t("auth.cancel")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <a
            href={guestCompareSignInHref}
            data-testid="guest-save-compare-cta"
            onClick={() => {
              trackProductEvent("signup_started", 1, {
                trigger: "proactive",
                cta_location: "guest_save_compare",
              });
              if (currentChatId) writePendingGuestImportIntent(currentChatId);
              setShowGuestSaveCompareCard(false);
            }}
            className="flex min-h-10 items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-center text-xs font-black text-white hover:bg-blue-500"
          >
            {t("chat.guestSaveCompareCta")}
          </a>
          <button
            type="button"
            onClick={() => setShowGuestSaveCompareCard(false)}
            className="min-h-10 rounded-xl border border-zinc-200 px-3 py-2 text-xs font-bold text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {t("chat.guestSaveCompareDismiss")}
          </button>
        </div>
      </aside>
    )}
    {billingSuccess && (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={
            billingSuccess.accessType === "founding_tester_pass"
              ? t("billing.testerPassActivatedEyebrow")
              : t("billing.paymentSuccessfulEyebrow")
          }
          className="relative w-full max-w-lg overflow-hidden rounded-3xl border border-blue-400/30 bg-zinc-950 text-white shadow-2xl shadow-blue-950/40"
        >
          <div className="absolute inset-x-0 top-0 h-56 bg-gradient-to-br from-blue-500/35 via-cyan-400/15 to-purple-500/25 sm:h-52" />
          <div className="relative px-6 pb-7 pt-6 sm:px-8 sm:pb-8 sm:pt-8">
            <div className="flex items-start justify-between gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500 text-white shadow-lg shadow-blue-500/30">
                <Sparkles className="h-7 w-7" aria-hidden="true" />
              </div>
              <button
                type="button"
                onClick={() => setBillingSuccess(null)}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-zinc-300 transition hover:bg-white/10 hover:text-white"
              >
                {t("billing.close")}
              </button>
            </div>

            <div className="mt-6 sm:mt-7">
              <p className="pb-1 text-xs font-black uppercase leading-none tracking-[0.24em] text-blue-100">
                {billingSuccess.accessType === "founding_tester_pass"
                  ? t("billing.testerPassActivatedEyebrow")
                  : t("billing.paymentSuccessfulEyebrow")}
              </p>
              <h2 className="mt-3 text-[2rem] font-black leading-tight tracking-tight sm:text-4xl">
                {billingSuccess.accessType === "founding_tester_pass"
                  ? t("billing.testerPassActivatedTitle")
                  : t("billing.paymentSuccessfulTitle")}
              </h2>
              <p className="mt-4 text-base leading-7 text-zinc-300">
                {formatCopy(
                  billingSuccess.accessType === "founding_tester_pass"
                    ? "billing.testerPassActivatedWelcome"
                    : "billing.paymentSuccessfulWelcome",
                  {
                  plan: billingSuccess.plan || t("billing.upgradedPlanFallback"),
                  }
                )}
              </p>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="text-xs font-semibold text-zinc-400">{t("billing.plan")}</p>
                <p className="mt-1 text-lg font-black">
                  {billingSuccess.plan || t("billing.upgradedPlanFallback")}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <p className="text-xs font-semibold text-zinc-400">{t("billing.billing")}</p>
                <p className="mt-1 text-lg font-black">
                  {billingSuccess.accessType === "founding_tester_pass"
                    ? t("billing.testerPassBillingLabel")
                    : billingSuccess.interval === "annual"
                      ? t("billing.intervalAnnual")
                      : t("billing.intervalMonthly")}
                </p>
              </div>
              <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-4">
                <p className="text-xs font-semibold text-emerald-200">{t("billing.status")}</p>
                <p className="mt-1 text-lg font-black text-emerald-200">{t("billing.active")}</p>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-blue-400/20 bg-blue-500/10 p-4 text-sm leading-6 text-blue-100">
              {billingSuccess.accessType === "founding_tester_pass"
                ? t("billing.testerPassNotice")
                : t("billing.webhookNotice")}
            </div>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => setBillingSuccess(null)}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 text-sm font-black text-white transition hover:bg-blue-500"
              >
                {t("billing.startTomverse")}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setBillingSuccess(null);
                  showToast(t("billing.checkPlanToast"), "info");
                }}
                className="inline-flex flex-1 items-center justify-center rounded-2xl border border-white/10 px-5 py-3 text-sm font-black text-zinc-200 transition hover:bg-white/10 hover:text-white"
              >
                {t("billing.checkPlan")}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    {pendingDeleteId && (
      <ConfirmDialog
        title={t("sidebar.delete")}
        description={t("sidebar.deleteConfirm")}
        detail={pendingDeleteConversation?.title}
        confirmLabel={t("sidebar.delete")}
        cancelLabel={t("auth.cancel")}
        danger
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={async () => {
          const id = pendingDeleteId;
          setPendingDeleteId(null);
          await executeDelete(id);
        }}
      />
    )}
    {isCompareSummaryLoading && (
      <div className="fixed inset-0 z-[79] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
        <div
          role="status"
          data-testid="quick-comparison-loading"
          aria-live="polite"
          className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-5 py-4 text-sm font-bold text-zinc-900 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
        >
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" aria-hidden="true" />
          {compareSummaryStage === 0
            ? t("chat.quickDifferenceSummaryLoading")
            : t("chat.quickDifferenceSummaryLoadingStage2")}
        </div>
      </div>
    )}
    {compareSummary && (
      <div className="fixed inset-x-0 top-0 z-50 flex h-[100dvh] items-center justify-center overflow-hidden bg-black/60 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:p-4">
        <section
          role="dialog"
          data-testid="quick-comparison-dialog"
          aria-modal="true"
          aria-labelledby="model-comparison-title"
          aria-describedby="model-comparison-note"
          className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-200 p-4 dark:border-zinc-800 sm:p-5">
            <div className="min-w-0">
              <h2 id="model-comparison-title" className="text-lg font-black text-zinc-900 dark:text-zinc-100">
                {t("chat.quickDifferenceSummary")}
              </h2>
              <p id="model-comparison-note" className="mt-1 text-sm leading-5 text-zinc-500">
                {compareSummary.cached
                  ? formatCopy("chat.quickDifferenceSummaryCachedNote", {
                      credits: String(compareSummary.originalUsageCredits || 0),
                    })
                  : formatCopy("chat.quickDifferenceSummaryNote", {
                      credits: String(compareSummary.usageCredits),
                    })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCompareSummary(null)}
              className="min-h-11 shrink-0 rounded-lg px-3 py-2 text-sm font-bold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              {t("auth.cancel")}
            </button>
          </div>
          <div className="grid min-h-0 flex-1 touch-pan-y gap-4 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable] sm:p-5">
            <section data-testid="quick-summary-consensus" className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-900/70 dark:bg-blue-950/30">
              <h3 className="text-sm font-black text-blue-950 dark:text-blue-100">
                {t("chat.quickSummaryCommonConclusions")}
              </h3>
              <ul className="mt-3 grid gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
                {compareSummary.result.commonConclusions.map((item, index) => (
                  <li key={`${index}-${item}`} className="flex gap-2">
                    <span className="font-black text-blue-600" aria-hidden="true">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section data-testid="quick-summary-differences" className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <h3 className="text-sm font-black text-zinc-900 dark:text-zinc-100">
                {t("chat.quickSummaryImportantDifferences")}
              </h3>
              {compareSummary.result.importantDifferences.length ? (
                <ol className="mt-3 grid gap-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                  {compareSummary.result.importantDifferences.map((item, index) => (
                    <li key={`${index}-${item}`} className="flex gap-3">
                      <span className="font-black text-zinc-400">{index + 1}.</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-sm text-zinc-500">{t("chat.quickSummaryNoMeaningfulDifferences")}</p>
              )}
            </section>

            <section data-testid="quick-summary-model-claims">
              <h3 className="text-sm font-black text-zinc-900 dark:text-zinc-100">
                {t("chat.quickSummaryModelClaims")}
              </h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {compareSummary.result.modelKeyClaims.map((assessment) => {
                  const model = compareSummary.responseMap.find(
                    (item) => item.responseId === assessment.responseId
                  );
                  return (
                    <article
                      key={assessment.responseId}
                      className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950"
                    >
                      <h4 className="text-sm font-black text-zinc-900 dark:text-zinc-100">
                        {model?.modelName || assessment.responseId}
                      </h4>
                      <ul className="mt-2 grid gap-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                        {assessment.claims.map((claim, index) => (
                          <li key={`${index}-${claim}`} className="flex gap-2">
                            <span className="text-zinc-400" aria-hidden="true">•</span>
                            <span>{claim}</span>
                          </li>
                        ))}
                      </ul>
                    </article>
                  );
                })}
              </div>
            </section>

            <section data-testid="quick-summary-verification" className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/70 dark:bg-amber-950/20">
              <h3 className="text-sm font-black text-amber-950 dark:text-amber-100">
                {t("chat.quickSummaryVerificationNeeded")}
              </h3>
              {compareSummary.result.verificationNeeded.length ? (
                <ul className="mt-3 grid gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
                  {compareSummary.result.verificationNeeded.map((item, index) => (
                    <li key={`${index}-${item}`} className="flex gap-2">
                      <span className="font-black text-amber-600" aria-hidden="true">!</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-zinc-500">{t("chat.quickSummaryNoVerificationItems")}</p>
              )}
              <p className="mt-3 border-t border-amber-200 pt-3 text-xs leading-5 text-amber-900/75 dark:border-amber-900/60 dark:text-amber-100/70">
                {t("chat.quickSummaryDisclaimer")}
              </p>
            </section>
            {showGuestSaveReviewCard && (
              <section
                data-testid="guest-save-review-prompt"
                className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 dark:border-blue-900/70 dark:bg-blue-950/30"
              >
                <p className="text-sm font-black text-blue-950 dark:text-blue-100">
                  {t("chat.guestSaveReviewTitle")}
                </p>
                <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                  {t("chat.guestSaveReviewBody")}
                </p>
                <a
                  href={guestCompareSignInHref}
                  data-testid="guest-save-review-cta"
                  onClick={() => {
                    trackProductEvent("signup_started", 1, {
                      trigger: "proactive",
                      cta_location: "guest_save_review",
                    });
                    if (currentChatId) writePendingGuestImportIntent(currentChatId);
                  }}
                  className="mt-3 flex min-h-10 w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white hover:bg-blue-500"
                >
                  {t("chat.guestSaveReviewCta")}
                </a>
              </section>
            )}
          </div>
        </section>
      </div>
    )}
    {showComparisonReview && (
      <ComparisonReviewDialog
        conversationId={currentChatId ?? null}
        open
        onClose={() => setShowComparisonReview(false)}
        onCompleted={() => maybeShowValueUpgradePrompt("ai_review")}
      />
    )}
    {pendingRemoveModelId && (
      <ConfirmDialog
        title={t("chat.closeModelPanel")}
        description={t("sidebar.closePanel")}
        detail={pendingRemoveModel?.name || pendingRemoveModelId}
        confirmLabel={t("chat.closeModelPanel")}
        cancelLabel={t("auth.cancel")}
        danger
        onCancel={() => setPendingRemoveModelId(null)}
        onConfirm={async () => {
          const id = pendingRemoveModelId;
          setPendingRemoveModelId(null);
          await executeRemoveModel(id);
        }}
      />
    )}
    {pendingRevokeShareId && (
      <ConfirmDialog
        title={t("sidebar.revokeShare")}
        description={t("sidebar.revokeShareConfirm")}
        detail={pendingRevokeConversation?.title}
        confirmLabel={t("sidebar.revokeShare")}
        cancelLabel={t("auth.cancel")}
        onCancel={() => setPendingRevokeShareId(null)}
        onConfirm={async () => {
          const id = pendingRevokeShareId;
          setPendingRevokeShareId(null);
          await executeRevokeShare(id);
        }}
      />
    )}
    {unlockDialog && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const password = unlockDialog.password.trim();
            if (!password) return;
            void submitUnlock(unlockDialog.id, password);
          }}
          className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
            {t("sidebar.unlock")}
          </h2>
          <p className="mt-2 text-sm text-zinc-500">{t("sidebar.askPassword")}</p>
          <input
            autoFocus
            type="password"
            value={unlockDialog.password}
            onChange={(event) =>
              setUnlockDialog({ ...unlockDialog, password: event.target.value, error: "" })
            }
            className="mt-4 h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-sm font-medium text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
          />
          {unlockDialog.error && (
            <p className="mt-2 text-xs font-medium text-red-500">{unlockDialog.error}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setUnlockDialog(null)}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              {t("auth.cancel")}
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
            >
              {t("auth.ok")}
            </button>
          </div>
        </form>
      </div>
    )}
    {lockedSelectDialog && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const password = lockedSelectDialog.password.trim();
            if (!password) return;
            try {
              const verifyRes = await fetch(`/api/conversations/${lockedSelectDialog.id}/verify`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password }),
              });
              const verifyData = await verifyRes.json();
              if (!verifyData.success) {
                setLockedSelectDialog({
                  ...lockedSelectDialog,
                  password: "",
                  error: verifyData.code === "LOCK_RATE_LIMITED"
                    ? t("sidebar.lockRateLimited")
                    : t("sidebar.wrongPassword"),
                });
                return;
              }
              const id = lockedSelectDialog.id;
              setLockedSelectDialog(null);
              await handleSelectConversation(id, true);
            } catch (error) {
              console.error("conversation unlock verify failed:", error);
            }
          }}
          className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
            {t("sidebar.unlock")}
          </h2>
          <p className="mt-2 text-sm text-zinc-500">{t("sidebar.askPassword")}</p>
          <input
            autoFocus
            type="password"
            value={lockedSelectDialog.password}
            onChange={(event) =>
              setLockedSelectDialog({
                ...lockedSelectDialog,
                password: event.target.value,
                error: "",
              })
            }
            className="mt-4 h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-sm font-medium text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
          />
          {lockedSelectDialog.error && (
            <p className="mt-2 text-xs font-medium text-red-500">{lockedSelectDialog.error}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setLockedSelectDialog(null)}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              {t("auth.cancel")}
            </button>
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
            >
              {t("auth.ok")}
            </button>
          </div>
        </form>
      </div>
    )}
    </>
  );
}
