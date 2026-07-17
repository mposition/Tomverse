"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Info, Loader2, Sparkles, X } from "lucide-react";
import { DesktopChatShell } from "@/components/chat/DesktopChatShell";
import { MobileChatShell } from "@/components/chat/MobileChatShell";
import { ComparisonReviewDialog } from "@/components/chat/ComparisonReviewDialog";
import { UpgradeCtaLink } from "@/components/billing/UpgradeCtaLink";
import { ModelFinder } from "@/components/onboarding/ModelFinder";
import { Conversation, AVAILABLE_MODELS, type ChatAttachment } from "@/components/chat/types";
import { useSession } from "next-auth/react";
import {
  useLanguage,
  type Language,
} from "@/components/LanguageProvider";
import {
  APP_DEFAULTS,
  clampGuestSelectedModels,
  clampSelectedModels,
} from "@/lib/appDefaults";
import {
  canUseModelWithPlan,
  getModel,
  getModelUsageProfile,
  isEnabledModelId,
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
    title: "Compare with more AI answers?",
    body: "You are currently trying one free model. Create a free account to compare multiple AI answers side by side.",
    action: "Create a free account and compare",
    cancel: "Continue with one model",
  },
  ko: {
    title: "다른 AI 답변과 비교해 보세요",
    body: "현재 무료 모델 1개로 체험 중입니다. 무료 계정을 만들면 여러 AI 답변을 나란히 비교할 수 있습니다.",
    action: "무료 계정 만들고 비교하기",
    cancel: "모델 1개로 계속하기",
  },
  zh: {
    title: "要与更多 AI 回答比较吗？",
    body: "你目前正在体验一个免费模型。创建免费账户后，即可并排比较多个 AI 回答。",
    action: "创建免费账户并比较",
    cancel: "继续使用一个模型",
  },
  fr: {
    title: "Comparer avec d’autres réponses IA ?",
    body: "Vous essayez actuellement un modèle gratuit. Créez un compte gratuit pour comparer plusieurs réponses IA côte à côte.",
    action: "Créer un compte gratuit et comparer",
    cancel: "Continuer avec un modèle",
  },
  de: {
    title: "Mit weiteren KI-Antworten vergleichen?",
    body: "Sie testen gerade ein kostenloses Modell. Erstellen Sie ein kostenloses Konto, um mehrere KI-Antworten nebeneinander zu vergleichen.",
    action: "Kostenloses Konto erstellen und vergleichen",
    cancel: "Mit einem Modell fortfahren",
  },
  es: {
    title: "¿Comparar con más respuestas de IA?",
    body: "Ahora estás probando un modelo gratuito. Crea una cuenta gratuita para comparar varias respuestas de IA en paralelo.",
    action: "Crear una cuenta gratis y comparar",
    cancel: "Continuar con un modelo",
  },
  pt: {
    title: "Comparar com mais respostas de IA?",
    body: "Você está testando um modelo gratuito. Crie uma conta grátis para comparar várias respostas de IA lado a lado.",
    action: "Criar uma conta grátis e comparar",
    cancel: "Continuar com um modelo",
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
            <div className="text-lg font-black">Tomverse AI</div>
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
          <span className="font-black">Tomverse AI</span>
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
    const { t, setLang, lang } = useLanguage();
  const formatCopy = (key: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      t(key)
    );
  const [isConversationsLoaded, setIsConversationsLoaded] = useState(false);  
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
  const [awaitingPostResponseTips, setAwaitingPostResponseTips] = useState(false);
  const [showPostResponseTips, setShowPostResponseTips] = useState(false);
  const [isGuestPreviewEntry] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("entry") ===
        "guest-preview"
  );
  const [showGuestCompareHint, setShowGuestCompareHint] = useState(false);
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
  const [showComparisonReview, setShowComparisonReview] = useState(false);
  const [upgradeModelPrompt, setUpgradeModelPrompt] = useState<AiModel | null>(null);
  const [valueUpgradeSource, setValueUpgradeSource] = useState<
    "comparison" | "ai_review" | null
  >(null);
  const [unlockDialog, setUnlockDialog] = useState<{ id: string; password: string; error: string } | null>(null);
  const [lockedSelectDialog, setLockedSelectDialog] = useState<{ id: string; password: string; error: string } | null>(null);
  const [toast, setToast] = useState<AppToast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const [selectedModels, setSelectedModels] = useState<string[]>([APP_DEFAULTS.defaultModelId]);
  
  const [disabledPanels, setDisabledPanels] = useState<string[]>([]);
  const modelSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelSyncAbortRef = useRef<AbortController | null>(null);
  const comparisonCompletionsRef = useRef<Map<string, Set<string>>>(new Map());
  const comparisonTrackedRef = useRef<Set<string>>(new Set());
  const localComparisonResponsesRef = useRef<
    Map<string, Map<string, string>>
  >(new Map());
  const latestLocalComparisonPromptRef = useRef<string | null>(null);
  const promptCountsRef = useRef<Map<string, number>>(new Map());
  const comparisonPresetAppliedRef = useRef(false);
  const comparisonPresetRequestedRef = useRef(false);
  const comparisonPreflightInFlightRef = useRef(false);

  const [isPrivateMode, setIsPrivateMode] = useState(false);

  const isGuestMode = status !== "loading" && !sessionUserId;
  const accountUsage = useUserUsage(!isGuestMode);
  const maxSelectableModels = isGuestMode
    ? APP_DEFAULTS.maxGuestSelectedModels
    : accountUsage?.limits.maxModels || APP_DEFAULTS.maxSelectedModels;
  const [guestMessageCount, setGuestMessageCount] = useState(0);
  const MAX_GUEST_MESSAGES = 20;
  const currentAccessPlan = isGuestMode ? "Guest" : accountUsage?.plan ?? "Free";
  const planLockedModelIds = useMemo(
    () =>
      selectedModels.filter((modelId) => {
        const model = getModel(modelId);
        return Boolean(model && !canUseModelWithPlan(currentAccessPlan, model));
      }),
    [currentAccessPlan, selectedModels]
  );
  const effectiveDisabledPanels = useMemo(
    () => uniqueStrings([...disabledPanels, ...planLockedModelIds]),
    [disabledPanels, planLockedModelIds]
  );
  const activeModelCount = selectedModels.filter(
    (modelId) => !effectiveDisabledPanels.includes(modelId)
  ).length;

  const isInitialSelectedRef = useRef(false);
  const currentChatIdRef = useRef(currentChatId);

  useEffect(() => {
    currentChatIdRef.current = currentChatId;
  }, [currentChatId]);

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
    []
  );

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

  const showToast = useCallback((message: string, tone: AppToast["tone"] = "info") => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }

    setToast({
      id: crypto.randomUUID(),
      message,
      tone,
    });

    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3200);
  }, []);

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
      try {
        const response = await fetch("/api/chat/preflight", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comparisonId,
            conversationId,
            modelIds,
            prompt,
            attachments: promptAttachments.map((attachment) => ({
              mediaType: attachment.mediaType,
              size: attachment.size,
            })),
          }),
        });
        if (response.ok) return true;

        const errorBody = await response.json().catch(() => null);
        const code =
          typeof errorBody?.code === "string" ? errorBody.code : "";
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
                        : t("chat.comparisonPreflightFailed");
        const traceId =
          typeof errorBody?.traceId === "string"
            ? errorBody.traceId
            : response.headers.get("X-Request-ID");
        showToast(
          traceId
            ? `${localizedMessage} (${t("chat.traceId")}: ${traceId})`
            : localizedMessage,
          "error"
        );
        return false;
      } catch {
        showToast(t("chat.comparisonPreflightFailed"), "error");
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

    const applyConversationSettings = useCallback((data: {
        selectedModels?: unknown;
        disabledPanels?: unknown;
        messages?: Array<{ role?: string; modelId?: string | null }>;
    }) => {
        const savedModels = normalizeStringArray(data.selectedModels, [userDefaultEngine]);
        const messageModels = Array.isArray(data.messages)
            ? data.messages
                .map((message) => (message.role === "assistant" ? message.modelId : null))
                .filter((modelId): modelId is string => !!modelId)
            : [];

        const nextModels = clampSelectedModels(
            uniqueStrings([...savedModels, ...messageModels])
        );
        const recoveredModels = messageModels.filter((modelId) => !savedModels.includes(modelId));

        setSelectedModels(nextModels.length > 0 ? nextModels : [userDefaultEngine]);
        setDisabledPanels(
            normalizeStringArray(data.disabledPanels, []).filter(
                (modelId) =>
                    nextModels.includes(modelId) &&
                    !recoveredModels.includes(modelId)
            )
        );
    }, [userDefaultEngine]);

  useEffect(() => {
    if (isGuestMode && !isGuestSettingsLoaded) return;
    if (isGuestMode) {
      let cancelled = false;
      queueMicrotask(() => {
      if (cancelled) return;
      setUserDefaultEngine(guestDefaultModelId);
      setSelectedModels([guestDefaultModelId]);
      const today = new Date().toDateString();
      const storedDate = localStorage.getItem("guest_date");
      
      if (storedDate !== today) {
        localStorage.setItem("guest_date", today);
        localStorage.setItem("guest_count", "0");
        setGuestMessageCount(0);
      } else {
        const count = parseInt(localStorage.getItem("guest_count") || "0", 10);
        setGuestMessageCount(count);
      }

      const savedConversations = localStorage.getItem("guest_conversations");
      if (savedConversations) {
        try {
          const parsed = JSON.parse(savedConversations);
          setConversations(parsed);
          if (parsed.length > 0) {
            setCurrentChatId((currentId) => currentId || parsed[0].id);
          }
        } catch (e) {
          console.error("Failed to parse guest conversations:", e);
        }
      } else {
        const initialChatId = `guest_${Date.now()}`;
        const initialChat = {
          id: initialChatId,
          title: t("sidebar.newChat"),
            selectedModels: [guestDefaultModelId],
          disabledPanels: []
        };
        setConversations([initialChat]);
        setCurrentChatId(initialChatId);
        localStorage.setItem("guest_conversations", JSON.stringify([initialChat]));        
      }

      setIsConversationsLoaded(true);      
      });
      return () => {
        cancelled = true;
      };
    }
  }, [guestDefaultModelId, isGuestMode, isGuestSettingsLoaded, t]);  

  useEffect(() => {
    if (isGuestMode && isConversationsLoaded && conversations.length > 0) {
      localStorage.setItem("guest_conversations", JSON.stringify(conversations));
    }
  }, [conversations, isGuestMode, isConversationsLoaded]);  

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

        const firstConversation = conversations[0];
        isInitialSelectedRef.current = true;

        if (firstConversation.isLocked) {
            queueMicrotask(() => {
                setCurrentChatId(null);
                setSelectedModels([userDefaultEngine]);
                setDisabledPanels([]);
                setPromptPayload(null);
            });
            return;
        }

        let cancelled = false;
        let completed = false;

        const openInitialConversation = async () => {
            try {
                const res = await fetch(`/api/conversations/${firstConversation.id}`, {
                    cache: "no-store",
                });

                if (!res.ok) {
                    throw new Error(`Initial conversation load failed: ${res.status}`);
                }
                if (cancelled) return;

                const data = await res.json();
                applyConversationSettings(data);
                completed = true;
                setCurrentChatId(firstConversation.id);
            } catch (error) {
                if (!cancelled) {
                    console.error("Failed to open initial conversation:", error);
                    applyConversationSettings(firstConversation);
                    completed = true;
                    setCurrentChatId(firstConversation.id);
                }
            }
        };

        openInitialConversation();

        return () => {
            cancelled = true;
            if (!completed) {
                isInitialSelectedRef.current = false;
            }
        };
    }, [
        applyConversationSettings,
        conversations,
        currentChatId,
        isGuestMode,
        isUserSettingsLoaded,
        userDefaultEngine,
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
    }, [currentChatId]);

  const fetchConversations = useCallback(async () => {
    if (!sessionUserId) return;

    try {
	  const res = await fetch(`/api/conversations`, { cache: "no-store" });
      if (res.ok) setConversations(await res.json());
    } catch (error) {
      console.error("Failed to load conversations:", error);
    }
    }, [sessionUserId]);

    useEffect(() => {
        if (sessionUserId) {
            queueMicrotask(() => setIsUserSettingsLoaded(false));
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
                            setSelectedModels([data.defaultModel]);
                        }
                    }

                    if (data && isThemePreference(data.theme)) {
                        storeAndApplyThemePreference(data.theme);
                    }

                    if (!isLanguage(urlLanguage) && data && isLanguage(data.language)) {
                        setLang(data.language);
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
    }, [fetchConversations, sessionUserId, setLang, status]);

    const handleNewChat = () => {
        localComparisonResponsesRef.current.clear();
        latestLocalComparisonPromptRef.current = null;
        setIsPrivateMode(false);
    if (isGuestMode) {
      const newGuestChat = {
        id: `guest_${Date.now()}`,
          title: t("sidebar.autoGeneratedNewRoom"),
          selectedModels: [guestDefaultModelId],
        disabledPanels: []
      };
        setConversations((prev) => [newGuestChat, ...prev]);
      setCurrentChatId(newGuestChat.id);
    } else {
        setCurrentChatId(null);
        setSelectedModels([userDefaultEngine]);
    }

    setDisabledPanels([]);
    setInputValue("");
      setPromptPayload(null);

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

      setCurrentChatId(id);
	  setPromptPayload(null);

    if (id === "private-chat") {
      setIsPrivateMode(true);
      return;
    }

    setIsPrivateMode(false);

    if (isGuestMode) {
      const targetConv = conversations.find((c) => c.id === id);
      if (targetConv) {
          const restoredModels = clampGuestSelectedModels(
            normalizeStringArray(
              targetConv.selectedModels,
              [guestDefaultModelId]
            )
          );
          setSelectedModels(
            restoredModels.length
              ? restoredModels
              : [guestDefaultModelId]
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
          applyConversationSettings(data);
	  }
    } catch (error) {
      console.error("Failed to load conversation settings:", error);
    }	

        setFocusToken((prev) => prev + 1);

    };

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
      localStorage.removeItem(`guest_messages_${id}`);
      
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
  
  const syncModelSettingsToServer = (targetChatId: string, updatedModels: string[], updatedDisabled: string[]) => {
    if (!targetChatId || targetChatId === "private-chat") return;
    if (!sessionUserId) return;

    if (modelSyncTimerRef.current) {
      clearTimeout(modelSyncTimerRef.current);
    }
    modelSyncAbortRef.current?.abort();

    modelSyncTimerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      modelSyncAbortRef.current = controller;
      try {
        const models = clampSelectedModels(updatedModels);
        const disabled = uniqueStrings(updatedDisabled).filter((modelId) =>
          models.includes(modelId)
        );
        const response = await fetch(`/api/conversations/${targetChatId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selectedModels: models,
            disabledPanels: disabled,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Model settings sync failed: ${response.status}`);
        }
      } catch (error: unknown) {
        if (!(error instanceof Error) || error.name !== "AbortError") {
          console.error("Failed to sync model settings:", error);
        }
      }
    }, 250);
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
    isGuestMode,
    isGuestSettingsLoaded,
    isUserSettingsLoaded,
    maxSelectableModels,
    status,
  ]);
  
  const handleGlobalSubmit = async () => {
    const trimmed = inputValue.trim();
    if ((!trimmed && attachments.length === 0) || selectedModels.length === 0) return;
    const promptAttachments = await cloneAttachmentPreviews(attachments);
	
    if (isGuestMode) {
      const requestCredits = Math.max(1, activeModelCount);
      if (guestMessageCount + requestCredits > MAX_GUEST_MESSAGES) {
          showToast(t("sidebar.exceedDailyLimit"), "error");
        return;
      }
    }

    if (isPrivateMode) {
      const comparisonId = Date.now().toString();
      const preflightAllowed = await runComparisonPreflight({
        comparisonId,
        conversationId: "private-chat",
        prompt: trimmed,
        promptAttachments,
      });
      if (!preflightAllowed) return;
      const previousCount = promptCountsRef.current.get("private-chat") || 0;
      trackProductEvent(
        previousCount === 0 ? "chat_started" : "followup_sent",
        activeModelCount,
        { conversation_mode: "private" }
      );
      promptCountsRef.current.set("private-chat", previousCount + 1);
      setPromptPayload({ 
        id: comparisonId,
        text: trimmed, 
        chatId: "private-chat",
        userMessageId: crypto.randomUUID(),
        attachments: promptAttachments,
      });
      setInputValue("");
      setAttachments([]);
      return;
    }	
	
	let activeChatId = currentChatId;

    if (!activeChatId) {
      if (isGuestMode) {
        activeChatId = "guest-chat";
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
    if (!valueUpgradeSource || showPostResponseTips) return;
    localStorage.setItem("tomverse_value_upgrade_prompt_seen_v1", "1");
  }, [showPostResponseTips, valueUpgradeSource]);

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
        setGuestMessageCount((current) => {
          const next = Math.min(MAX_GUEST_MESSAGES, current + 1);
          localStorage.setItem("guest_count", next.toString());
          return next;
        });
        if (
          isGuestPreviewEntry &&
          responseText.trim() &&
          localStorage.getItem("tomverse_guest_compare_hint_seen_v1") !== "1"
        ) {
          localStorage.setItem("tomverse_guest_compare_hint_seen_v1", "1");
          setShowGuestCompareHint(true);
        }
      } else {
        notifyUserUsageChanged();
      }
      trackProductEventOnce(
        "first_response_completed",
        "first_response_completed",
        activeModelCount,
        { model_id: modelId }
      );
      if (
        awaitingPostResponseTips &&
        localStorage.getItem("tomverse_post_response_tips_seen_v1") !== "1"
      ) {
        setAwaitingPostResponseTips(false);
        setShowPostResponseTips(true);
      }
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
        maybeShowValueUpgradePrompt("comparison");
      }
    },
    [
      activeModelCount,
      awaitingPostResponseTips,
      isGuestPreviewEntry,
      isGuestMode,
      maybeShowValueUpgradePrompt,
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

  const togglePrivateModeGlobal = () => {
    if (isPrivateMode) {
      handleNewChat();
    } else {
      localComparisonResponsesRef.current.clear();
      latestLocalComparisonPromptRef.current = null;
      setIsPrivateMode(true);
      setCurrentChatId("private-chat");
    }
  };

  const toggleModel = (modelId: string) => {
    const model = getModel(modelId);
    const isSelected = selectedModels.includes(modelId);
    if (isGuestMode && !isSelected && selectedModels.length >= 1) {
      setShowGuestSignInPrompt(true);
      return false;
    }
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
    if (currentChatId && currentChatId !== "private-chat") {
      syncModelSettingsToServer(currentChatId, nextModels, nextDisabled);
    }
    return true;
  };

  const handleModelFinderComplete = ({
      defaultModelId,
      optionalModelId,
      promptExample,
    }: {
      defaultModelId: string;
      optionalModelId?: string;
      promptExample?: string;
    }) => {
      const nextModels = clampSelectedModels(
        [defaultModelId, optionalModelId]
          .filter((modelId): modelId is string => Boolean(modelId))
          .filter(isEnabledModelId)
      ).slice(0, maxSelectableModels);

      setUserDefaultEngine(defaultModelId);
      setSelectedModels(nextModels.length ? nextModels : [defaultModelId]);
      setDisabledPanels([]);
      setPersonalizedPrompt(promptExample || null);
      if (
        localStorage.getItem("tomverse_post_response_tips_seen_v1") !== "1"
      ) {
        setAwaitingPostResponseTips(true);
      }
      if (currentChatId && currentChatId !== "private-chat") {
        syncModelSettingsToServer(currentChatId, nextModels, []);
      }
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
          showToast(
            payload?.code === "COMPARISON_RESPONSES_REQUIRED"
              ? t("chat.aiReviewResponsesRequired")
              : t("chat.compareUnavailable"),
            "error"
          );
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

    const handleCompareSummary = async () => {
      if (!currentChatId || isCompareSummaryLoading) return;
      if (isGuestMode || currentChatId === "private-chat") {
        showToast(t("chat.quickDifferenceSummarySavedChatRequired"), "info");
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
        userId={sessionUserId}
        onComplete={handleModelFinderComplete}
      />
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
          isPrivateMode={isPrivateMode}
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onRename={handleRename}
          onDelete={handleDelete}
          onLock={handleLock}
          onUnlock={handleUnlock}
          onShare={handleShareConversation}
          onRevokeShare={handleRevokeShare}
          onDownload={handleDownloadConversation}
          onTogglePrivateMode={togglePrivateModeGlobal}
          onToggleModel={toggleModel}
          onSubmit={handleGlobalSubmit}
          onCompareSummary={handleCompareSummary}
          onComparisonReview={() => setShowComparisonReview(true)}
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
          isPrivateMode={isPrivateMode}
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onRename={handleRename}
          onDelete={handleDelete}
          onLock={handleLock}
          onUnlock={handleUnlock}
          onShare={handleShareConversation}
          onRevokeShare={handleRevokeShare}
          onDownload={handleDownloadConversation}
          onTogglePrivateMode={togglePrivateModeGlobal}
          onToggleModel={toggleModel}
          onSubmit={handleGlobalSubmit}
          onChangePanelModel={changePanelModel}
          onTogglePanelDisable={togglePanelDisable}
          onRemoveModel={handleRemoveModel}
          onCompareSummary={handleCompareSummary}
          onComparisonReview={() => setShowComparisonReview(true)}
          onResponseComplete={handleResponseComplete}
          onFollowupSent={handleModelFollowupSent}
        />
      )}
    {showGuestCompareHint && isGuestMode && (
      <aside
        data-testid="guest-compare-hint"
        className="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[76] mx-auto w-auto max-w-sm rounded-2xl border border-blue-200 bg-white p-4 shadow-2xl shadow-zinc-900/20 dark:border-blue-900/60 dark:bg-zinc-900 md:inset-x-auto md:right-5 md:top-5 md:w-[22rem]"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black text-zinc-950 dark:text-white">{trialCopy.title}</p>
            <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">{trialCopy.body}</p>
          </div>
          <button
            type="button"
            onClick={() => setShowGuestCompareHint(false)}
            aria-label={trialCopy.cancel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <a
          href={guestCompareSignInHref}
          onClick={() =>
            trackProductEvent("signup_started", 1, {
              trigger: "proactive",
              cta_location: "guest_first_response",
            })
          }
          className="mt-3 flex min-h-10 w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white hover:bg-blue-500"
        >
          {trialCopy.action}
        </a>
      </aside>
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
              onClick={() =>
                trackProductEvent("signup_started", 1, {
                  trigger: "proactive",
                  cta_location: "guest_multi_model",
                })
              }
              className="flex min-h-11 items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-center text-sm font-black text-white hover:bg-blue-500"
            >
              {trialCopy.action}
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
    {showPostResponseTips && (
      <aside className="fixed bottom-5 right-5 z-[75] w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-blue-200 bg-white p-4 shadow-2xl shadow-zinc-900/20 dark:border-blue-900/60 dark:bg-zinc-900">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black text-zinc-950 dark:text-white">
              {t("modelFinder.postResponseTitle")}
            </p>
            <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
              {t("modelFinder.postResponseBody")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              localStorage.setItem("tomverse_post_response_tips_seen_v1", "1");
              setShowPostResponseTips(false);
            }}
            aria-label={t("modelFinder.dismissTips")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </aside>
    )}
    {valueUpgradeSource && !showPostResponseTips && accountUsage?.plan === "Free" && (
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
          {t("chat.quickDifferenceSummaryLoading")}
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
          </div>
        </section>
      </div>
    )}
    {showComparisonReview && (
      <ComparisonReviewDialog
        conversationId={
          currentChatId && currentChatId !== "private-chat" ? currentChatId : null
        }
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
