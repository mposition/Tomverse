"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Info, Loader2, Sparkles, X } from "lucide-react";
import { useModalDialog } from "@/components/useModalDialog";
import { DesktopChatShell } from "@/components/chat/DesktopChatShell";
import { MobileChatShell } from "@/components/chat/MobileChatShell";
import { prepareChatContextBundle } from "@/lib/chatContextBundleClient";
import { createSharedPendingRequest } from "@/lib/sharedPendingRequest";
import {
  ComparisonReviewDialog,
  QuoteBadge,
  VerifyItemButton,
  type GuestReviewSource,
} from "@/components/chat/ComparisonReviewDialog";
import type { AiReviewAccess } from "@/components/chat/ComparisonActionRail";
import {
  GUEST_MAX_ATTACHMENTS_PER_MESSAGE,
  GUEST_MAX_ATTACHMENT_BYTES,
  type ChatAttachmentCapabilities,
} from "@/lib/guestAttachmentPolicy";
import { SourceGroundingBadge } from "@/components/chat/SourceGroundingBadge";
import { dispatchAppToast } from "@/lib/appToast";
import { toSourceGrounding } from "@/lib/sourceGrounding";
import { UpgradeCtaLink } from "@/components/billing/UpgradeCtaLink";
import { purchaseCtaCopy } from "@/components/billing/purchaseCopy";
import { normalizeCreditPackId } from "@/lib/purchaseIntent";
import { ModelFinder } from "@/components/onboarding/ModelFinder";
import { DeepResearchSetupSheet } from "@/components/chat/DeepResearchSetupSheet";
import { Conversation, type ChatAttachment } from "@/components/chat/types";
import { useConversationDrafts } from "@/components/chat/useConversationDrafts";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { useSession } from "next-auth/react";
import { ImageGenerationWorkspace } from "@/components/images/ImageGenerationWorkspace";
import { planAllowsImageGeneration } from "@/lib/imageGenerationAccess";
import {
  useLanguage,
  type Language,
} from "@/components/LanguageProvider";
import {
  APP_DEFAULTS,
  createGuestEligibilityCheck,
  GUEST_BRAND_TRIO_MODEL_IDS,
  GUEST_FALLBACK_MODEL_IDS,
  isWebSearchMode,
  resolveGuestDefaultSelectedModels,
  type WebSearchMode,
} from "@/lib/appDefaults";
import type { WebSearchExecution } from "@/lib/webSearchExecutionNormalizer";
import {
  createGuestSelectionClamp,
  GUEST_ACTIVE_CHAT_STORAGE_KEY,
  GUEST_CONVERSATIONS_STORAGE_KEY,
  readGuestInitialModelEnvironment,
  resolveGuestInitialSelectedModels,
} from "@/lib/guestChatInitialModels";
import {
  canUseModelWithPlan,
  getModel as getStaticModel,
  getModelUsageProfile,
  resolveSelectableModelId,
  type AiModel,
} from "@/lib/models";
import { estimateRequestCredits } from "@/lib/webSearchCredits";
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
  removeAllGuestConversationMessages,
} from "@/lib/guestConversationStorage";
import {
  notifyUserUsageChanged,
  useUserUsage,
} from "@/components/chat/useUserUsage";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import {
  createModelSettingsSyncQueue,
  type ModelSettingsSnapshot,
} from "@/lib/modelSettingsSyncQueue";
import {
  trackProductEvent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";

const TRACKED_SEARCH_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "perplexity",
] as const;
type TrackedSearchProvider = (typeof TRACKED_SEARCH_PROVIDERS)[number];
const isTrackedSearchProvider = (
  value: string
): value is TrackedSearchProvider =>
  (TRACKED_SEARCH_PROVIDERS as readonly string[]).includes(value);
import {
  isThemePreference,
  storeAndApplyThemePreference,
} from "@/lib/theme";
import { detectBrowserTimeZone } from "@/lib/userTimeZone";
import {
  formatChatCostSafetyDetails,
  isChatCostSafetyCode,
} from "@/lib/chatCostSafetyCore";
import { retryAfterSecondsFromResponse } from "@/lib/chatRateLimitCore";
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
import {
  conversationIdBelongsToIdentity,
  describeIdentityTransition,
  identityNamespaceKey,
  isGuestConversationId,
  resolveIdentityNamespace,
  selectionAfterIdentityTransition,
  type IdentityNamespace,
} from "@/lib/chatIdentityNamespace";
import { GuestImportModal } from "@/components/chat/GuestImportModal";
import { GUEST_IMPORT_MODAL_OPEN_EVENT } from "@/lib/guestImportModalEvents";
import { useGuestVerification } from "@/components/chat/GuestVerificationProvider";

// Persists which conversation is open in *this tab* so an F5 / crash
// recovery restores it instead of falling back to the welcome screen --
// while a brand-new tab (no sessionStorage) still lands on welcome as
// intended. Deliberately sessionStorage, not localStorage: closing the
// browser and coming back should still default to welcome.
// Defined in lib/guestChatInitialModels so the first-render guest model
// decision reads the same key this file writes.
const ACTIVE_CHAT_STORAGE_KEY = GUEST_ACTIVE_CHAT_STORAGE_KEY;

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

/**
 * PATCHes one conversation's model settings and reports the server's
 * normalized answer back as the confirmed state. Module-level because it
 * closes over nothing from the component -- which is also what lets the
 * identity-transition effect replace the whole queue without re-wiring it.
 */
const createConversationModelSettingsSyncQueue = () =>
  createModelSettingsSyncQueue({
    debounceMs: 250,
    persist: async (conversationId, snapshot) => {
      const response = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedModels: snapshot.models,
          disabledPanels: snapshot.disabled,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        return {
          ok: false,
          retryable: response.status >= 500 || response.status === 429,
          traceId:
            typeof body?.traceId === "string"
              ? body.traceId
              : response.headers.get("X-Request-ID") || undefined,
        };
      }
      const data = await response.json().catch(() => null);
      // The server's normalized answer is the confirmed state -- what it
      // actually stored, not what was sent.
      return {
        ok: true,
        confirmed: {
          models: normalizeStringArray(data?.selectedModels, snapshot.models),
          disabled: normalizeStringArray(
            data?.disabledPanels,
            snapshot.disabled
          ),
        },
      };
    },
  });
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  // UX-010. This is the confirmation for every destructive action in the
  // workspace -- delete conversation, close panel, revoke share. It rendered
  // with aria-modal and no focus management at all, so Escape did nothing,
  // focus stayed on the row behind the overlay, and Tab walked the page under
  // it. Cancel takes initial focus: the safe option should be the default for a
  // keyboard user who is about to confirm a deletion.
  useModalDialog({
    open: true,
    onClose: onCancel,
    dialogRef,
    panelRef: dialogRef,
    initialFocusRef: cancelButtonRef,
  });

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4">
      <div
        ref={dialogRef}
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
            ref={cancelButtonRef}
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
      <aside className="hidden w-80 shrink-0 flex-col border-r border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950 md:flex">
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
          <span className="text-lg font-black">Tomverse Insight</span>
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

export function ChatPageClient({
  // Resolved on the server (see page.tsx) rather than fetched after mount, so
  // this component's very first render already knows the guest default.
  guestDefaultModelId,
  imageGenerationEnabled = false,
}: {
  guestDefaultModelId: string;
  /** The image generation opt-in flag, resolved server-side in page.tsx. */
  imageGenerationEnabled?: boolean;
}) {
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
  // True while a "new image" draft is open: the workspace renders with no
  // server row, which is only created by the first successful generation
  // request (docs/policy/image-generation.md §6).
  const [isImageDraftActive, setIsImageDraftActive] = useState(false);
  // What the chat composer held when the user switched to the image draft.
  // Restored verbatim on the way back: attachments included, since image
  // generation is text-only and silently dropping them would lose work
  // (policy §13).
  const [chatDraftBeforeImage, setChatDraftBeforeImage] = useState<{
    scopeId: string | null;
    text: string;
  } | null>(null);
  // The image workspace's remount identity, held explicitly rather than
  // derived from the conversation id.
  //
  // Remounting on a real conversation switch is deliberate -- the workspace
  // owns a timeline and a poll loop that belong to exactly one conversation.
  // But a draft being adopted as the conversation it just created is not a
  // switch: it is the same workspace continuing, and remounting there threw
  // away the model selection, quality, size and prompt the user had chosen,
  // re-seeding them from the entry point instead.
  const [imageWorkspaceKey, setImageWorkspaceKey] = useState("image-draft:0");
  const imageDraftSerialRef = useRef(0);
  const nextImageDraftKey = () => {
    imageDraftSerialRef.current += 1;
    return `image-draft:${imageDraftSerialRef.current}`;
  };
  const [imageDraftSeedPrompt, setImageDraftSeedPrompt] = useState("");
  // Set only when the user reached the draft by choosing a model in the
  // catalogue's image tab; otherwise the workspace keeps its own default.
  const [imageDraftSeedModelIds, setImageDraftSeedModelIds] = useState<
    string[] | undefined
  >(undefined);
  const { data: session, status } = useSession();
  const sessionUserId = session?.user?.id || null;
  // Declared before any model state below because the initial selected models
  // depend on it. The session is server-resolved and handed to
  // SessionProviderWrapper, so this is already final on the first render --
  // guest mode is never "unknown and then guest".
  const isGuestMode = status !== "loading" && !sessionUserId;
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isViewportReady, setIsViewportReady] = useState(false);

  const [focusToken, setFocusToken] = useState(0);

    // The account's saved new-conversation combination (lead first). This is
    // what a new chat starts with; the representative model is always
    // userDefaultModelIds[0].
    const [userDefaultModelIds, setUserDefaultModelIds] = useState<string[]>([
        APP_DEFAULTS.defaultModelId,
    ]);
  const [isUserSettingsLoaded, setIsUserSettingsLoaded] = useState(false);
  // Both shells gate their model UI on this: a signed-in tab only knows its
  // real selection once settings, the conversation list and the initial
  // conversation have all resolved. Guests are decided on the first frame.
  const isModelSelectionReady =
    isGuestMode ||
    (isUserSettingsLoaded && isConversationsLoaded && isInitialConversationResolved);

  // The composer's in-progress question belongs to the conversation it was
  // typed in, not to the tab: a single shared `inputValue` used to follow the
  // user into whatever conversation they opened next. Both shells read this
  // one store, so switching between desktop and mobile is not a draft
  // boundary either. In-memory for this tab only -- see the hook's docstring.
  const {
    draftText: inputValue,
    draftAttachments: attachments,
    setDraftText: setInputValue,
    setDraftAttachments,
    readDraft,
    hasDraft,
    discardDraft,
    migrateDraft,
  } = useConversationDrafts(currentChatId);
  const [personalizedPrompt, setPersonalizedPrompt] = useState<string | null>(null);
  const [isGuestPreviewEntry] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("entry") ===
        "guest-preview"
  );
  const [showGuestSignInPrompt, setShowGuestSignInPrompt] = useState(false);
  const [promptPayload, setPromptPayload] = useState<{
    id: string;
    text: string;
    chatId: string;
    userMessageId: string;
    attachments: ChatAttachment[];
    deepResearchDepth?: "quick" | "standard" | "deep";
    admissionToken?: string | null;
    contextBundle?: string | null;
    contextLayout?: "single" | "comparison";
  } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingRemoveModelId, setPendingRemoveModelId] = useState<string | null>(null);
  const [pendingRevokeShareId, setPendingRevokeShareId] = useState<string | null>(null);
  const [billingSuccess, setBillingSuccess] = useState<BillingSuccessState | null>(null);
  const billingSuccessDialogRef = useRef<HTMLDivElement | null>(null);
  const billingSuccessCloseRef = useRef<HTMLButtonElement | null>(null);
  const closeBillingSuccess = useCallback(() => setBillingSuccess(null), []);
  useModalDialog({
    open: Boolean(billingSuccess),
    onClose: closeBillingSuccess,
    dialogRef: billingSuccessDialogRef,
    panelRef: billingSuccessDialogRef,
    initialFocusRef: billingSuccessCloseRef,
  });
  const [compareSummary, setCompareSummary] = useState<{
    title: string;
    result: {
      commonConclusions: Array<{
        text: string;
        citations: Array<{ responseId: "A" | "B" | "C"; quote: string; verified: boolean }>;
        verified: boolean;
      }>;
      importantDifferences: Array<{
        text: string;
        citations: Array<{ responseId: "A" | "B" | "C"; quote: string; verified: boolean }>;
        verified: boolean;
      }>;
      modelKeyClaims: Array<{
        responseId: "A" | "B" | "C";
        claims: Array<{ claim: string; quote: string; verified: boolean }>;
      }>;
      verificationNeeded: string[];
      confidence: "low" | "medium" | "high";
      groundingStats: { totalCitations: number; verifiedCitations: number };
    };
    responseMap: Array<{
      responseId: "A" | "B" | "C";
      messageId: string;
      modelId: string;
      modelName: string;
    }>;
    reviewerModelId: string;
    usageCredits: number;
    originalUsageCredits?: number;
    cached: boolean;
  } | null>(null);
  const [isCompareSummaryLoading, setIsCompareSummaryLoading] = useState(false);
  // A summary the server has already produced for this turn replays from cache
  // at zero credits. Tracking which conversation that applies to lets the
  // comparison rail show 0 up front instead of quoting a cost the user will
  // not actually pay. A new question invalidates it.
  const [cachedCompareSummaryChatId, setCachedCompareSummaryChatId] = useState<
    string | null
  >(null);
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
  // Captured when a guest opens the review, never read during render: a
  // guest has no saved conversation, so the answers themselves are what the
  // dialog reviews.
  const [guestReviewSource, setGuestReviewSource] =
    useState<GuestReviewSource | null>(null);
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
  
  // One catalogue-bound accessor pair, used by the first-render model
  // decision immediately below *and* by every clamp further down, so a
  // guest's model set is resolved by identical rules at every point in the
  // lifecycle. The catalogue itself arrives as an initial prop from the
  // server (components/ModelCatalogProvider), so this is already populated on
  // the first render rather than after a client fetch.
  const guestCatalogue = useMemo(
    () => ({
      isEnabledModelId,
      isGuestEligible: createGuestEligibilityCheck(getModel),
    }),
    [getModel, isEnabledModelId]
  );

  // Lazy initializer, not a post-mount effect: the model count is what the
  // estimated credits, panel count, Send label and conversation summary are
  // all derived from, so it has to be final before the first paint. Guests
  // used to start on a single model here and get upgraded to the brand trio
  // by an effect that waited on a network response, which is what made the
  // composer show "1 credit" and then "3 credits" (STG-F006).
  //
  // The resolved `source` is kept because the guest bootstrap effect below
  // has to know whether this decision came from something it outranks.
  const [initialGuestModels] = useState(() =>
    isGuestMode
      ? resolveGuestInitialSelectedModels({
          catalogue: guestCatalogue,
          leadModelId: guestDefaultModelId,
          environment: readGuestInitialModelEnvironment(),
        })
      : null
  );
  const [selectedModels, setSelectedModels] = useState<string[]>(
    initialGuestModels?.models ?? [APP_DEFAULTS.defaultModelId]
  );

  const [disabledPanels, setDisabledPanels] = useState<string[]>([]);
  // Per-conversation, reset/restored on chat switch the same way
  // selectedModels/disabledPanels are -- must never leak between
  // conversations (see components/chat/ChatInput.tsx's tools sheet).
  const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>(
    APP_DEFAULTS.defaultWebSearchMode
  );
  const [isDeepResearchSetupOpen, setIsDeepResearchSetupOpen] = useState(false);
  // Per-conversation, like webSearchMode -- reset on New Chat/conversation
  // switch so a job's status chip never appears to follow the user into a
  // different chat. Cleared on completion via handleResponseComplete below;
  // on failure it stays visible until the user dismisses it (no failure
  // callback is threaded up from ChatApp today), which is disclosed in the
  // chip's own copy rather than silently claimed as a real cancel.
  const [isDeepResearchPending, setIsDeepResearchPending] = useState(false);
  // The latest committed selection, readable synchronously by the send
  // barrier (state values close over stale renders inside async handlers).
  // Written by the central mutation below and kept aligned with React state
  // by the effect right after it.
  const latestModelSettingsRef = useRef<ModelSettingsSnapshot>({
    models: [],
    disabled: [],
  });
  // One serialized, coalescing PATCH queue per conversation. Never aborts an
  // in-flight write (an aborted fetch still commits server-side, which is
  // exactly the out-of-order overwrite this replaces) -- a newer change is
  // coalesced and written as the immediately next request instead. Replaced
  // wholesale on identity transitions so nothing queued by the previous
  // identity is ever written under the next one.
  const modelSettingsSyncQueueRef = useRef(
    createConversationModelSettingsSyncQueue()
  );
  useEffect(() => {
    latestModelSettingsRef.current = {
      models: selectedModels,
      disabled: disabledPanels,
    };
  }, [selectedModels, disabledPanels]);
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
  /**
   * What each run would need in order to re-prepare its §10 context, keyed by
   * prompt id. A panel that is refused for drift knows only its own model, and
   * the whole point of the recovery is that the run moves to one new snapshot
   * together -- so the set, the conversation and the prompt live here, where
   * the send that created them is.
   */
  const contextRepreflightInputsRef = useRef(
    new Map<
      string,
      { conversationId: string | null; modelIds: string[]; prompt: string }
    >()
  );
  /**
   * One re-preparation per run, however many of its panels ask. Three
   * concurrent preparations would hand the three panels three snapshots,
   * which is precisely what sharing a bundle exists to prevent.
   */
  const contextRepreflightRef = useRef(
    createSharedPendingRequest<string | null>()
  );

  /**
   * §10's `repreflight_all`, and the single-model `retry_after_preflight`
   * alongside it -- they are the same call once the set is known.
   *
   * This never re-runs the *admission* preflight. The refused request never
   * reached `acquireChatAccess`, so the slot the aggregate preflight reserved
   * for that panel is still unspent; asking for a fresh admission would
   * reserve a second set of slots for a run that already has one. Only the
   * context is prepared again.
   */
  const handleContextBundleStale = useCallback(
    async ({ promptId }: { promptId: string | null; modelId: string }) => {
      if (!promptId) return null;
      const inputs = contextRepreflightInputsRef.current.get(promptId);
      if (!inputs) return null;
      return contextRepreflightRef.current.run(promptId, () =>
        prepareChatContextBundle(inputs)
      );
    },
    []
  );
  // Auto-title generation: keyed by comparisonId (the promptId ChatApp
  // instances report back on completion) so handleResponseComplete can look
  // up which chat a first-turn response belongs to without needing its own
  // chatId parameter. titleRequestSentRef guarantees exactly one generation
  // request per conversation even when several model panels each report
  // completion for the same first-turn promptId.
  const firstTurnTitleTrackingRef = useRef<
    Map<string, { chatId: string; interimTitle: string; firstPromptText: string }>
  >(new Map());
  const titleRequestSentRef = useRef<Set<string>>(new Set());

  // One shared verification surface for the whole page: the shells decide
  // *where* it appears (rail slot on desktop, modal bottom sheet on mobile),
  // this page only ever asks for a token for a user-initiated action.
  const { requestToken: requestGuestVerificationToken } = useGuestVerification();
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
  const [guestUsage, setGuestUsage] = useState<{
    used: number;
    limit: number;
    // Spendable guest credits and the monthly AI Review trial, both read from
    // the same server buckets that will actually be enforced -- so the rail
    // can distinguish "out of credits" from "trial already used" instead of
    // guessing, and can never offer a run the server would refuse.
    creditsAvailable: number | null;
    aiReviewTrial: { limit: number; used: number; remaining: number } | null;
  } | null>(null);
  const guestMessageCount = guestUsage?.used ?? 0;
  const MAX_GUEST_MESSAGES = guestUsage?.limit ?? 20;
  const refreshGuestUsage = useCallback(() => {
    if (!isGuestMode) return;
    fetch("/api/user/guest-usage", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.used === "number" && typeof data.limit === "number") {
          setGuestUsage({
            used: data.used,
            limit: data.limit,
            creditsAvailable:
              typeof data.creditsAvailable === "number"
                ? data.creditsAvailable
                : null,
            aiReviewTrial:
              data.aiReviewTrial &&
              typeof data.aiReviewTrial.limit === "number" &&
              typeof data.aiReviewTrial.remaining === "number"
                ? data.aiReviewTrial
                : null,
          });
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

  // Mirrors ChatInput's own estimate (via the shared lib/webSearchCredits.ts
  // helper) so the guest daily-credit gate and display reflect each selected
  // model's real weighted cost (Standard=1, Advanced=4, Premium=8, ...) plus
  // any native-web-search surcharge, instead of a flat 1-per-model count,
  // which let combinations of higher-tier/search-surcharged models pass this
  // client-side check while the server's weighted day-credit bucket still
  // rejected them.
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
      const activeModels = selectedModels
        .filter((modelId) => !effectiveDisabledPanels.includes(modelId))
        .map((modelId) => AVAILABLE_MODELS.find((item) => item.id === modelId))
        .filter((model): model is AiModel => Boolean(model));
      return estimateRequestCredits({
        models: activeModels,
        estimatedInputTokens,
        webSearchMode,
      }).totalEstimatedCredits;
    },
    [AVAILABLE_MODELS, effectiveDisabledPanels, selectedModels, webSearchMode]
  );

  const isInitialSelectedRef = useRef(false);
  const guestCarryoverAppliedRef = useRef(false);
  const guestBootstrapAppliedRef = useRef(false);
  const currentChatIdRef = useRef(currentChatId);

  useEffect(() => {
    currentChatIdRef.current = currentChatId;
  }, [currentChatId]);

  /* --------------------------------------------------------------------- */
  /* Identity namespace                                                     */
  /* --------------------------------------------------------------------- */
  // Which identity this tab is operating as. A conversation id belongs to
  // exactly one of them (see lib/chatIdentityNamespace.ts), and crossing the
  // boundary with one is what sent /api/conversations/guest_* to the account
  // API and got CONVERSATION_FORBIDDEN back -- once for the detail request,
  // once for the model-settings sync, and once per comparison panel.
  const identityNamespace = useMemo(
    () => resolveIdentityNamespace(status, sessionUserId),
    [sessionUserId, status]
  );
  const identityNamespaceRef = useRef<IdentityNamespace>(identityNamespace);
  const appliedIdentityKeyRef = useRef<string | null>(null);
  // Ids this identity has already been refused. Kept so a stale selection is
  // recovered from once instead of being retried by every panel forever.
  const staleConversationIdsRef = useRef<Set<string>>(new Set());
  // The guest conversation that was open at sign-in. Only the *selection* is
  // released by the transition below; the guest transcript itself stays in
  // localStorage so the import modal can still offer it.
  const guestSelectionAtSignInRef = useRef<string | null>(null);
  // showToast is declared further down (it needs the toast timer state), and
  // the recovery path above has to be declared before the effects that call
  // it, so it reaches the notifier through this ref rather than by ordering.
  const showToastRef = useRef<
    ((message: string, tone: AppToast["tone"]) => void) | null
  >(null);

  const belongsToCurrentIdentity = useCallback(
    (id: string | null | undefined) =>
      conversationIdBelongsToIdentity(id, identityNamespaceRef.current) &&
      !staleConversationIdsRef.current.has(id as string),
    []
  );

  /**
   * The only id an account API may be given.
   *
   * Returns null -- and the caller skips the request -- whenever the id does
   * not belong to the identity in effect. The server's ownership check is
   * untouched and remains the actual boundary; this is the client refusing to
   * send a request it already knows is wrong.
   */
  const accountConversationId = useCallback(
    (id: string | null | undefined) => {
      if (identityNamespaceRef.current.kind !== "account") return null;
      if (belongsToCurrentIdentity(id)) return id as string;
      if (id) {
        console.warn(
          JSON.stringify({
            event: "chat_conversation_id_namespace_violation",
            reason: isGuestConversationId(id) ? "guest_id" : "stale_id",
          })
        );
      }
      return null;
    },
    [belongsToCurrentIdentity]
  );

  // Runs before every passive effect in the same commit -- including the
  // session bootstrap and the conversation restore further down -- so the
  // stale id is gone before anything can call an account API with it.
  useLayoutEffect(() => {
    const nextKey = identityNamespaceKey(identityNamespace);
    if (identityNamespace.kind === "unresolved") return;
    if (appliedIdentityKeyRef.current === nextKey) return;

    const transition = describeIdentityTransition(
      appliedIdentityKeyRef.current === null
        ? null
        : identityNamespaceRef.current,
      identityNamespace
    );
    identityNamespaceRef.current = identityNamespace;
    appliedIdentityKeyRef.current = nextKey;
    // First resolution of a freshly mounted tab: there is no previous identity
    // to have carried anything over from, and the restore effect below still
    // validates the saved id against this account's own conversation list.
    if (transition.initial) return;

    // Anything the previous identity had in flight or queued belongs to that
    // identity. A queued model-settings PATCH fired after this point would
    // aim the old conversation at the new account's API, so the whole sync
    // queue is replaced. A request already on the wire is left to finish --
    // it was authorized under the identity that issued it, and abandoning
    // its result here cannot make it un-happen server-side.
    modelSettingsSyncQueueRef.current =
      createConversationModelSettingsSyncQueue();
    staleConversationIdsRef.current.clear();

    const carriedId = currentChatIdRef.current;
    if (transition.guestToAccount && typeof window !== "undefined") {
      guestSelectionAtSignInRef.current =
        carriedId ?? window.sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
    }

    const retainedId = selectionAfterIdentityTransition(carriedId, transition);
    if (retainedId !== carriedId) {
      currentChatIdRef.current = retainedId;
      setCurrentChatId(retainedId);
      setPromptPayload(null);
      // The saved id is written for *this* tab's restore. It belongs to the
      // identity that wrote it, so it must not survive into the next one --
      // the guest transcript it points at is untouched in localStorage.
      if (!retainedId && typeof window !== "undefined") {
        window.sessionStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
      }
    }
  }, [identityNamespace]);

  /**
   * Releases a selection the current identity turned out not to be able to
   * open, without destroying anything the user might still want.
   *
   * The server's 403 stands: a conversation that genuinely belongs to someone
   * else is never opened by this path, and nothing is retried. What changes is
   * only the client's own selection -- drafts, guest transcripts and the guest
   * import snapshot are all left alone.
   */
  // Neither shell may be handed an id from another identity: each comparison
  // panel loads its own history from it, so one stale id becomes one 403 per
  // panel. Derived from the reactive namespace rather than the ref so it is
  // already null on the render that follows an identity change.
  const shellConversationId = useMemo(
    () =>
      conversationIdBelongsToIdentity(currentChatId, identityNamespace)
        ? currentChatId
        : null,
    [currentChatId, identityNamespace]
  );

  const recoverFromStaleConversation = useCallback(
    (conversationId: string, options?: { silent?: boolean }) => {
      if (staleConversationIdsRef.current.has(conversationId)) return;
      staleConversationIdsRef.current.add(conversationId);
      console.warn(
        JSON.stringify({
          event: "chat_stale_conversation_released",
          reason: isGuestConversationId(conversationId)
            ? "guest_id_in_account_namespace"
            : "conversation_forbidden",
        })
      );
      setConversations((previous) =>
        previous.filter((conversation) => conversation.id !== conversationId)
      );
      if (currentChatIdRef.current === conversationId) {
        currentChatIdRef.current = null;
        setCurrentChatId(null);
        setPromptPayload(null);
      }
      // Readiness must resolve on every path out of here, or the model
      // selector and the mobile summary skeleton stay stuck forever.
      setIsInitialConversationResolved(true);
      if (!options?.silent) {
        showToastRef.current?.(t("chat.conversationUnavailableSwitched"), "info");
      }
    },
    [t]
  );

  /**
   * True when a failed account request means "this id is not openable by the
   * identity in effect". Only 403 CONVERSATION_FORBIDDEN counts: a locked
   * conversation (423) and a rate limit are different answers with different
   * ways out, and neither releases the selection.
   */
  const isStaleConversationResponse = (
    status: number,
    code: unknown
  ) => status === 403 && code === "CONVERSATION_FORBIDDEN";

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
      // The identity transition released the *selection* but stashed which
      // guest conversation it was, precisely so this modal can still default
      // to it. The transcript itself was never touched.
      setGuestImportDefaultId(
        guestSelectionAtSignInRef.current ??
          window.sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY)
      );
      setIsGuestImportModalOpen(true);
    });
  }, [isGuestMode, sessionUserId, isUserSettingsLoaded]);

  const openGuestImportPicker = useCallback(() => {
    const importable = listImportableGuestConversations();
    setGuestImportCandidates(importable);
    setGuestImportDefaultId(
      guestSelectionAtSignInRef.current ??
        (typeof window !== "undefined"
          ? window.sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY)
          : null)
    );
    setIsGuestImportModalOpen(true);
  }, []);

  const closeGuestImportModal = useCallback((markSeen: boolean) => {
    if (markSeen && typeof window !== "undefined") {
      window.localStorage.setItem(GUEST_IMPORT_SEEN_KEY, "1");
    }
    setIsGuestImportModalOpen(false);
    // Skipping or dismissing the import is a decision, so the tab must end up
    // somewhere: with no account conversation selected that is the welcome
    // screen, and readiness has to resolve or the model selector and the
    // mobile summary skeleton stay disabled for the rest of the session.
    setIsInitialConversationResolved(true);
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

  const clampSelectedModels = useCallback(
    (models: string[]) =>
      Array.from(new Set(models))
        .map((modelId) =>
          resolveSelectableModelId(
            modelId,
            (candidateId) => getModel(candidateId) ?? getStaticModel(candidateId)
          )
        )
        .filter((modelId): modelId is string => Boolean(modelId))
        .filter((modelId, index, resolved) => resolved.indexOf(modelId) === index)
        .filter(isEnabledModelId)
        .slice(0, APP_DEFAULTS.maxSelectedModels),
    [getModel, isEnabledModelId]
  );

  const clampGuestSelectedModels = useMemo(
    () => createGuestSelectionClamp(guestCatalogue),
    [guestCatalogue]
  );

  // Same resolver, same lead model and same catalogue the first render used,
  // so re-deriving this here can only ever reproduce the value already on
  // screen -- never replace it with a different model count.
  const guestDefaultSelectedModels = useMemo(
    () =>
      clampGuestSelectedModels(
        resolveGuestDefaultSelectedModels({
          isEligible: guestCatalogue.isGuestEligible,
          leadModelId: guestDefaultModelId,
        })
      ),
    [clampGuestSelectedModels, guestCatalogue, guestDefaultModelId]
  );

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

  // The guest default lead model used to be fetched here after mount, which
  // is why the guest bootstrap effect below had to wait on a network response
  // before it could apply the 3-model default -- and why the composer painted
  // a single-model estimate first. It now arrives as a server-resolved prop,
  // so there is nothing left to load and nothing left to gate on.

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

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

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
      // Guests run this too. A guest comparison is the same three requests an
      // account's is, so its concurrency has to be admitted once for the whole
      // run -- otherwise the panels race each other and some are refused after
      // others have already started.
      if (modelIds.length < 2) return { allowed: true, admissionToken: null, contextBundle: null };
      if (comparisonPreflightInFlightRef.current) {
        return { allowed: false, admissionToken: null, contextBundle: null };
      }

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
          webSearchMode,
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
            return { allowed: false, admissionToken: null, contextBundle: null };
          }

          if (response.ok) {
            const grant = await response.json().catch(() => null);
            return {
              allowed: true,
              admissionToken:
                typeof grant?.admissionToken === "string"
                  ? grant.admissionToken
                  : null,
              // A second opaque token with an unrelated job: the admission
              // decides which concurrency slot each panel occupies, this one
              // attests which context snapshot the whole comparison was
              // priced against. Absent whenever the request had no memory
              // context to price, which is every request while injection is
              // off.
              contextBundle:
                typeof grant?.contextBundle === "string"
                  ? grant.contextBundle
                  : null,
            };
          }
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
          return { allowed: false, admissionToken: null, contextBundle: null };
        }
        if (
          (response.status === 500 &&
            code === "COMPARISON_PREFLIGHT_FAILED") ||
          (response.status === 503 &&
            code === "COMPARISON_PREFLIGHT_TEMPORARILY_UNAVAILABLE")
        ) {
          const traceId =
            typeof errorBody?.traceId === "string"
              ? errorBody.traceId
              : response.headers.get("X-Request-ID") || clientTraceId;
          // The comparison preflight is an all-or-nothing UX guard, not the
          // security boundary. Every /api/chat request revalidates the model,
          // conversation ownership, plan, credits, cost limits and its own
          // concurrency slot before a provider call. If only this aggregate
          // check is unavailable -- after its one retry -- continue through
          // those authoritative per-model checks rather than refusing to send
          // at all. A real verdict (429, 403) still blocks; only an
          // infrastructure failure of the check itself degrades open.
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
          return { allowed: true, admissionToken: null, contextBundle: null };
        }
        // A rate rejection is the one refusal here that resolves by itself, so
        // it is the one that has to say when. The server sends the wait twice
        // -- `Retry-After` and `details.retryAfterSeconds` -- and this reads
        // either into the current language's sentence.
        //
        // Deliberately not retried: `CHAT_RATE_LIMITED` is a real verdict, not
        // an infrastructure failure of the check, and an automatic resend is
        // exactly the traffic the limit exists to shed. The draft and its
        // attachments survive because this returns before the composer is
        // cleared, so the user re-sends when they choose to.
        const localizedMessage =
          code === "CHAT_RATE_LIMITED"
            ? t("chat.tooManyRequestsRetry").replace(
                "{seconds}",
                String(
                  retryAfterSecondsFromResponse(
                    response.headers.get("Retry-After"),
                    errorBody?.details
                  )
                )
              )
          : code === "PLAN_ENTITLEMENT_EXHAUSTED"
            ? t("chat.planEntitlementExhausted")
          : code === "CONCURRENT_RESERVATION_CONFLICT"
            ? t("chat.concurrentReservationConflict")
          : code === "CREDIT_BALANCE_INSUFFICIENT" ||
          code === "CREDIT_COST_ALLOWANCE_INSUFFICIENT"
            ? t("chat.comparisonCreditsInsufficient")
            : code === "OPERATIONAL_COST_GUARDRAIL_TRIGGERED"
              ? t("chat.operationalCostGuardrail")
              : code === "INTERNAL_DAILY_COST_SAFETY_LIMIT"
              ? t("chat.internalDailyCostSafetyLimit")
              : code === "INTERNAL_MONTHLY_COST_SAFETY_LIMIT"
                ? t("chat.internalMonthlyCostSafetyLimit")
                : code === "PROVIDER_BUDGET_EXHAUSTED" ||
                    code === "PROVIDER_DAILY_SPEND_LIMIT_REACHED" ||
                    code === "PROVIDER_SPEND_LIMIT_REACHED"
                  ? t("chat.providerCostSafetyLimit")
                  : code === "PLAN_DAILY_CREDIT_LIMIT_REACHED"
                    ? t("chat.dailyPlanCreditsUnavailable")
                    : code === "CHAT_QUOTA_EXCEEDED"
                    ? t("chat.comparisonDailyCreditsInsufficient")
                    : code === "CHAT_CONCURRENCY_EXCEEDED"
                      ? t("chat.comparisonConcurrencyLimit")
                      : code === "CHAT_IP_CONCURRENCY_EXCEEDED"
                        ? t("chat.networkConcurrencyLimit")
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
        return { allowed: false, admissionToken: null, contextBundle: null };
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
        return { allowed: false, admissionToken: null, contextBundle: null };
      } finally {
        comparisonPreflightInFlightRef.current = false;
      }
    }, [effectiveDisabledPanels, selectedModels, showToast, t, webSearchMode]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // A credit-pack purchase that started in chat now returns to chat with an
  // outcome. Previously `billing=credits-success` was written into the URL by
  // the checkout route and read by nothing at all: the visitor landed back on
  // their conversation with no confirmation that anything had been bought, and
  // a cancelled purchase was indistinguishable from a successful one.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const billing = params.get("billing");
    if (billing !== "credits-success" && billing !== "credits-cancelled") return;

    const packId = normalizeCreditPackId(params.get("pack"));
    const urlLanguage = params.get("lang");
    const copyLanguage = isLanguage(urlLanguage) ? urlLanguage : lang;
    const purchaseCopy = purchaseCtaCopy[copyLanguage] || purchaseCtaCopy.en;
    const packLabel = packId
      ? packId
          .split("_")[0]
          .replace(/^./, (character) => character.toUpperCase())
      : purchaseCopy.buyCredits;

    queueMicrotask(() => {
      if (billing === "credits-success") {
        showToast(purchaseCopy.purchaseSuccessBody(packLabel), "success");
        // The balance the usage widget is showing predates the purchase.
        notifyUserUsageChanged();
      } else {
        showToast(purchaseCopy.purchaseCancelledBody(packLabel), "info");
      }
    });

    params.delete("billing");
    params.delete("pack");
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`
    );
  }, [lang, showToast]);

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
        webSearchMode?: unknown;
        messages?: Array<{ role?: string; modelId?: string | null }>;
    }, targetChatId?: string) => {
        const savedModels = normalizeStringArray(data.selectedModels, userDefaultModelIds);
        const nextModels = clampSelectedModels(uniqueStrings(savedModels));
        const nextDisabled = normalizeStringArray(data.disabledPanels, []).filter(
            (modelId) => nextModels.includes(modelId)
        );
        // The empty-conversation fallback is the account's saved
        // new-conversation combination, not just the representative model.
        const appliedModels =
            nextModels.length > 0 ? nextModels : userDefaultModelIds;

        setSelectedModels(appliedModels);
        setDisabledPanels(nextDisabled);
        latestModelSettingsRef.current = {
            models: appliedModels,
            disabled: nextDisabled,
        };
        setWebSearchMode(
            isWebSearchMode(data.webSearchMode)
                ? data.webSearchMode
                : APP_DEFAULTS.defaultWebSearchMode
        );
        if (targetChatId) {
          // A server read seeds the queue's confirmed state; markConfirmed
          // refuses while local changes are unconfirmed, so a stale read can
          // never masquerade as the server's latest word.
          modelSettingsSyncQueueRef.current.markConfirmed(targetChatId, {
            models: appliedModels,
            disabled: nextDisabled,
          });
        }
    }, [clampSelectedModels, userDefaultModelIds]);

  useEffect(() => {
    if (!isGuestMode) {
      // Signing out in the same tab must be able to bootstrap again.
      guestBootstrapAppliedRef.current = false;
      return;
    }
    // Runs once per guest session. Without this, a later model-catalogue
    // refresh (ModelCatalogProvider re-fetches on mount) changes
    // guestDefaultSelectedModels' identity and re-runs the whole bootstrap,
    // which would overwrite a restored conversation, a ?models= preset, or a
    // selection the guest had already changed -- each of them a visible model
    // count and price change after the first paint.
    if (guestBootstrapAppliedRef.current) return;
    // A ?models= comparison link outranks both the guest default and the
    // restored conversation, and the first render already applied it. Leaving
    // it alone here is what stops the composer bouncing preset -> default ->
    // preset once the preset effect further down re-asserts it.
    const hasUrlModelPreset = initialGuestModels?.source === "url_models_param";
    {
      let cancelled = false;
      queueMicrotask(() => {
      if (cancelled) return;
      guestBootstrapAppliedRef.current = true;
      setUserDefaultModelIds([guestDefaultModelId]);
      // Decided once and written once. selectedModels already holds this same
      // value from the first render, so this cannot change what is on screen;
      // it exists so the restore path below can refine it in the same commit
      // rather than after a visible default-then-restore step.
      let nextSelectedModels =
        hasUrlModelPreset && initialGuestModels
          ? initialGuestModels.models
          : guestDefaultSelectedModels;
      refreshGuestUsage();

      const savedConversations = localStorage.getItem(GUEST_CONVERSATIONS_STORAGE_KEY);
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
            localStorage.setItem(
              GUEST_CONVERSATIONS_STORAGE_KEY,
              JSON.stringify(cleaned)
            );
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
            if (!hasUrlModelPreset) {
              nextSelectedModels = restoredModels.length
                ? restoredModels
                : guestDefaultSelectedModels;
            }
            setDisabledPanels(
              normalizeStringArray(restoredConversation.disabledPanels, []).filter(
                (modelId: string) => restoredModels.includes(modelId)
              )
            );
            setWebSearchMode(
              isWebSearchMode(restoredConversation.webSearchMode)
                ? restoredConversation.webSearchMode
                : APP_DEFAULTS.defaultWebSearchMode
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
          webSearchMode: APP_DEFAULTS.defaultWebSearchMode,
          createdAt: new Date().toISOString(),
        };
        setConversations([initialChat]);
        setCurrentChatId(initialChatId);
        localStorage.setItem(
          GUEST_CONVERSATIONS_STORAGE_KEY,
          JSON.stringify([initialChat])
        );
      }

      setSelectedModels(nextSelectedModels);
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
    initialGuestModels,
    isGuestMode,
    refreshGuestUsage,
    t,
  ]);

  useEffect(() => {
    if (isGuestMode && isConversationsLoaded && conversations.length > 0) {
      localStorage.setItem(GUEST_CONVERSATIONS_STORAGE_KEY, JSON.stringify(conversations));
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
                const savedGuestConversations = localStorage.getItem(GUEST_CONVERSATIONS_STORAGE_KEY);
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

            // A legacy dispatch without a combination means [defaultModel].
            const combination = (
                detail.newConversationModelIds ?? [detail.defaultModel]
            ).filter(isEnabledModelId);
            const nextDefaultModels =
                combination.length > 0 ? combination : [detail.defaultModel];

            setUserDefaultModelIds(nextDefaultModels);
            if (!currentChatId) {
                setSelectedModels(nextDefaultModels);
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

    // The session bootstrap below only *reads* these; it must not re-run when
    // their identity changes. ModelCatalogProvider refreshes the catalog once
    // after mount, which rebuilds isEnabledModelId (and every memo derived
    // from it, including newAccountDefaultSelectedModels). While those sat in
    // the bootstrap's dependency array, that refresh re-ran the bootstrap and
    // reset isInitialConversationResolved to false *after* the initial
    // conversation had already been restored. Nothing set it back -- the
    // restore effect below had already consumed isInitialSelectedRef and
    // currentChatId -- so isModelSelectionReady, the mobile header's
    // model-summary skeleton and the desktop model selector's disabled state
    // stayed stuck until the tab was reloaded.
    const isEnabledModelIdRef = useRef(isEnabledModelId);
    const newAccountDefaultSelectedModelsRef = useRef(newAccountDefaultSelectedModels);
    const tRef = useRef(t);
    useEffect(() => {
        isEnabledModelIdRef.current = isEnabledModelId;
        newAccountDefaultSelectedModelsRef.current = newAccountDefaultSelectedModels;
        tRef.current = t;
    }, [isEnabledModelId, newAccountDefaultSelectedModels, t]);

    useEffect(() => {
        if (sessionUserId) {
            queueMicrotask(() => setIsUserSettingsLoaded(false));
            queueMicrotask(() => setIsConversationsLoaded(false));
            queueMicrotask(() => setIsInitialConversationResolved(false));
            // Re-arm the restore path in lockstep with the flags it feeds.
            // This branch now only runs on a genuine identity change (sign-in,
            // sign-out, account switch), where re-restoring is exactly right;
            // leaving the ref latched was what made a reset unrecoverable.
            isInitialSelectedRef.current = false;
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
                    if (data && isEnabledModelIdRef.current(data.defaultModel)) {
                        // The saved new-conversation combination (effective,
                        // resolved server-side); [defaultModel] when none.
                        const combination = Array.isArray(data.newConversationModelIds)
                            ? (data.newConversationModelIds as unknown[]).filter(
                                  (modelId): modelId is string =>
                                      typeof modelId === "string" &&
                                      isEnabledModelIdRef.current(modelId)
                              )
                            : [];
                        const nextDefaultModels =
                            combination.length > 0
                                ? combination
                                : [data.defaultModel];
                        setUserDefaultModelIds(nextDefaultModels);
                        if (!currentChatIdRef.current) {
                            setSelectedModels(
                                data.isNewAccount
                                    ? newAccountDefaultSelectedModelsRef.current
                                    : nextDefaultModels
                            );
                        }
                    }

                    // Stored/effective drift: tell the user once per session
                    // per distinct notice; the read path never rewrites the
                    // stored combination, so re-saving in Settings is the way
                    // to confirm the replacement.
                    if (data?.modelSelectionNotice) {
                        const signature = JSON.stringify([
                            data.modelSelectionNotice.reasons ?? null,
                            data.modelSelectionNotice.storedModelIds ?? null,
                            data.modelSelectionNotice.effectiveModelIds ?? null,
                        ]);
                        const storageKey = "tomverse:model-selection-notice";
                        let alreadyShown = false;
                        try {
                            alreadyShown =
                                window.sessionStorage.getItem(storageKey) ===
                                signature;
                            if (!alreadyShown) {
                                window.sessionStorage.setItem(
                                    storageKey,
                                    signature
                                );
                            }
                        } catch {
                            // Storage unavailable: fall through and show it.
                        }
                        if (!alreadyShown) {
                            showToastRef.current?.(
                                tRef.current("chat.modelSelectionNotice"),
                                "info"
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
                    setUserDefaultModelIds([APP_DEFAULTS.defaultModelId]);
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
    // Asking for a new chat is an explicit request for a blank composer, so
    // the conversation this lands on gives its draft up. Every *other*
    // conversation keeps its own -- coming back to one still restores what
    // was being written there.
    let blankedDraftScope: string | null = currentChatIdRef.current;
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
          webSearchMode: APP_DEFAULTS.defaultWebSearchMode,
        };
        setConversations((prev) => prev.map((c) => (c.id === resetChat.id ? resetChat : c)));
      } else {
        const newGuestChat = {
          id: `guest_${Date.now()}`,
            title: t("sidebar.autoGeneratedNewRoom"),
            selectedModels: guestDefaultSelectedModels,
          disabledPanels: [],
          webSearchMode: APP_DEFAULTS.defaultWebSearchMode,
          createdAt: new Date().toISOString(),
        };
          setConversations((prev) => [newGuestChat, ...prev]);
        setCurrentChatId(newGuestChat.id);
        currentChatIdRef.current = newGuestChat.id;
        blankedDraftScope = newGuestChat.id;
      }
    } else {
        currentChatIdRef.current = null;
        setCurrentChatId(null);
        // A new chat starts from the saved new-conversation combination, not
        // just the representative model.
        setSelectedModels(clampSelectedModels(uniqueStrings(userDefaultModelIds)));
        blankedDraftScope = null;
    }

    setDisabledPanels([]);
    setWebSearchMode(APP_DEFAULTS.defaultWebSearchMode);
    setIsDeepResearchPending(false);
    setIsImageDraftActive(false);
    discardDraft(blankedDraftScope);
      setPromptPayload(null);
      setIsInitialConversationResolved(true);

      setFocusToken((prev) => prev + 1);
  };

    // From the composer: carry the typed text into the image prompt and
    // remember the chat draft so cancelling restores it.
    const handleStartImageDraft = (draftText: string, modelId?: string) => {
        setChatDraftBeforeImage({
            scopeId: currentChatIdRef.current,
            text: draftText,
        });
        setImageDraftSeedPrompt(draftText);
        setImageDraftSeedModelIds(modelId ? [modelId] : undefined);
        setImageWorkspaceKey(nextImageDraftKey());
        setIsImageDraftActive(true);
        currentChatIdRef.current = null;
        setCurrentChatId(null);
        setPromptPayload(null);
        setIsDeepResearchPending(false);
        setIsInitialConversationResolved(true);
    };

    // Leaving the image draft without generating: the chat draft comes back
    // exactly as it was, in the conversation it belonged to.
    const handleCancelImageDraft = () => {
        const restore = chatDraftBeforeImage;
        setIsImageDraftActive(false);
        setImageDraftSeedPrompt("");
        setImageDraftSeedModelIds(undefined);
        setChatDraftBeforeImage(null);
        if (restore) {
            currentChatIdRef.current = restore.scopeId;
            setCurrentChatId(restore.scopeId);
            setInputValue(restore.text);
        }
        setFocusToken((prev) => prev + 1);
    };

    const handleNewImage = () => {
        localComparisonResponsesRef.current.clear();
        latestLocalComparisonPromptRef.current = null;
        setIsImageDraftActive(true);
        setImageDraftSeedPrompt("");
        setImageDraftSeedModelIds(undefined);
        setImageWorkspaceKey(nextImageDraftKey());
        setChatDraftBeforeImage(null);
        currentChatIdRef.current = null;
        setCurrentChatId(null);
        setPromptPayload(null);
        setIsDeepResearchPending(false);
        setIsInitialConversationResolved(true);
    };

    // The first successful generation request created the conversation row
    // atomically server-side; adopt it so the sidebar shows it immediately.
    const handleImageConversationCreated = (conversation: {
        id: string;
        title: string;
    }) => {
        setConversations((prev) => [
            {
                id: conversation.id,
                title: conversation.title,
                kind: "image" as const,
                messageCount: 0,
            },
            ...prev,
        ]);
        setIsImageDraftActive(false);
        // Deliberately NOT touching imageWorkspaceKey: this is the same
        // workspace continuing, so its composer settings survive.
        //
        // The seed is cleared even though nothing reads it right now. It was
        // the carried-over chat draft, and leaving it set meant a later, real
        // remount re-filled the composer with the prompt the user had already
        // paid to generate -- next to an enabled submit button.
        setImageDraftSeedPrompt("");
        setImageDraftSeedModelIds(undefined);
        setChatDraftBeforeImage(null);
        currentChatIdRef.current = conversation.id;
        setCurrentChatId(conversation.id);
    };

    // UX-024. Switching conversations while a response is still streaming is
    // allowed, deliberately. This used to open with `if (isSending) return;`
    // against a `const isSending = false`, so the guard never ran once -- the
    // behaviour below is what the product has always done, and the constant
    // only made it look otherwise.
    //
    // Allowing it is also the right answer, not merely the incumbent one.
    // Nothing is lost by leaving: the panel's request is not aborted here (only
    // "stop all" and the per-panel stop button abort), and app/api/chat/route.ts
    // persists the assistant message against the `conversationId` captured when
    // the send started -- never the one on screen when it finishes. The client
    // never writes an assistant message itself, so a stream cannot follow the
    // user into the conversation they switched to; tests/e2e/
    // conversation-switch-during-stream.spec.ts holds that invariant.
    //
    // Blocking would cost far more than it buys: a Deep Research run answers in
    // minutes, and refusing every sidebar click for its duration would strand
    // the user in one conversation with no indication why the click did nothing.
    const handleSelectConversation = async (id: string, skipLockCheck = false) => {
        localComparisonResponsesRef.current.clear();
        latestLocalComparisonPromptRef.current = null;

        if (!isGuestMode && !skipLockCheck) {
            const targetConv = conversations.find((c) => c.id === id);

            if (targetConv && targetConv.isLocked) {
                setLockedSelectDialog({ id, password: "", error: "" });
                return;

            }
        }

        // An image conversation swaps the whole surface for the image
        // workspace: no chat drafts, model settings or panels to restore,
        // and the workspace loads its own generation history.
        const selectedTarget = conversations.find((c) => c.id === id);
        if (selectedTarget?.kind === "image") {
            setIsImageDraftActive(false);
            // A real switch, so a new workspace instance: the timeline and the
            // poll loop of the conversation being left must not follow.
            setImageWorkspaceKey(id);
            currentChatIdRef.current = id;
            setCurrentChatId(id);
            setPromptPayload(null);
            setIsDeepResearchPending(false);
            setIsInitialConversationResolved(true);
            return;
        }

        if (isGuestMode) {
          const previousId = currentChatIdRef.current;
          if (previousId && previousId !== id) {
            const previousConv = conversations.find((c) => c.id === previousId);
            // A conversation with an unsent draft is not abandoned, even
            // though it has no messages yet: sweeping it here would delete
            // the sidebar entry the draft is meant to be restored from.
            if (
              previousConv &&
              isGuestConversationEmpty(previousConv) &&
              !hasDraft(previousId)
            ) {
              setConversations((prev) => prev.filter((c) => c.id !== previousId));
              removeGuestConversationStorage(previousId);
            }
          }
        }

	  currentChatIdRef.current = id;
      setCurrentChatId(id);
	  setPromptPayload(null);
      setIsDeepResearchPending(false);
      setIsImageDraftActive(false);

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
          setWebSearchMode(
            isWebSearchMode(targetConv.webSearchMode)
              ? targetConv.webSearchMode
              : APP_DEFAULTS.defaultWebSearchMode
          );
        } else {
          setWebSearchMode(APP_DEFAULTS.defaultWebSearchMode);
        }
      return;
    }

    if (!sessionUserId) return;

    // UI-STATE-001. The comparison shell is built from selectedModels, so
    // until this conversation's models are known the workspace renders the
    // single bootstrap default: one wide panel, "1 model" in the composer,
    // and a credit estimate priced for one request -- then jumps to three
    // panels and a three-model price the moment the detail response lands.
    // The conversation list already carries selectedModels/disabledPanels/
    // webSearchMode (GET /api/conversations returns them per row), so the
    // shell can be assembled from what is already known and the detail
    // response only refines it. This mirrors what the guest branch above
    // has always done; the authenticated branch was the one waiting.
    const knownConversation = conversations.find((c) => c.id === id);
    if (knownConversation) {
      applyConversationSettings(
        {
          selectedModels: knownConversation.selectedModels,
          disabledPanels: knownConversation.disabledPanels,
          webSearchMode: knownConversation.webSearchMode,
        },
        // No targetChatId: this is an optimistic read of the list, not the
        // server's confirmation of what this conversation is saved as, so it
        // must not seed the sync queue's confirmed state and suppress the
        // real sync.
        undefined
      );
    }

    // State invariant, checked before the request rather than after the 403:
    // only an id this account can own is ever put on an account URL. The
    // server still decides ownership -- this only stops a request that is
    // already known to be wrong from being made at all.
    const accountId = accountConversationId(id);
    if (!accountId) {
      recoverFromStaleConversation(id);
      return;
    }

	try {
	  const revisionBeforeDetailFetch =
	    modelSettingsSyncQueueRef.current.localRevision(accountId);
	  const res = await fetch(`/api/conversations/${accountId}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        // A detail response that lands late must not clobber newer local
        // state: neither another conversation the user has since switched
        // to, nor a model change made while this request was in flight.
        // The revision compare also covers a change that was already
        // *confirmed* during the read -- the response still predates it.
        if (
          currentChatIdRef.current === id &&
          modelSettingsSyncQueueRef.current.localRevision(accountId) ===
            revisionBeforeDetailFetch &&
          !modelSettingsSyncQueueRef.current.hasUnconfirmedChanges(accountId)
        ) {
          applyConversationSettings(data, id);
        }
      } else {
        const body = await res.json().catch(() => null);
        // A genuine 403 on someone else's conversation stays a 403 and is
        // never opened. All that happens here is that this client stops
        // holding a selection it cannot use, once, without retrying.
        if (isStaleConversationResponse(res.status, body?.code)) {
          recoverFromStaleConversation(id);
          return;
        }
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
        // The server's id for the imported conversation -- an account id, in
        // this account's namespace. The guest id it came from is never
        // selected again.
        void handleSelectConversation(conversationIdToOpen);
      }
      setIsGuestImportModalOpen(false);
      setIsInitialConversationResolved(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

    useEffect(() => {
        // Anything below this point decides the initial conversation one way
        // or another, so every path must end with
        // isInitialConversationResolved true. Only genuinely
        // not-yet-knowable states may return without resolving it -- an
        // early return that resolves nothing is what previously stranded
        // isModelSelectionReady (and the mobile model-summary skeleton) for
        // the whole session.
        if (isGuestMode || !isUserSettingsLoaded || !isConversationsLoaded) return;
        // conversations.length === 0 is only meaningful once the list has
        // actually loaded; the new-account carryover effect above owns that
        // case (and its guest-import handoff).
        if (conversations.length === 0 || pendingGuestImportRef.current) return;

        const params = new URLSearchParams(window.location.search);
        const hasUrlSelectionPreset = params.has("models") || params.has("prompt");
        // A ?models=/?prompt= landing takes its selection from the URL rather
        // than from a restore, so the comparison-preset effect owns the first
        // resolution. After it has applied (or declined) the preset, a later
        // pass -- e.g. an account switch re-running the bootstrap -- resolves
        // here instead, because that effect never runs twice.
        if (hasUrlSelectionPreset && !comparisonPresetAppliedRef.current) return;

        if (
            currentChatId ||
            isInitialSelectedRef.current ||
            comparisonPresetRequestedRef.current ||
            hasUrlSelectionPreset
        ) {
            // A conversation is already open, an initial selection already
            // ran, or the URL already decided the models. No restore will
            // happen, so the selection is final and readiness must resolve.
            queueMicrotask(() => setIsInitialConversationResolved(true));
            return;
        }

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
    }, [
        conversations,
        currentChatId,
        isConversationsLoaded,
        isGuestMode,
        isUserSettingsLoaded,
    ]);

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
            dispatchAppToast(t("chat.chatLockFailed"), "error");
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
            dispatchAppToast(t("chat.chatUnlockFailed"), "error");
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
        // UX-015. `fetch` resolves for a 4xx or 5xx, so without this check a
        // rejected rename refetched the list and put the old title back with
        // no explanation -- indistinguishable from the rename never having
        // been typed.
        const response = await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: newTitle }),
        });
        if (!response.ok) throw new Error(`Rename failed: ${response.status}`);
        fetchConversations();
      } catch (error) {
        console.error("Failed to rename conversation:", error);
        dispatchAppToast(t("chat.chatRenameFailed"), "error");
      }
    }
  };

  const executeDelete = async (id: string) => {
    // A deleted conversation can never be returned to, so its draft has
    // nowhere left to be restored into: drop it (and release its previews)
    // rather than leak an entry nothing can reach. Other conversations'
    // drafts are untouched.
    discardDraft(id);
    if (isGuestMode) {
      const updated = conversations.filter((c) => c.id !== id);
      setConversations(updated);
      removeGuestConversationStorage(id);

      if (currentChatId === id) {
        const nextId = updated.length > 0 ? updated[0].id : null;
        setCurrentChatId(nextId);
        currentChatIdRef.current = nextId;
      }
      if (updated.length === 0) {
        localStorage.removeItem(GUEST_CONVERSATIONS_STORAGE_KEY);
        // Nothing is left to reference the remaining transcripts, so drop them
        // rather than leaving deleted prompts recoverable on a shared browser.
        removeAllGuestConversationMessages();
      }
    } else {    
      try {
        const response = await fetch(`/api/conversations/${id}`, {
          method: "DELETE",
        });
        // UX-015. Same reason as the rename above, and worse here: a refused
        // delete left the conversation in the list, which reads as the click
        // having missed rather than as the server saying no.
        if (!response.ok) throw new Error(`Delete failed: ${response.status}`);

        // A deleted conversation can never be PATCHed again -- drop any
        // queued or confirmed sync state it still holds.
        modelSettingsSyncQueueRef.current.reset(id);
        if (currentChatId === id) {
          handleNewChat();
        }
        fetchConversations();
      } catch (error) {
        console.error("Failed to delete conversation:", error);
        dispatchAppToast(t("chat.chatDeleteFailed"), "error");
      }
    }
  };

  const handleDelete = async (id: string) => {
    setPendingDeleteId(id);
  };
  
  /**
   * The single mutation path for a conversation's model selection. Every
   * change -- user toggles, panel swaps, ?models= presets, programmatic
   * updates -- goes through here so the screen state and the per-conversation
   * sync queue can never disagree about what the latest selection is.
   */
  const mutateModelSettings = useCallback(
    (
      targetChatId: string | null,
      nextModels: string[],
      nextDisabled: string[]
    ) => {
      const models = uniqueStrings(nextModels);
      const disabled = uniqueStrings(nextDisabled).filter((modelId) =>
        models.includes(modelId)
      );
      setSelectedModels(models);
      setDisabledPanels(disabled);
      // Written synchronously (not only via the state-mirroring effect) so a
      // send barrier that runs before React commits still captures this
      // change.
      latestModelSettingsRef.current = { models, disabled };
      const syncTargetId = accountConversationId(targetChatId);
      if (!syncTargetId || !sessionUserId) return;
      const syncModels = clampSelectedModels(models);
      modelSettingsSyncQueueRef.current.enqueue(syncTargetId, {
        models: syncModels,
        disabled: disabled.filter((modelId) => syncModels.includes(modelId)),
      });
    },
    [accountConversationId, clampSelectedModels, sessionUserId]
  );

  // Deliberate user action (picked from the tools sheet), not the frequent
  // rapid-toggle case selectedModels' debounced sync guards against -- an
  // immediate PATCH is simpler and correct here. Guests have no server
  // record to PATCH; their conversations array (already localStorage-backed
  // by the effect below) is updated directly instead.
  const updateWebSearchMode = (mode: WebSearchMode) => {
    setWebSearchMode(mode);
    if (isGuestMode) {
      if (currentChatId) {
        setConversations((prev) =>
          prev.map((conversation) =>
            conversation.id === currentChatId
              ? { ...conversation, webSearchMode: mode }
              : conversation
          )
        );
      }
      return;
    }
    const webSearchTargetId = accountConversationId(currentChatId);
    if (!webSearchTargetId || !sessionUserId) return;
    void fetch(`/api/conversations/${webSearchTargetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webSearchMode: mode }),
    }).catch((error) => {
      console.error("Failed to sync web search mode:", error);
    });
  };

  /**
   * The send barrier every send path runs before /api/chat or the comparison
   * preflight: full comparison sends, single-model sends, per-panel
   * follow-ups, both retry paths and the deep-research auto-send. It captures
   * the selection this send is being made with and resolves only once the
   * server has confirmed that exact snapshot -- "no pending request" is not
   * treated as success, so a selection the server never saw can no longer be
   * sent against.
   */
  const ensureModelSettingsReady = async (targetChatId: string) => {
    if (isGuestMode || !sessionUserId) {
      return true;
    }
    const accountId = accountConversationId(targetChatId);
    if (!accountId) {
      recoverFromStaleConversation(targetChatId);
      return false;
    }
    const capturedModels = clampSelectedModels(
      latestModelSettingsRef.current.models
    );
    const captured: ModelSettingsSnapshot = {
      models: capturedModels,
      disabled: uniqueStrings(latestModelSettingsRef.current.disabled).filter(
        (modelId) => capturedModels.includes(modelId)
      ),
    };
    const outcome = await modelSettingsSyncQueueRef.current.ensureConfirmed(
      accountId,
      captured
    );
    if (
      outcome.status === "confirmed" &&
      captured.models.every((modelId) =>
        outcome.confirmed.models.includes(modelId)
      )
    ) {
      return true;
    }

    const traceId =
      outcome.status === "failed" ? outcome.traceId : crypto.randomUUID();
    console.error(JSON.stringify({
      event: "chat_model_settings_flush_failed",
      traceId,
      conversationId: targetChatId,
      outcome: outcome.status,
      capturedModelIds: captured.models,
      confirmedModelIds: outcome.confirmed?.models ?? null,
    }));
    // The send is abandoned; the screen recovers to the last state the
    // server actually confirmed so what is shown is what a retry would be
    // allowed to use.
    const confirmed = outcome.confirmed;
    if (confirmed && currentChatIdRef.current === targetChatId) {
      setSelectedModels(confirmed.models);
      setDisabledPanels(confirmed.disabled);
      latestModelSettingsRef.current = confirmed;
    }
    showToast(
      `${t("chat.modelSettingsSyncFailed")} (${t("chat.traceId")}: ${traceId})`,
      "error"
    );
    return false;
  };

  useEffect(() => {
    if (
      comparisonPresetAppliedRef.current ||
      status === "loading" ||
      !isUserSettingsLoaded
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
    // Captured before the params are stripped below: the restore effect keys
    // its stand-down on the raw presence of these keys, so readiness has to be
    // handed back on exactly the same condition.
    const hadUrlSelectionPreset = params.has("models") || params.has("prompt");

    if (requestedModels.length === 0 && !requestedPrompt) {
      comparisonPresetAppliedRef.current = true;
      // A ?models=/?prompt= URL that carries nothing usable still makes the
      // restore effect above stand down, so this effect has to hand
      // readiness back rather than leave it unresolved. Deferred like every
      // other bootstrap transition in this file so it never cascades a
      // render from inside the effect body.
      if (hadUrlSelectionPreset) {
        queueMicrotask(() => setIsInitialConversationResolved(true));
      }
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
        // Through the central mutation so a preset applied onto an already
        // open account conversation is also written to the server -- a
        // preset that only changed the screen left the very next send to be
        // refused with MODEL_NOT_SELECTED.
        mutateModelSettings(currentChatId, presetModels, []);
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
      // The models are applied in this same microtask, so resolving here
      // never paints a stale count before correcting it -- which is the whole
      // reason the model-summary skeleton exists.
      if (hadUrlSelectionPreset) setIsInitialConversationResolved(true);

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
    mutateModelSettings,
    setInputValue,
    isUserSettingsLoaded,
    maxSelectableModels,
    isEnabledModelId,
    status,
  ]);

  // STG-F003: nothing marks the composer busy until well after the submit
  // path has awaited a conversation create, the model-settings flush and the
  // preflight, so a second Enter -- or an Enter racing the send button --
  // inside that window used to start a second, fully independent comparison:
  // two preflights, two saved user messages, two charges for one intent. One
  // submit at a time, and the flag is released in `finally` so a rejected or
  // aborted attempt can never wedge the composer shut.
  const submitInFlightRef = useRef(false);
  const handleGlobalSubmit = async (options?: {
    deepResearchDepth?: "quick" | "standard" | "deep";
  }) => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
      await runGlobalSubmit(options);
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const runGlobalSubmit = async (options?: {
    deepResearchDepth?: "quick" | "standard" | "deep";
  }) => {
    const trimmed = inputValue.trim();
    if ((!trimmed && attachments.length === 0) || selectedModels.length === 0) return;
    if (activeModelCount === 0) {
      showToast(t("chat.chooseModel"), "error");
      return;
    }
    // Captured before the first await: everything below may run while the
    // user is looking somewhere else, and this draft must only ever be
    // cleared once this send has actually been accepted.
    const originScopeId = currentChatId;
    const promptAttachments = await cloneAttachmentPreviews(attachments);
	
    if (isGuestMode) {
      const requestCredits = estimateWeightedRequestCredits(trimmed, promptAttachments);
      if (guestMessageCount + requestCredits > MAX_GUEST_MESSAGES) {
          showToast(t("sidebar.exceedDailyLimit"), "error");
        return;
      }
    }

	let activeChatId = currentChatId;
    // Captured only when a brand-new conversation is created below, so the
    // first-turn title tracking further down knows the exact interim title
    // string without re-deriving it from state that may not have committed
    // yet (setConversations is async).
    let justCreatedTitle: string | null = null;

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
            webSearchMode,
            createdAt: new Date().toISOString(),
          };
          justCreatedTitle = initialChat.title;
          setConversations([initialChat]);
          localStorage.setItem(GUEST_CONVERSATIONS_STORAGE_KEY, JSON.stringify([initialChat]));
        }
        setCurrentChatId(activeChatId);
        currentChatIdRef.current = activeChatId;
        // The composer was writing into the not-yet-created-conversation
        // draft; hand it to the real id so an abort further down (preflight,
        // credits, network) leaves the text under the conversation that is
        // now on screen instead of stranding it behind a key nothing reads.
        migrateDraft(originScopeId, activeChatId);
      } else {
      try {
        const newConversationTitle = (
          trimmed || attachments[0]?.name || t("sidebar.newChat")
        ).slice(0, 30);
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: newConversationTitle,
            selectedModels,
            disabledPanels,
            webSearchMode
          }),
        });

        if (res.ok) {
          const data = await res.json();
          activeChatId = data.id;
          justCreatedTitle = newConversationTitle;
          // The conversation was created from this exact selection one line
          // above, so it is the server-confirmed state -- seed it so the
          // barrier below does not need a redundant first PATCH. (PATCH
          // responses, where the server may genuinely disagree, feed the
          // queue their normalized answer instead.)
          modelSettingsSyncQueueRef.current.markConfirmed(data.id, {
            models: clampSelectedModels(selectedModels),
            disabled: uniqueStrings(disabledPanels).filter((modelId) =>
              selectedModels.includes(modelId)
            ),
          });
          setCurrentChatId(activeChatId);
          currentChatIdRef.current = activeChatId;
          // Same hand-off as the guest branch above: the draft follows the id
          // the server just issued, so a later abort keeps the question
          // visible in the conversation it now belongs to.
          migrateDraft(originScopeId, activeChatId);
          fetchConversations();
        }
      } catch (error) {
        console.error("Failed to create conversation:", error);
        // UX-015. This `return` abandons the send. Without a message the
        // question simply vanished from the composer with nothing sent and
        // nothing said.
        dispatchAppToast(t("chat.chatCreateFailed"), "error");
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
      const preflight = await runComparisonPreflight({
        comparisonId,
        conversationId: activeChatId,
        prompt: trimmed,
        promptAttachments,
      });
      if (!preflight.allowed) return;
      // The comparison preflight prices the whole set and hands back one
      // bundle for it. A single-model send never had a preparation step, so
      // this is where it gets one -- §10 requires the context to be priced
      // before the request that sends it, whichever shape the send is.
      const activeModelIds = selectedModels.filter(
        (modelId) => !effectiveDisabledPanels.includes(modelId)
      );
      const contextLayout =
        activeModelIds.length >= 2
          ? ("comparison" as const)
          : ("single" as const);
      const contextBundle =
        contextLayout === "comparison"
          ? preflight.contextBundle
          : await prepareChatContextBundle({
              conversationId: isGuestMode ? null : activeChatId,
              modelIds: activeModelIds,
              prompt: trimmed,
            });
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

      if (previousCount === 0 && trimmed) {
        const interimTitle =
          justCreatedTitle ??
          conversation?.title ??
          t("sidebar.newChat");
        firstTurnTitleTrackingRef.current.set(comparisonId, {
          chatId: activeChatId,
          interimTitle,
          firstPromptText: trimmed,
        });
      }

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

      // What re-preparing this run would need, kept because the panels that
      // ask have only their own model: the shell is the only place that knows
      // the whole set, and it is the set that has to move together.
      contextRepreflightInputsRef.current.set(comparisonId, {
        conversationId: isGuestMode ? null : activeChatId,
        modelIds: activeModelIds,
        prompt: trimmed,
      });
      localComparisonQuestionsRef.current.set(comparisonId, trimmed);
      setCachedCompareSummaryChatId(null);
      setPromptPayload({
        id: comparisonId,
        text: trimmed,
        chatId: activeChatId,
        userMessageId: userMsgId,
        attachments: promptAttachments,
        ...(options?.deepResearchDepth
          ? { deepResearchDepth: options.deepResearchDepth }
          : {}),
        ...(preflight.admissionToken
          ? { admissionToken: preflight.admissionToken }
          : {}),
        // The layout always travels, the bundle only when there is one: the
        // layout describes the *send*, and it is what decides whether a stale
        // refusal may be retried by one panel. Carrying it only alongside a
        // bundle would leave a comparison looking like a single-model send
        // whenever the context had nothing to price.
        contextLayout,
        ...(contextBundle ? { contextBundle } : {}),
      });
      // The single point where a draft is cleared by sending: the prompt is
      // now on its way, so this conversation's draft is spent. Every earlier
      // return above -- no model, guest limit, conversation create, model
      // settings, preflight -- leaves it exactly as the user typed it, and no
      // other conversation's draft is touched either way.
      discardDraft(activeChatId, promptAttachments);
      setConversations((current) =>
        current.map((item) =>
          item.id === activeChatId
            ? { ...item, messageCount: (item.messageCount || 0) + 1 }
            : item
        )
      );
    }
  };

  // `scopeId` is what keeps an upload that finished after the user moved on
  // out of the conversation now on screen: ChatInput reports the conversation
  // the file was picked in, and the draft store applies the change there.
  const handleAttachmentsChange = useCallback(
    (
      update: ChatAttachment[] | ((current: ChatAttachment[]) => ChatAttachment[]),
      scopeId?: string | null
    ) => {
      // Analytics is measured against the latest snapshot, while the write
      // itself hands the reducer to the store so React resolves it against
      // committed state -- two files finishing back to back must not drop
      // whichever landed first.
      const current = readDraft(scopeId).attachments;
      const nextAttachments =
        typeof update === "function" ? update(current) : update;
      const addedCount = Math.max(0, nextAttachments.length - current.length);
      if (addedCount > 0) {
        trackProductEvent("file_attached", activeModelCount, {
          attachment_count: addedCount,
        });
      }
      setDraftAttachments(update, scopeId);
    },
    [activeModelCount, readDraft, setDraftAttachments]
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

  // Fired at most once per conversation, right after its first successful
  // response, from handleResponseComplete below. Never awaited by the
  // response-completion path, and every failure mode (network error,
  // non-2xx, provider disabled, invalid output) is swallowed silently here
  // -- the interim title the user already sees simply stays as-is.
  const triggerTitleGeneration = useCallback(
    async (chatId: string, interimTitle: string, firstPromptText: string) => {
      try {
        let result: { updated?: boolean; title?: string } | null = null;
        if (isGuestMode) {
          const sendRequest = (turnstileToken?: string) =>
            fetch("/api/chat/conversation-title", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message: firstPromptText,
                ...(turnstileToken ? { turnstileToken } : {}),
              }),
            });
          const response = await sendRequest();
          // A generated title is a background convenience the user never asked
          // for, so it must never be the reason a verification challenge
          // appears. If the server wants one, this simply stops and the interim
          // title stays -- the server's own verification is untouched.
          if (response.ok) {
            result = await response.json();
          }
        } else {
          const response = await fetch(
            `/api/conversations/${chatId}/generate-title`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ expectedTitle: interimTitle }),
            }
          );
          if (response.ok) {
            result = await response.json();
          }
        }
        // Re-checks the title still equals the interim value at apply time
        // (not just at request time) so a manual rename that lands while
        // this request was in flight is never clobbered -- mirrors the
        // server's own expectedTitle compare-and-set for the logged-in path.
        if (result?.updated && typeof result.title === "string") {
          const finalTitle = result.title;
          setConversations((prev) =>
            prev.map((item) =>
              item.id === chatId && item.title === interimTitle
                ? { ...item, title: finalTitle }
                : item
            )
          );
        }
      } catch {
        // Silent by design -- see comment above.
      }
    },
    [isGuestMode]
  );

  const handleResponseComplete = useCallback(
    (
      promptId: string | null,
      modelId: string,
      responseText: string,
      searchMetadata?: WebSearchExecution | null
    ) => {
      if (
        promptId &&
        responseText.trim() &&
        firstTurnTitleTrackingRef.current.has(promptId)
      ) {
        const tracking = firstTurnTitleTrackingRef.current.get(promptId)!;
        firstTurnTitleTrackingRef.current.delete(promptId);
        if (!titleRequestSentRef.current.has(tracking.chatId)) {
          titleRequestSentRef.current.add(tracking.chatId);
          void triggerTitleGeneration(
            tracking.chatId,
            tracking.interimTitle,
            tracking.firstPromptText
          );
        }
      }
      if (modelId === "perplexity/sonar-deep-research") {
        setIsDeepResearchPending(false);
        trackProductEvent("deep_research_completed", activeModelCount, {});
      }
      // Only counts/enums ever reach analytics here -- never the prompt or
      // any citation text, per the privacy requirement for native search.
      if (searchMetadata?.requested) {
        if (!searchMetadata.supported) {
          trackProductEvent("web_search_native_unsupported", activeModelCount, {
            search_provider: isTrackedSearchProvider(searchMetadata.provider)
              ? searchMetadata.provider
              : undefined,
          });
        } else if (searchMetadata.failureCode) {
          trackProductEvent("web_search_native_failed", activeModelCount, {
            search_provider: isTrackedSearchProvider(searchMetadata.provider)
              ? searchMetadata.provider
              : undefined,
          });
        } else if (searchMetadata.executed) {
          trackProductEvent("web_search_native_executed", activeModelCount, {
            search_provider: isTrackedSearchProvider(searchMetadata.provider)
              ? searchMetadata.provider
              : undefined,
          });
        } else {
          // Native-capable and requested, but the provider chose not to
          // search this turn -- the reserved surcharge is fully refunded
          // server-side (see getSettledUsageCredits' searchExecuted branch).
          trackProductEvent("web_search_native_not_executed", activeModelCount, {
            search_provider: isTrackedSearchProvider(searchMetadata.provider)
              ? searchMetadata.provider
              : undefined,
          });
        }
      }
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
      triggerTitleGeneration,
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
    mutateModelSettings(currentChatId, nextModels, nextDisabled);
    return true;
  };

  // The same entitlement rule swapSelectedModel enforces below, exposed so
  // the outage banner can decide what to *offer* with it instead of only
  // finding out at the moment the user clicks. Retiring Grok 3 / Grok 3 Mini
  // onto the Pro-only Grok 4.5 is what made the difference visible: without
  // this, a Free user's only offered recovery would have been a model the
  // swap handler immediately refuses.
  const canSelectModelForPlan = useCallback(
    (modelId: string) => {
      const model = getModel(modelId);
      if (!model) return false;
      if (!canUseModelWithPlan(currentAccessPlan, model)) return false;
      return isGuestMode
        ? clampGuestSelectedModels([modelId]).includes(modelId)
        : true;
    },
    [clampGuestSelectedModels, currentAccessPlan, getModel, isGuestMode]
  );

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
    mutateModelSettings(currentChatId, nextModels, nextDisabled);
    return true;
  };

  // "항상" now enables each selected model's own provider-native web search
  // tool server-side (see lib/webSearchCapability.ts / app/api/chat/route.ts)
  // for models with confirmed support, instead of forcing a Perplexity
  // model into the selection -- selectedModels and their order are never
  // touched by a web-search-mode change.
  const handleWebSearchModeChange = (mode: WebSearchMode) => {
    updateWebSearchMode(mode);
  };

  // handleGlobalSubmit is redefined every render (not memoized); a ref
  // holding the latest closure lets the effect below call a fresh copy
  // (with the just-updated selectedModels) without needing
  // handleGlobalSubmit itself in the dependency array, which would fire the
  // effect on every render instead of only when selectedModels changes.
  const handleGlobalSubmitRef = useRef(handleGlobalSubmit);
  useEffect(() => {
    handleGlobalSubmitRef.current = handleGlobalSubmit;
  });
  const pendingDeepResearchSubmitRef = useRef<{
    depth: "quick" | "standard" | "deep";
  } | null>(null);

  useEffect(() => {
    if (!pendingDeepResearchSubmitRef.current) return;
    if (!selectedModels.includes("perplexity/sonar-deep-research")) return;
    const { depth } = pendingDeepResearchSubmitRef.current;
    pendingDeepResearchSubmitRef.current = null;
    void handleGlobalSubmitRef.current({ deepResearchDepth: depth });
  }, [selectedModels]);

  const dismissDeepResearchChip = () => {
    setIsDeepResearchPending(false);
    trackProductEvent("deep_research_cancelled", activeModelCount, {});
  };

  const confirmDeepResearchSetup = (depth: "quick" | "standard" | "deep") => {
    if (!inputValue.trim()) return;
    setIsDeepResearchSetupOpen(false);
    setIsDeepResearchPending(true);
    trackProductEvent("deep_research_started", activeModelCount, {
      deep_research_depth: depth,
    });
    const searchModelId = "perplexity/sonar-deep-research";
    if (selectedModels.includes(searchModelId)) {
      void handleGlobalSubmitRef.current({ deepResearchDepth: depth });
      return;
    }
    pendingDeepResearchSubmitRef.current = { depth };
    if (selectedModels.length < maxSelectableModels) {
      toggleModel(searchModelId);
    } else {
      const removeModelId = selectedModels[selectedModels.length - 1];
      if (removeModelId) swapSelectedModel(removeModelId, searchModelId);
    }
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
      setSelectedModels(applied);
      setDisabledPanels([]);
      setPersonalizedPrompt(promptExample || null);
      // Lands on a blank new chat, so only the pending-conversation draft is
      // cleared -- an existing conversation's draft is still waiting there.
      discardDraft(null);
      setPromptPayload(null);
      setFocusToken((current) => current + 1);
    };

  const handleRemoveModel = async (modelId: string) => {
    setPendingRemoveModelId(modelId);
  };

  const executeRemoveModel = async (modelId: string) => {
    const nextModels = selectedModels.filter((id) => id !== modelId);
    const nextDisabled = disabledPanels.filter((id) => id !== modelId);

    mutateModelSettings(currentChatId, nextModels, nextDisabled);

    if (currentChatId) {
      const historyTargetId = accountConversationId(currentChatId);
      if (!historyTargetId) return;
      try {
        await fetch(`/api/conversations/${historyTargetId}/messages?modelId=${modelId}`, {
          method: "DELETE"
        });
      } catch (error) {
        console.error("Failed to delete model history:", error);
        dispatchAppToast(t("chat.modelHistoryDeleteFailed"), "error");
      }
    }
  };

  const togglePanelDisable = (modelId: string) => {
    // Read from the synchronously maintained ref rather than the state
    // closure so two toggles in one tick compose instead of the second
    // overwriting the first.
    const { models, disabled } = latestModelSettingsRef.current;
    const nextDisabled = disabled.includes(modelId)
      ? disabled.filter((id) => id !== modelId)
      : [...disabled, modelId];
    mutateModelSettings(currentChatId, models, nextDisabled);
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

    mutateModelSettings(currentChatId, nextModels, nextDisabled);
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
        setCachedCompareSummaryChatId(conversationId);
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

    /**
     * The latest completed guest turn, read from the same local refs the
     * panels write as answers finish. Called only from event handlers -- never
     * during render -- and shared by both guest comparison actions so the
     * quick summary and the AI Review can never describe different answers.
     */
    const readGuestComparisonTurn = (): GuestReviewSource | null => {
      const promptId = latestLocalComparisonPromptRef.current;
      const question = promptId
        ? localComparisonQuestionsRef.current.get(promptId)
        : undefined;
      const responseMap = promptId
        ? localComparisonResponsesRef.current.get(promptId)
        : undefined;
      if (!promptId || !question || !responseMap || responseMap.size < 2) {
        return null;
      }
      return {
        question,
        language: lang,
        responses: Array.from(responseMap.entries()).map(
          ([modelId, content]) => ({
            messageId: `${promptId}:${modelId}`,
            modelId,
            content,
          })
        ),
      };
    };

    const executeGuestCompareSummary = async () => {
      const turn = readGuestComparisonTurn();
      if (!turn) {
        showToast(t("chat.aiReviewResponsesRequired"), "info");
        return;
      }
      const { question, responses } = turn;
      setIsCompareSummaryLoading(true);
      try {
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
            // User-initiated, so this one may use the shared verification UI.
            const turnstileToken = await requestGuestVerificationToken(
              "guest_quick_summary"
            );
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

    // The guest review's answers are captured at click time, from the same
    // turn the quick summary would use, and handed to the dialog as its
    // source. An account's dialog looks its own turn up by conversation id and
    // needs nothing here.
    const handleComparisonReview = () => {
      if (isGuestMode) {
        const turn = readGuestComparisonTurn();
        if (!turn) {
          showToast(t("chat.aiReviewResponsesRequired"), "info");
          return;
        }
        setGuestReviewSource(turn);
      }
      setShowComparisonReview(true);
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
  const quickModelNames = new Map(
    (compareSummary?.responseMap || []).map((response) => [
      response.responseId,
      response.modelName,
    ])
  );

  // Spendable credits for the comparison actions, using the same allocation
  // rule as the composer's own pre-send guard. Guests (and a not-yet-loaded
  // usage response) report null, which the rail reads as "unknown" and does
  // not gate on.
  const comparisonAvailableCredits = accountUsage
    ? getChatCreditAllocation({
        requiredCredits: 0,
        monthlyPlanCreditsRemaining: accountUsage.balances.planRemainingCredits,
        dailyPlanCreditsRemaining:
          accountUsage.limits.creditsDay > 0
            ? Math.max(
                0,
                accountUsage.limits.creditsDay - accountUsage.usage.creditsDay
              )
            : null,
        purchasedCreditsRemaining:
          accountUsage.balances.purchasedRemainingCredits,
      }).totalCreditsAvailableNow
    : // Guests have a real balance too -- the day/month buckets
      // acquireChatAccess charges -- so the rail can state a shortfall for
      // them the same way it does for an account, instead of treating "guest"
      // as "unknown" and offering a run that would be refused.
      guestUsage?.creditsAvailable ?? null;

  // What this caller may do with the cross-review, decided from server facts
  // rather than from `isGuestMode` at the point of render.
  const aiReviewAccess: AiReviewAccess = !isGuestMode
    ? { kind: "account" }
    : guestUsage?.aiReviewTrial
      ? guestUsage.aiReviewTrial.remaining > 0
        ? {
            kind: "guestTrial",
            trialLimit: guestUsage.aiReviewTrial.limit,
            trialRemaining: guestUsage.aiReviewTrial.remaining,
          }
        : { kind: "guestTrialExhausted", trialLimit: guestUsage.aiReviewTrial.limit }
      : // The snapshot has not arrived yet. Fail closed -- but say so
        // accurately: "log in to unlock" would be a lie to a guest who is
        // about to be told they have a free run.
        { kind: "guestTrialPending" };

  // Local files yes, Google Drive no: Drive needs an OAuth grant an anonymous
  // session cannot hold, and one ephemeral file per message is the guest
  // allowance the server independently enforces.
  const attachmentCapabilities: ChatAttachmentCapabilities = isGuestMode
    ? {
        canAttachLocalFiles: true,
        canConnectGoogleDrive: false,
        maxAttachmentsPerMessage: GUEST_MAX_ATTACHMENTS_PER_MESSAGE,
        maxAttachmentBytes: GUEST_MAX_ATTACHMENT_BYTES,
        attachmentPersistence: "ephemeral",
      }
    : {
        canAttachLocalFiles: true,
        canConnectGoogleDrive: true,
        maxAttachmentsPerMessage: 5,
        maxAttachmentBytes: 10 * 1024 * 1024,
        attachmentPersistence: "account",
      };

  const isQuickSummaryCached = Boolean(
    currentChatId && cachedCompareSummaryChatId === currentChatId
  );

  const deepResearchSetupModel = AVAILABLE_MODELS.find(
    (model) => model.id === "perplexity/sonar-deep-research"
  ) || null;
  const deepResearchEstimatedInputTokens = Math.max(
    1,
    Math.ceil(new TextEncoder().encode(inputValue).length / 4)
  );

  const activeImageConversation = conversations.find(
    (conversation) =>
      conversation.id === currentChatId && conversation.kind === "image"
  );
  const isImageWorkspaceActive =
    !isGuestMode && (isImageDraftActive || Boolean(activeImageConversation));
  // Visible for everyone the flag is on for; locked (never hidden, never
  // dead-ended) for viewers who cannot use it yet (policy §13).
  const imageEntitled =
    !isGuestMode && planAllowsImageGeneration(accountUsage?.plan ?? "Free");
  const canOfferNewImage = imageGenerationEnabled && imageEntitled;
  const imageLock: "sign_in" | "upgrade" | null = !imageGenerationEnabled
    ? null
    : isGuestMode
      ? "sign_in"
      : imageEntitled
        ? null
        : "upgrade";
  const handleLockedImageClick = (lock: "sign_in" | "upgrade") => {
    if (lock === "sign_in") {
      setShowGuestSignInPrompt(true);
      return;
    }
    // Same destination the locked model rows use.
    window.location.assign("/pricing");
  };
  const imageWorkspaceElement = isImageWorkspaceActive ? (
    <ImageGenerationWorkspace
      // Remount on switch: the workspace's local timeline, draft prompt and
      // poll loop all belong to exactly one conversation.
      // Seed ids are deliberately NOT part of this: re-picking a model from
      // the catalogue mid-draft used to remount and discard the typed prompt.
      key={imageWorkspaceKey}
      conversationId={isImageDraftActive ? null : currentChatId}
      onConversationCreated={handleImageConversationCreated}
      initialPrompt={imageDraftSeedPrompt}
      initialModelIds={imageDraftSeedModelIds}
      onCancelDraft={chatDraftBeforeImage ? handleCancelImageDraft : undefined}
      flagEnabled={imageGenerationEnabled}
      planAllowsImageGeneration={
        !isGuestMode && planAllowsImageGeneration(accountUsage?.plan ?? "Free")
      }
    />
  ) : null;

  return (
    <>
      <ModelFinder
        enabled={Boolean(sessionUserId && isUserSettingsLoaded)}
        onComplete={handleModelFinderComplete}
      />
      <DeepResearchSetupSheet
        open={isDeepResearchSetupOpen}
        onClose={() => setIsDeepResearchSetupOpen(false)}
        onConfirm={confirmDeepResearchSetup}
        deepResearchModel={deepResearchSetupModel}
        isGuestMode={isGuestMode}
        isPlanLocked={
          !isGuestMode &&
          Boolean(deepResearchSetupModel) &&
          !canUseModelWithPlan(currentAccessPlan, deepResearchSetupModel!)
        }
        onGuestSignInPrompt={() => setShowGuestSignInPrompt(true)}
        estimatedInputTokens={deepResearchEstimatedInputTokens}
        hasDraftText={Boolean(inputValue.trim())}
      />
      <GuestImportModal
        open={isGuestImportModalOpen}
        conversations={guestImportCandidates}
        defaultConversationId={guestImportDefaultId}
        onSkip={() => closeGuestImportModal(true)}
        onComplete={handleGuestImportComplete}
      />
      {!isViewportReady ? (
        <ChatShellSkeleton label={t("auth.loading")} />
      ) : isMobileViewport ? (
        <MobileChatShell
          conversations={blendedConversations}
          currentChatId={shellConversationId}
          selectedModels={selectedModels}
          disabledPanels={effectiveDisabledPanels}
          promptPayload={promptPayload}
          inputValue={inputValue}
          setInputValue={setInputValue}
          personalizedPrompt={personalizedPrompt}
          attachments={attachments}
          setAttachments={handleAttachmentsChange}
          focusToken={focusToken}
          isGuestMode={isGuestMode}
          guestPreviewMode={isGuestPreviewEntry}
          guestMessageCount={guestMessageCount}
          maxGuestMessages={MAX_GUEST_MESSAGES}
          isModelSelectionReady={isModelSelectionReady}
          onNewChat={handleNewChat}
          onNewImage={canOfferNewImage ? handleNewImage : null}
          imageLock={imageLock}
          onLockedImageClick={handleLockedImageClick}
          onStartImageDraft={canOfferNewImage ? handleStartImageDraft : undefined}
          imageWorkspace={imageWorkspaceElement}
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
          canSelectModel={canSelectModelForPlan}
          webSearchMode={webSearchMode}
          onWebSearchModeChange={handleWebSearchModeChange}
          onOpenDeepResearchSetup={() => setIsDeepResearchSetupOpen(true)}
          isDeepResearchPending={isDeepResearchPending}
          onDismissDeepResearchChip={dismissDeepResearchChip}
          onRequestUndoToast={(message, undo) =>
            showToast(message, "info", { label: t("chat.undo"), onClick: undo })
          }
          onSubmit={handleGlobalSubmit}
          onBeforeModelSend={ensureModelSettingsReady}
          onCompareSummary={handleCompareSummary}
          isCompareSummaryLoading={isCompareSummaryLoading}
          isQuickSummaryCached={isQuickSummaryCached}
          availableCredits={comparisonAvailableCredits}
          aiReviewAccess={aiReviewAccess}
          attachmentCapabilities={attachmentCapabilities}
          onComparisonReview={handleComparisonReview}
          onGuestSignInPrompt={() => setShowGuestSignInPrompt(true)}
          onResponseComplete={handleResponseComplete}
          onFollowupSent={handleModelFollowupSent}
          onContextBundleStale={handleContextBundleStale}
        />
      ) : (
        <DesktopChatShell
          conversations={blendedConversations}
          currentChatId={shellConversationId}
          selectedModels={selectedModels}
          disabledPanels={effectiveDisabledPanels}
          promptPayload={promptPayload}
          inputValue={inputValue}
          setInputValue={setInputValue}
          personalizedPrompt={personalizedPrompt}
          attachments={attachments}
          setAttachments={handleAttachmentsChange}
          focusToken={focusToken}
          isGuestMode={isGuestMode}
          guestPreviewMode={isGuestPreviewEntry}
          guestMessageCount={guestMessageCount}
          maxGuestMessages={MAX_GUEST_MESSAGES}
          isModelSelectionReady={isModelSelectionReady}
          onNewChat={handleNewChat}
          onNewImage={canOfferNewImage ? handleNewImage : null}
          imageLock={imageLock}
          onLockedImageClick={handleLockedImageClick}
          onStartImageDraft={canOfferNewImage ? handleStartImageDraft : undefined}
          imageWorkspace={imageWorkspaceElement}
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
          canSelectModel={canSelectModelForPlan}
          webSearchMode={webSearchMode}
          onWebSearchModeChange={handleWebSearchModeChange}
          onOpenDeepResearchSetup={() => setIsDeepResearchSetupOpen(true)}
          isDeepResearchPending={isDeepResearchPending}
          onDismissDeepResearchChip={dismissDeepResearchChip}
          onSubmit={handleGlobalSubmit}
          onBeforeModelSend={ensureModelSettingsReady}
          onChangePanelModel={changePanelModel}
          onTogglePanelDisable={togglePanelDisable}
          onRemoveModel={handleRemoveModel}
          onCompareSummary={handleCompareSummary}
          isCompareSummaryLoading={isCompareSummaryLoading}
          isQuickSummaryCached={isQuickSummaryCached}
          availableCredits={comparisonAvailableCredits}
          aiReviewAccess={aiReviewAccess}
          attachmentCapabilities={attachmentCapabilities}
          onComparisonReview={handleComparisonReview}
          onGuestSignInPrompt={() => setShowGuestSignInPrompt(true)}
          onResponseComplete={handleResponseComplete}
          onFollowupSent={handleModelFollowupSent}
          onContextBundleStale={handleContextBundleStale}
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
              <span className="text-sm font-bold">{t("chat.continueConversationCta")}</span>
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
        data-testid="app-toast"
        data-tone={toast.tone}
        role={toast.tone === "error" ? "alert" : "status"}
        aria-live={toast.tone === "error" ? "assertive" : "polite"}
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
            className="shrink-0 rounded-lg px-2 py-1 text-sm font-bold text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
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
              className="flex min-h-11 items-center justify-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500"
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
            <p className="text-sm font-bold text-zinc-950 dark:text-white">
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
          className="mt-3 flex min-h-10 w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"
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
            <p className="text-sm font-bold text-zinc-950 dark:text-white">
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
            className="flex min-h-10 items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-center text-xs font-bold text-white hover:bg-blue-500"
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
      <div className="fixed inset-0 z-[130] flex items-end justify-center bg-black/70 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-sm sm:items-center sm:p-4">
        <div
          ref={billingSuccessDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="billing-success-title"
          data-testid="billing-success-dialog"
          className="relative flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-blue-400/30 bg-zinc-950 text-white shadow-2xl shadow-blue-950/40 sm:rounded-3xl"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-gradient-to-br from-blue-500/35 via-blue-400/15 to-zinc-950/0 sm:h-52" />
          <div className="relative overflow-y-auto overscroll-contain px-6 pb-7 pt-6 sm:px-8 sm:pb-8 sm:pt-8">
            <div className="flex items-start justify-between gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500 text-white shadow-lg shadow-blue-500/30">
                <Sparkles className="h-7 w-7" aria-hidden="true" />
              </div>
              <button
                ref={billingSuccessCloseRef}
                type="button"
                data-testid="billing-success-close"
                onClick={closeBillingSuccess}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-zinc-300 transition hover:bg-white/10 hover:text-white"
              >
                {t("billing.close")}
              </button>
            </div>

            <div className="mt-6 sm:mt-7">
              <p className="pb-1 text-xs font-bold uppercase leading-none tracking-[0.24em] text-blue-100">
                {billingSuccess.accessType === "founding_tester_pass"
                  ? t("billing.testerPassActivatedEyebrow")
                  : t("billing.paymentSuccessfulEyebrow")}
              </p>
              <h2 id="billing-success-title" className="mt-3 text-[2rem] font-black leading-tight tracking-tight sm:text-4xl">
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
              <div className="rounded-2xl border border-status-success-500/20 bg-status-success-500/10 p-4">
                <p className="text-xs font-semibold text-status-success-200">{t("billing.status")}</p>
                <p className="mt-1 text-lg font-black text-status-success-200">{t("billing.active")}</p>
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
                data-testid="billing-success-primary"
                onClick={closeBillingSuccess}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-blue-500"
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
                className="inline-flex flex-1 items-center justify-center rounded-2xl border border-white/10 px-5 py-3 text-sm font-bold text-zinc-200 transition hover:bg-white/10 hover:text-white"
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
      <div className="fixed inset-x-0 top-0 z-[130] flex h-[100dvh] items-center justify-center overflow-hidden bg-black/60 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:p-4">
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
              <p className="mt-0.5 text-xs leading-5 text-zinc-400">
                {t("chat.aiReviewedBy")}:{" "}
                {AVAILABLE_MODELS.find((model) => model.id === compareSummary.reviewerModelId)
                  ?.name || compareSummary.reviewerModelId}
              </p>
              {/* Aggregated over every quote in the summary -- common
                  conclusions, important differences and per-model claims
                  alike -- so it belongs to the panel header, not to the
                  consensus section it used to sit inside. */}
              <SourceGroundingBadge
                className="mt-2"
                grounding={toSourceGrounding(compareSummary.result)}
                labels={{
                  label: t("chat.aiReviewSourceGroundingOverall"),
                  unavailable: t("chat.aiReviewSourceGroundingUnavailable"),
                  quotesMatched: t("chat.aiReviewSourceGroundingQuotesMatched"),
                  description: `${t("chat.aiReviewSourceGroundingDescription")}\n\n${t("chat.aiReviewSourceGroundingScopeSummary")}`,
                  infoLabel: t("chat.aiReviewSourceGroundingInfoLabel"),
                }}
                testId="quick-summary-source-grounding"
              />
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
              <h3 className="text-sm font-bold text-blue-950 dark:text-blue-100">
                {t("chat.quickSummaryCommonConclusions")}
              </h3>
              <ul className="mt-3 grid gap-3 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
                {compareSummary.result.commonConclusions.map((item, index) => (
                  <li key={`${index}-${item.text}`} className="flex gap-2">
                    <span className="mt-1 font-bold text-blue-600" aria-hidden="true">•</span>
                    <div className="min-w-0 flex-1">
                      <span>{item.text}</span>
                      {item.citations.map((citation, citationIndex) => (
                        <QuoteBadge
                          key={`${citationIndex}:${citation.responseId}`}
                          quote={citation.quote}
                          verified={citation.verified}
                          sourceLabel={
                            quickModelNames.get(citation.responseId) || citation.responseId
                          }
                          verifiedLabel={t("chat.aiReviewQuoteVerified")}
                          unverifiedLabel={t("chat.aiReviewQuoteUnverified")}
                        />
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section data-testid="quick-summary-differences" className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                {t("chat.quickSummaryImportantDifferences")}
              </h3>
              {compareSummary.result.importantDifferences.length ? (
                <ol className="mt-3 grid gap-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                  {compareSummary.result.importantDifferences.map((item, index) => (
                    <li key={`${index}-${item.text}`} className="flex gap-3">
                      <span className="mt-1 font-bold text-zinc-400">{index + 1}.</span>
                      <div className="min-w-0 flex-1">
                        <span>{item.text}</span>
                        {item.citations.map((citation, citationIndex) => (
                          <QuoteBadge
                            key={`${citationIndex}:${citation.responseId}`}
                            quote={citation.quote}
                            verified={citation.verified}
                            sourceLabel={
                              quickModelNames.get(citation.responseId) || citation.responseId
                            }
                            verifiedLabel={t("chat.aiReviewQuoteVerified")}
                            unverifiedLabel={t("chat.aiReviewQuoteUnverified")}
                          />
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-sm text-zinc-500">{t("chat.quickSummaryNoMeaningfulDifferences")}</p>
              )}
            </section>

            <section data-testid="quick-summary-model-claims">
              <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
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
                      <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                        {model?.modelName || assessment.responseId}
                      </h4>
                      <ul className="mt-2 grid gap-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                        {assessment.claims.map((claim, index) => (
                          <li key={`${index}-${claim.claim}`} className="flex gap-2">
                            <span className="mt-1 text-zinc-400" aria-hidden="true">•</span>
                            <div className="min-w-0 flex-1">
                              <span>{claim.claim}</span>
                              <QuoteBadge
                                quote={claim.quote}
                                verified={claim.verified}
                                sourceLabel={model?.modelName || assessment.responseId}
                                verifiedLabel={t("chat.aiReviewQuoteVerified")}
                                unverifiedLabel={t("chat.aiReviewQuoteUnverified")}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </article>
                  );
                })}
              </div>
            </section>

            <section data-testid="quick-summary-verification" className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/70 dark:bg-amber-950/20">
              <h3 className="text-sm font-bold text-amber-950 dark:text-amber-100">
                {t("chat.quickSummaryVerificationNeeded")}
              </h3>
              {compareSummary.result.verificationNeeded.length ? (
                <ul className="mt-3 grid gap-2 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
                  {compareSummary.result.verificationNeeded.map((item, index) => (
                    <li key={`${index}-${item}`} className="flex gap-2">
                      <span className="font-bold text-amber-600" aria-hidden="true">!</span>
                      <div className="min-w-0 flex-1">
                        <span>{item}</span>
                        {/* Guests never get a persisted conversationId, so
                            the per-item web check (which looks the
                            conversation up server-side) only offers itself
                            once signed in. */}
                        {currentChatId && (
                          <VerifyItemButton
                            conversationId={currentChatId}
                            item={item}
                            checkLabel={t("chat.aiReviewVerifyWithWeb")}
                            checkingLabel={t("chat.aiReviewVerifying")}
                            failedLabel={t("chat.aiReviewVerifyFailed")}
                            statusLabels={{
                              supported: t("chat.aiReviewVerifySupported"),
                              unsupported: t("chat.aiReviewVerifyUnsupported"),
                              inconclusive: t("chat.aiReviewVerifyInconclusive"),
                            }}
                          />
                        )}
                      </div>
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
                <p className="text-sm font-bold text-blue-950 dark:text-blue-100">
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
                  className="mt-3 flex min-h-10 w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500"
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
        conversationId={isGuestMode ? null : currentChatId ?? null}
        guestSource={guestReviewSource}
        open
        onClose={() => setShowComparisonReview(false)}
        onCompleted={() => {
          if (isGuestMode) {
            // The trial slot is spent, so re-read the server's own count
            // rather than decrementing a local copy of it.
            refreshGuestUsage();
            maybeShowGuestSaveReviewCard();
            return;
          }
          maybeShowValueUpgradePrompt("ai_review");
        }}
        onSignIn={() => {
          setShowComparisonReview(false);
          setShowGuestSignInPrompt(true);
        }}
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
      <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4">
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
      <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4">
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
