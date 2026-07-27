"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowUp,
  Boxes,
  Braces,
  Check,
  ChevronDown,
  File as FileIcon,
  FileText,
  HardDrive,
  Globe2,
  Link2,
  Microscope,
  Paperclip,
  Plus,
  Presentation,
  Sheet,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import {
  MAX_SELECTED_MODELS,
  getModelUsageProfile,
  type ChatAttachment,
} from "@/components/chat/types";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { useLanguage } from "@/components/LanguageProvider";
import { FeatureHelpPopover } from "@/components/chat/FeatureHelpPopover";
import { chatHelpCopy } from "@/components/chat/chatHelpCopy";
import { dispatchAppToast } from "@/lib/appToast";
import { APP_DEFAULTS, WEB_SEARCH_MODES, type WebSearchMode } from "@/lib/appDefaults";
import {
  canUseModelWithPlan,
  getInputCreditMultiplier,
  modelSupportsImageInput,
  type AiModel,
} from "@/lib/models";
import { estimateRequestCredits } from "@/lib/webSearchCredits";
import {
  ModelPickerPanel,
  type ModelPickerAnalyticsEvent,
} from "@/components/chat/ModelPickerPanel";
import { useUserUsage } from "@/components/chat/useUserUsage";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";
import {
  trackProductEvent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import {
  CHAT_MODEL_PICKER_OPEN_EVENT,
  type ChatModelPickerOpenDetail,
} from "@/lib/chatModelPickerEvents";
import {
  getComplementaryModelSuggestion,
  getContextualModelSuggestion,
  getModelFinderRecommendations,
  MODEL_FINDER_PRIORITIES,
  MODEL_FINDER_TASKS,
  type ModelFinderPriority,
  type ModelFinderTask,
} from "@/lib/modelFinder";
import { draftSuggestionKey, suggestsCurrentInformationNeeded } from "@/lib/webSearchSuggestion";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import { openModelFinder } from "@/lib/modelFinderEvents";
import { CreditBreakdownSheet } from "@/components/chat/CreditBreakdownSheet";
import { UsageLimitModal } from "@/components/chat/UsageLimitModal";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import { looksLikeStructuredText } from "@/lib/structuredPasteDetection";
import { useIsMobileShell } from "@/components/chat/useIsMobileShell";
import {
  getChatEnterKeyAction,
  isComposingKeydown,
} from "@/lib/chatKeyboardPolicy";

type PublicModelStatus = "available" | "limited" | "unavailable";
type PublicModelStatusRecord = {
  status: PublicModelStatus;
  fallbackModelIds: string[];
};

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_WORKSPACE_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
].join(",");
const RECENT_MODEL_STORAGE_KEY = "recent_model_ids";
const GUEST_QUICK_START_STORAGE_KEY = "tomverse_guest_quick_start_seen_v2";
const GUEST_QUICK_START_ACTIVE_KEY = "tomverse_guest_quick_start_active_v2";
const GUEST_QUICK_START_EVENT = "tomverse:guest-quick-start";
const MOBILE_MODEL_MENU_QUERY = "(max-width: 767px)";
const subscribeToMobileModelMenu = (onChange: () => void) => {
  const mediaQuery = window.matchMedia(MOBILE_MODEL_MENU_QUERY);
  mediaQuery.addEventListener("change", onChange);
  return () => mediaQuery.removeEventListener("change", onChange);
};
const getMobileModelMenuSnapshot = () =>
  window.matchMedia(MOBILE_MODEL_MENU_QUERY).matches;
const getServerMobileModelMenuSnapshot = () => false;

function MobileModelMenuPortal({ children }: { children: ReactNode }) {
  const isMobile = useSyncExternalStore(
    subscribeToMobileModelMenu,
    getMobileModelMenuSnapshot,
    getServerMobileModelMenuSnapshot
  );

  useEffect(() => {
    if (!isMobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile]);

  return isMobile ? createPortal(children, document.body) : children;
}

const interpolateCopy = (
  template: string,
  values: Record<string, string | number>
) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );
const TEXT_FILE_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);
const OFFICE_FILE_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);
const OFFICE_EXTENSION_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};
const ACCEPTED_FILE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  ...TEXT_FILE_TYPES,
  ...OFFICE_FILE_TYPES,
  ...Object.keys(OFFICE_EXTENSION_TYPES).map((extension) => `.${extension}`),
].join(",");

const getFileMediaType = (file: File) => {
  if (TEXT_FILE_TYPES.has(file.type) || OFFICE_FILE_TYPES.has(file.type)) {
    return file.type;
  }
  if (["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(file.type)) {
    return file.type;
  }

  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return OFFICE_EXTENSION_TYPES[extension] || file.type || "application/octet-stream";
};

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("File preview is not readable."));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("File preview failed."));
    reader.readAsDataURL(file);
  });

const hasDraggedFiles = (dataTransfer: DataTransfer | null) =>
  Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));

const getAttachmentLabel = (attachment: ChatAttachment) => {
  const extension = attachment.name.split(".").pop();
  return extension && extension !== attachment.name
    ? extension.toUpperCase()
    : attachment.mediaType.split("/").pop()?.toUpperCase() || "FILE";
};

const getAttachmentIcon = (attachment: ChatAttachment) => {
  if (attachment.mediaType === "application/json") {
    return <Braces className="h-5 w-5" />;
  }
  if (attachment.mediaType === "text/csv") {
    return <Sheet className="h-5 w-5" />;
  }
  if (
    attachment.mediaType.includes("spreadsheet") ||
    attachment.mediaType.includes("opendocument.spreadsheet")
  ) {
    return <Sheet className="h-5 w-5" />;
  }
  if (
    attachment.mediaType.includes("presentation") ||
    attachment.mediaType.includes("opendocument.presentation")
  ) {
    return <Presentation className="h-5 w-5" />;
  }
  if (
    attachment.mediaType === "application/pdf" ||
    attachment.mediaType.startsWith("text/")
  ) {
    return <FileText className="h-5 w-5" />;
  }
  return <FileIcon className="h-5 w-5" />;
};

const loadExternalScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${src}"]`
    );
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = existing || document.createElement("script");
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );
    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load ${src}`)),
      { once: true }
    );

    if (!existing) {
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
  });

type ChatInputProps = {
  value: string;
  onChange: (value: string) => void;
  personalizedPrompt?: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  disabled?: boolean;
  isSending?: boolean;
  focusToken?: number;
  isNewConversation?: boolean;
  currentChatId?: string | null;
  selectedModels: string[];
  disabledModelIds?: string[];
  guestMessageCount?: number;
  maxGuestMessages?: number;
  onToggleModel: (modelId: string) => boolean;
  onSwapModel: (removeModelId: string, addModelId: string) => boolean;
  attachments: ChatAttachment[];
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  canAttach?: boolean;
  isGuestMode?: boolean;
  guestPreviewMode?: boolean;
  variant?: "bar" | "floating";
  // MobileChatShell renders its own copy pinned to the true screen bottom
  // (independent of the composer's floating/docked position) instead of
  // this one, which always sits directly under the input box.
  hideDisclaimer?: boolean;
  webSearchMode?: WebSearchMode;
  onWebSearchModeChange?: (mode: WebSearchMode) => void;
  onOpenDeepResearchSetup?: () => void;
  isDeepResearchPending?: boolean;
  onDismissDeepResearchChip?: () => void;
};

type GooglePickerConfig = {
  clientId: string;
  apiKey: string;
  appId: string;
};

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
};

interface GooglePickerView {
  setIncludeFolders(value: boolean): GooglePickerView;
  setMimeTypes(value: string): GooglePickerView;
}

interface GooglePickerInstance {
  setVisible(value: boolean): void;
}

interface GooglePickerBuilder {
  setAppId(value: string): GooglePickerBuilder;
  setOAuthToken(value: string): GooglePickerBuilder;
  setDeveloperKey(value: string): GooglePickerBuilder;
  addView(value: GooglePickerView): GooglePickerBuilder;
  enableFeature(value: unknown): GooglePickerBuilder;
  setCallback(
    callback: (data: Record<string, unknown>) => void
  ): GooglePickerBuilder;
  build(): GooglePickerInstance;
}

interface GooglePickerWindow extends Window {
  gapi: {
    load(
      name: string,
      options: { callback: () => void; onerror: () => void }
    ): void;
  };
  google: {
    accounts: {
      oauth2: {
        initTokenClient(config: {
          client_id: string;
          scope: string;
          callback: (response: GoogleTokenResponse) => void;
        }): {
          requestAccessToken(options: { prompt: string }): void;
        };
      };
    };
    picker: {
      DocsView: new (viewId: unknown) => GooglePickerView;
      PickerBuilder: new () => GooglePickerBuilder;
      ViewId: { DOCS: unknown };
      Feature: { MULTISELECT_ENABLED: unknown };
      Response: { ACTION: string; DOCUMENTS: string };
      Action: { PICKED: unknown; CANCEL: unknown };
      Document: { ID: string; NAME: string; MIME_TYPE: string };
    };
  };
}

const isGooglePickerConfig = (value: unknown): value is GooglePickerConfig => {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.clientId === "string" &&
    typeof config.apiKey === "string" &&
    typeof config.appId === "string"
  );
};

export function ChatInput({
  value,
  onChange,
  personalizedPrompt,
  onSubmit,
  onCancel,
  disabled = false,
  isSending = false,
  focusToken,
  isNewConversation = true,
  currentChatId = null,
  selectedModels,
  disabledModelIds = [],
  guestMessageCount = 0,
  maxGuestMessages = 20,
  onToggleModel,
  onSwapModel,
  attachments,
  onAttachmentsChange,
  canAttach: canAttachProp = true,
  isGuestMode = false,
  guestPreviewMode = false,
  variant = "bar",
  hideDisclaimer = false,
  webSearchMode = "off",
  onWebSearchModeChange,
  onOpenDeepResearchSetup,
  isDeepResearchPending = false,
  onDismissDeepResearchChip,
}: ChatInputProps) {
  const {
    models: AVAILABLE_MODELS,
    publicModels: PUBLIC_MODELS,
  } = useModelCatalog();
  const PUBLIC_MODEL_IDS = useMemo(
    () => new Set(PUBLIC_MODELS.map((model) => model.id)),
    [PUBLIC_MODELS]
  );
  const isMobileShell = useIsMobileShell();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previousAttachmentsRef = useRef<ChatAttachment[]>([]);
  const hasHandledFocusTokenRef = useRef(false);
  const guestQuickStartActiveRef = useRef(false);
  const trackedLimitScopeRef = useRef<"guest" | "daily" | "monthly" | null>(
    null
  );
  const [isUploading, setIsUploading] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [preserveFormatting, setPreserveFormatting] = useState(false);
  useEffect(() => {
    if (value.trim()) return;
    queueMicrotask(() => setPreserveFormatting(false));
  }, [value]);
  const [showGuestQuickStart, setShowGuestQuickStart] = useState(false);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);
  const [dismissedWebSearchSuggestionKey, setDismissedWebSearchSuggestionKey] = useState<
    string | null
  >(null);
  const [dismissedComplementaryModelId, setDismissedComplementaryModelId] = useState<string | null>(null);
  const [isCreditBreakdownOpen, setIsCreditBreakdownOpen] = useState(false);
  const [isUsageLimitModalOpen, setIsUsageLimitModalOpen] = useState(false);
    const { t, lang } = useLanguage();
    const helpCopy = chatHelpCopy[lang];
    const modelsSelectedLabel = (count: number) =>
      `${count} ${count === 1 ? t("chat.modelsSelectedOne") : t("chat.modelsSelectedOther")}`;
    const signInCallbackUrl = withChatLanguage("/chat", lang);
    const accountUsage = useUserUsage(!isGuestMode);
    const canAttach =
      canAttachProp &&
      !isGuestMode &&
      accountUsage?.limits.allowAttachments !== false;
  const maxSelectableModels = isGuestMode
      ? APP_DEFAULTS.maxGuestSelectedModels
      : accountUsage?.limits.maxModels || MAX_SELECTED_MODELS;
  const disabledModelIdSet = useMemo(
    () => new Set(disabledModelIds),
    [disabledModelIds]
  );
  const activeSelectedModels = useMemo(
    () => selectedModels.filter((modelId) => !disabledModelIdSet.has(modelId)),
    [disabledModelIdSet, selectedModels]
  );
  const activeModelNames = activeSelectedModels
    .map(id => AVAILABLE_MODELS.find(m => m.id === id)?.name)
    .filter(Boolean);
  const hasImageAttachments = useMemo(
    () => attachments.some((attachment) => attachment.mediaType.startsWith("image/")),
    [attachments]
  );
  const imageUnsupportedSelectedModels = useMemo(
    () =>
      hasImageAttachments
        ? activeSelectedModels
            .map((id) => AVAILABLE_MODELS.find((model) => model.id === id))
            .filter(
              (model): model is NonNullable<typeof model> =>
                model !== undefined && !modelSupportsImageInput(model)
            )
        : [],
    [AVAILABLE_MODELS, activeSelectedModels, hasImageAttachments]
  );

  const estimatedInputTokens = useMemo(() => {
    const textParts = [
      value,
      ...attachments
        .filter((attachment) => attachment.kind === "text" && attachment.data)
        .map((attachment) => attachment.data || ""),
    ];
    const textBytes = new TextEncoder().encode(textParts.join("\n\n")).byteLength;
    const binaryAttachmentTokens =
      attachments.filter((attachment) => attachment.kind === "file").length * 16_000;
    return Math.max(1, Math.ceil(textBytes / 4) + binaryAttachmentTokens);
  }, [attachments, value]);
  const inputCreditMultiplier = getInputCreditMultiplier(estimatedInputTokens);
  const activeSelectedModelObjects = activeSelectedModels
    .map((modelId) => AVAILABLE_MODELS.find((item) => item.id === modelId))
    .filter((model): model is AiModel => Boolean(model));
  const requestCreditEstimate = estimateRequestCredits({
    models: activeSelectedModelObjects,
    estimatedInputTokens,
    webSearchMode,
  });
  const selectedBaseCredits = requestCreditEstimate.baseCredits;
  const estimatedRequestCredits = requestCreditEstimate.totalEstimatedCredits;
  const webSearchReservationCredits = requestCreditEstimate.webSearchReservationCredits;
  const creditBreakdown = requestCreditEstimate.models
    .map((entry) => {
      const model = activeSelectedModelObjects.find((item) => item.id === entry.modelId);
      return model
        ? { id: entry.modelId, name: model.name, credits: entry.totalCredits }
        : null;
    })
    .filter((item): item is { id: string; name: string; credits: number } => item !== null);
  const dailyCreditLimit = accountUsage?.limits.creditsDay || 0;
  const planCreditsRemaining = accountUsage?.balances.planRemainingCredits || 0;
  const purchasedCreditsRemaining =
    accountUsage?.balances.purchasedRemainingCredits || 0;
  const dailyPlanCreditsRemaining =
    dailyCreditLimit > 0
      ? Math.max(0, dailyCreditLimit - (accountUsage?.usage.creditsDay || 0))
      : null;
  const creditAllocation = getChatCreditAllocation({
    requiredCredits: estimatedRequestCredits,
    monthlyPlanCreditsRemaining: planCreditsRemaining,
    dailyPlanCreditsRemaining,
    purchasedCreditsRemaining,
  });
  const totalAvailableCredits = creditAllocation.totalAccountCredits;
  // Matches the pre-submit gate in the page-level handler: the modal opens
  // as soon as *this* request would push the guest over the cap, not only
  // once the cumulative counter has already reached it. The two used to
  // disagree, so a request could be silently rejected (toast/inline error)
  // with no login-prompt modal shown.
  const isGuestLimitReached =
    isGuestMode && guestMessageCount + estimatedRequestCredits > maxGuestMessages;
  const isAccountDailyLimitReached =
    !isGuestMode &&
    Boolean(accountUsage) &&
    creditAllocation.dailyPlanGuardrailBlocked;
  const isAccountMonthlyLimitReached =
    !isGuestMode &&
    Boolean(accountUsage) &&
    creditAllocation.balanceInsufficient;
  const isUsageLimitReached =
    isGuestLimitReached || isAccountDailyLimitReached || isAccountMonthlyLimitReached;
  const creditShortfall = Math.max(0, estimatedRequestCredits - totalAvailableCredits);
  const addOnCreditsForRequest =
    !isGuestMode &&
    Boolean(accountUsage) &&
    !isAccountDailyLimitReached &&
    !isAccountMonthlyLimitReached
      ? creditAllocation.addOnCreditsRequired
      : 0;
  const dailyResetLabel = accountUsage?.balances.dailyResetsAt
    ? new Intl.DateTimeFormat(lang, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: accountUsage.timeZone || "UTC",
      }).format(new Date(accountUsage.balances.dailyResetsAt))
    : "";
  const limitScope: "guest" | "daily" | "monthly" | null =
    isGuestLimitReached
      ? "guest"
      : isAccountMonthlyLimitReached
        ? "monthly"
        : isAccountDailyLimitReached
          ? "daily"
          : null;

  const placeholderText = isUsageLimitReached
    ? t("chat.exceedDailyLimit")
    : t("chat.inputPlaceholder");
  
  const isDisabled = disabled || isSending || isUploading || isUsageLimitReached;
  
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"actions" | "models" | "webSearch">("actions");
  const [personalizedRecommendationIds, setPersonalizedRecommendationIds] = useState<string[]>([]);
  const hasRequestedPickerRecommendationsRef = useRef(false);
  const [liveModelStatuses, setLiveModelStatuses] = useState<Record<string, PublicModelStatusRecord>>({});
  const [favoriteModelIds, setFavoriteModelIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem("favorite_model_ids");
      if (!saved) return [];
      const parsed: unknown = JSON.parse(saved);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [replaceModelCandidate, setReplaceModelCandidate] = useState<AiModel | null>(null);
  const [recentModelIds, setRecentModelIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem(RECENT_MODEL_STORAGE_KEY);
      if (!saved) return [];
      const parsed: unknown = JSON.parse(saved);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  });
  const contextualSuggestion = useMemo(
    () =>
      isGuestMode
        ? null
        : getContextualModelSuggestion({ text: value, attachments }),
    [attachments, isGuestMode, value]
  );
  const contextualModel = contextualSuggestion
    ? AVAILABLE_MODELS.find(
        (model) => model.id === contextualSuggestion.modelId && model.enabled
      )
    : undefined;
  const contextualProfile = contextualModel
    ? getModelUsageProfile(contextualModel)
    : null;
  const contextualLiveStatus = contextualModel
    ? liveModelStatuses[contextualModel.id]?.status
    : undefined;
  const showContextualSuggestion = Boolean(
    contextualSuggestion &&
      contextualModel &&
      contextualProfile &&
      contextualSuggestion.key !== dismissedSuggestionKey &&
      !selectedModels.includes(contextualModel.id) &&
      contextualLiveStatus !== "unavailable"
  );
  // "웹 검색: 자동" only ever shows this dismissible suggestion -- it never
  // sends a search on its own. Never shown once a mode is already forced on
  // (nothing to suggest), and never repeats for the exact same draft text.
  const webSearchSuggestionKey =
    webSearchMode === "auto" && suggestsCurrentInformationNeeded(value)
      ? draftSuggestionKey(value)
      : null;
  const showWebSearchSuggestion = Boolean(
    webSearchSuggestionKey && webSearchSuggestionKey !== dismissedWebSearchSuggestionKey
  );
  const trackedWebSearchSuggestionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!showWebSearchSuggestion || !webSearchSuggestionKey) return;
    if (trackedWebSearchSuggestionKeyRef.current === webSearchSuggestionKey) return;
    trackedWebSearchSuggestionKeyRef.current = webSearchSuggestionKey;
    trackProductEvent("web_search_suggestion_shown", selectedModels.length, {});
  }, [showWebSearchSuggestion, webSearchSuggestionKey, selectedModels.length]);
  // Model-picker-only counterpart to the message-content-driven
  // contextualSuggestion above: nudges toward one complementary model based
  // on what kind of thinking the *currently selected* models are missing,
  // shown instead of the full AI-combination questionnaire once the picker
  // already has 2 of the (guest-capped) 3 model slots filled.
  const complementarySuggestion =
    !isGuestMode && selectedModels.length === 2
      ? getComplementaryModelSuggestion(selectedModels)
      : null;
  const complementaryModel = complementarySuggestion
    ? AVAILABLE_MODELS.find(
        (model) => model.id === complementarySuggestion.modelId && model.enabled
      )
    : undefined;
  const complementaryProfile = complementaryModel
    ? getModelUsageProfile(complementaryModel)
    : null;
  const showComplementarySuggestion = Boolean(
    complementarySuggestion &&
      complementaryModel &&
      complementarySuggestion.modelId !== dismissedComplementaryModelId
  );

  const menuRef = useRef<HTMLDivElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  // Set by ModelPickerPanel while the picker is mounted. Escape is layered:
  // the panel closes its filter sheet, then the All-models step, and only
  // returns false once there is nothing left but the dialog itself.
  const modelPickerEscapeRef = useRef<(() => boolean) | null>(null);
  const actionMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const modelSearchInputRef = useRef<HTMLInputElement | null>(null);
  // Not always a button any more: the mobile header's model summary opens this
  // same picker and expects focus back when it closes.
  const lastMenuTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (
      !showContextualSuggestion ||
      !contextualSuggestion ||
      !contextualModel
    ) {
      return;
    }
    trackProductEventOnce(
      `contextual_model_${contextualSuggestion.key}_v1`,
      "advanced_model_suggested",
      activeSelectedModels.length,
      {
        model_id: contextualModel.id,
        suggestion_reason: contextualSuggestion.reason,
      }
    );
  }, [
    contextualModel,
    contextualSuggestion,
    activeSelectedModels.length,
    showContextualSuggestion,
  ]);

  useEffect(() => {
    if (!limitScope || trackedLimitScopeRef.current === limitScope) return;
    trackedLimitScopeRef.current = limitScope;
    setIsUsageLimitModalOpen(true);
    trackProductEvent("credit_limit_hit", activeSelectedModels.length, {
      limit_scope: limitScope,
      current_plan: accountUsage?.plan.toLowerCase() as
        | "free"
        | "pro"
        | "max"
        | undefined,
      plan_credits_remaining: planCreditsRemaining,
      addon_credits_remaining: purchasedCreditsRemaining,
      daily_plan_credits_remaining: dailyPlanCreditsRemaining,
      required_credits: estimatedRequestCredits,
      reset_at: accountUsage?.balances.dailyResetsAt,
    });
    trackProductEvent("upgrade_prompt_view", activeSelectedModels.length, {
      cta_location: "credit_limit_banner",
      limit_scope: limitScope,
      current_plan: accountUsage?.plan.toLowerCase() as
        | "free"
        | "pro"
        | "max"
        | undefined,
      plan_credits_remaining: planCreditsRemaining,
      addon_credits_remaining: purchasedCreditsRemaining,
    });
  }, [
    accountUsage?.balances.dailyResetsAt,
    accountUsage?.plan,
    dailyPlanCreditsRemaining,
    estimatedRequestCredits,
    limitScope,
    planCreditsRemaining,
    purchasedCreditsRemaining,
    activeSelectedModels.length,
  ]);

  const announceGuestQuickStart = useCallback((visible: boolean) => {
    if (visible) {
      window.sessionStorage.setItem(GUEST_QUICK_START_ACTIVE_KEY, "1");
    } else {
      window.sessionStorage.removeItem(GUEST_QUICK_START_ACTIVE_KEY);
    }
    window.dispatchEvent(
      new CustomEvent(GUEST_QUICK_START_EVENT, { detail: { visible } })
    );
  }, []);

  const dismissGuestQuickStart = useCallback(
    (outcome: "completed" | "skipped" = "completed") => {
    if (!guestQuickStartActiveRef.current) return;
    window.localStorage.setItem(GUEST_QUICK_START_STORAGE_KEY, "1");
    guestQuickStartActiveRef.current = false;
    setShowGuestQuickStart(false);
    announceGuestQuickStart(false);
      trackProductEventOnce(
        `guest_quick_start_${outcome}_v2`,
        outcome === "skipped" ? "onboarding_skipped" : "onboarding_completed",
        0,
        { onboarding_id: "guest_quick_start_v2" }
      );
    },
    [announceGuestQuickStart]
  );

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      const shouldShow =
        isGuestMode &&
        !guestPreviewMode &&
        window.localStorage.getItem(GUEST_QUICK_START_STORAGE_KEY) !== "1";

      guestQuickStartActiveRef.current = shouldShow;
      setShowGuestQuickStart(shouldShow);
      announceGuestQuickStart(shouldShow);
      if (shouldShow) {
        trackProductEventOnce(
          "guest_quick_start_shown_v2",
          "onboarding_shown",
          0,
          { onboarding_id: "guest_quick_start_v2" }
        );
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (guestQuickStartActiveRef.current) {
        guestQuickStartActiveRef.current = false;
        announceGuestQuickStart(false);
      }
    };
  }, [announceGuestQuickStart, guestPreviewMode, isGuestMode]);

  const getMenuFocusableElements = useCallback(() => {
    const popover = menuPopoverRef.current;
    if (!popover) return [];

    return Array.from(
      popover.querySelectorAll<HTMLElement>(
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

  const trackModelPickerEvent = useCallback(
    (
      event: ModelPickerAnalyticsEvent,
      properties: { model_id?: string; recommendation_rank?: number } = {}
    ) => {
      // Model names are catalogue metadata, but the search box can contain
      // anything the user typed, so only the fact that a search ran is sent.
      trackProductEvent(event, selectedModels.length, properties);
    },
    [selectedModels.length]
  );

  const closeMenu = useCallback(
    (restoreFocus = true, reason: "done" | "dismissed" = "dismissed") => {
      if (menuView === "models") {
        trackProductEvent(
          reason === "done"
            ? "model_picker_selection_confirmed"
            : "model_picker_abandoned",
          selectedModels.length,
          {}
        );
      }
      setIsMenuOpen(false);
      setMenuView("actions");

      if (restoreFocus) {
        requestAnimationFrame(() => {
          lastMenuTriggerRef.current?.focus();
        });
      }
    },
    [menuView, selectedModels.length]
  );

  // The mobile header's model summary opens this picker rather than shipping a
  // second one with its own copy of the selection state (STG-F009).
  useEffect(() => {
    const openModelPicker = (event: Event) => {
      const { trigger } = (event as CustomEvent<ChatModelPickerOpenDetail>).detail || {};
      lastMenuTriggerRef.current = trigger ?? null;
      setMenuView("models");
      setIsMenuOpen(true);
    };

    window.addEventListener(CHAT_MODEL_PICKER_OPEN_EVENT, openModelPicker);
    return () =>
      window.removeEventListener(CHAT_MODEL_PICKER_OPEN_EVENT, openModelPicker);
  }, []);

  const currentPlan = isGuestMode ? "Guest" : accountUsage?.plan ?? "Free";

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/models/status", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!data || typeof data !== "object") return;
        const records = (data as { models?: unknown }).models;
        if (!Array.isArray(records)) return;
        const next: Record<string, PublicModelStatusRecord> = {};
        for (const item of records) {
          if (!item || typeof item !== "object") continue;
          const record = item as {
            id?: unknown;
            status?: unknown;
            fallbackModelIds?: unknown;
          };
          if (
            typeof record.id === "string" &&
            PUBLIC_MODEL_IDS.has(record.id) &&
            (record.status === "available" ||
              record.status === "limited" ||
              record.status === "unavailable")
          ) {
            const isUnavailable = record.status === "unavailable";
            next[record.id] = {
              status: record.status,
              fallbackModelIds: isUnavailable && Array.isArray(record.fallbackModelIds)
                ? record.fallbackModelIds
                    .filter((id): id is string => typeof id === "string")
                    .filter((id) => PUBLIC_MODEL_IDS.has(id))
                    .slice(0, 3)
                : [],
            };
          }
        }
        setLiveModelStatuses(next);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [PUBLIC_MODEL_IDS]);

  useEffect(() => {
    if (
      !isMenuOpen ||
      menuView !== "models" ||
      isGuestMode ||
      hasRequestedPickerRecommendationsRef.current
    ) {
      return;
    }

    hasRequestedPickerRecommendationsRef.current = true;
    const controller = new AbortController();
    void fetch("/api/user/model-finder", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!data || typeof data !== "object") return;
        const settings = (data as { settings?: unknown }).settings;
        if (!settings || typeof settings !== "object") return;
        const record = settings as Record<string, unknown>;
        if (typeof record.modelFinderCompletedAt !== "string") return;

        const tasks = Array.isArray(record.preferredTasks)
          ? record.preferredTasks.filter(
              (task): task is ModelFinderTask =>
                typeof task === "string" &&
                (MODEL_FINDER_TASKS as readonly string[]).includes(task)
            )
          : [];
        const priority =
          typeof record.preferredPriority === "string" &&
          (MODEL_FINDER_PRIORITIES as readonly string[]).includes(
            record.preferredPriority
          )
            ? (record.preferredPriority as ModelFinderPriority)
            : null;
        if (!tasks.length || !priority) return;
        setPersonalizedRecommendationIds(
          getModelFinderRecommendations({
            tasks,
            priority,
            fileUsage: "rarely",
          }).map((recommendation) => recommendation.modelId)
        );
      })
      .catch(() => {});

    return () => controller.abort();
  }, [isGuestMode, isMenuOpen, menuView]);

  const rememberRecentModel = (modelId: string) => {
    setRecentModelIds((current) => {
      const next = [modelId, ...current.filter((id) => id !== modelId)].slice(0, 6);
      localStorage.setItem(RECENT_MODEL_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        !menuPopoverRef.current?.contains(target)
      ) {
        closeMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeMenu]);

  // The desktop popover is anchored to the bottom of the toolbar row via
  // `bottom: 3rem`, so its bottom edge never moves — only its height does.
  // `getBoundingClientRect().bottom` therefore tells us exactly how much
  // vertical space is actually available above it on screen (accounting for
  // the real input-bar height, browser zoom, and short viewports), which a
  // static `calc(100dvh - 8rem)` cap can't know. Runs before paint so an
  // oversized first layout never flashes.
  useLayoutEffect(() => {
    if (!isMenuOpen) return;

    const popover = menuPopoverRef.current;
    if (!popover) return;

    const desktopQuery = window.matchMedia("(min-width: 768px)");

    const clampPopoverHeight = () => {
      if (!desktopQuery.matches) {
        popover.style.maxHeight = "";
        return;
      }

      const topMargin = 16;
      const minHeight = 240;
      const available = popover.getBoundingClientRect().bottom - topMargin;
      popover.style.maxHeight = `${Math.max(minHeight, available)}px`;
    };

    clampPopoverHeight();
    window.addEventListener("resize", clampPopoverHeight);
    desktopQuery.addEventListener("change", clampPopoverHeight);

    return () => {
      window.removeEventListener("resize", clampPopoverHeight);
      desktopQuery.removeEventListener("change", clampPopoverHeight);
      popover.style.maxHeight = "";
    };
  }, [isMenuOpen, menuView]);

  useEffect(() => {
    if (!isMenuOpen) return;

    const animationFrame = requestAnimationFrame(() => {
      const isTouchLikeDevice =
        typeof window !== "undefined" &&
        window.matchMedia("(pointer: coarse)").matches;

      if (isTouchLikeDevice) {
        menuPopoverRef.current?.focus({ preventScroll: true });
        return;
      }

      if (menuView === "models") {
        modelSearchInputRef.current?.focus();
        return;
      }

      getMenuFocusableElements()[0]?.focus();
    });

    return () => cancelAnimationFrame(animationFrame);
  }, [getMenuFocusableElements, isMenuOpen, menuView]);

  useEffect(() => {
    if (!isMenuOpen) return;

    const handleMenuKeyDown = (event: KeyboardEvent) => {
      const focusableElements = getMenuFocusableElements();
      const activeElement = document.activeElement as HTMLElement | null;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (menuView === "models" && modelPickerEscapeRef.current?.()) return;
        closeMenu(true);
        return;
      }

      if (event.key === "Tab") {
        if (focusableElements.length === 0) {
          event.preventDefault();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (!activeElement || !menuPopoverRef.current?.contains(activeElement)) {
          event.preventDefault();
          firstElement.focus();
          return;
        }

        if (event.shiftKey && activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
          return;
        }

        if (!event.shiftKey && activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
        return;
      }

      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }

      if (activeElement instanceof HTMLSelectElement) return;
      if (focusableElements.length === 0) return;

      event.preventDefault();

      const currentIndex = Math.max(
        0,
        focusableElements.indexOf(activeElement as HTMLElement)
      );

      if (event.key === "Home") {
        focusableElements[0].focus();
        return;
      }

      if (event.key === "End") {
        focusableElements[focusableElements.length - 1].focus();
        return;
      }

      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (currentIndex + direction + focusableElements.length) %
        focusableElements.length;
      focusableElements[nextIndex].focus();
    };

    document.addEventListener("keydown", handleMenuKeyDown, true);
    return () => document.removeEventListener("keydown", handleMenuKeyDown, true);
  }, [closeMenu, getMenuFocusableElements, isMenuOpen, menuView]);

  const toggleFavoriteModel = (modelId: string) => {
    setFavoriteModelIds((current) => {
      const next = current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId];
      localStorage.setItem("favorite_model_ids", JSON.stringify(next));
      return next;
    });
  };
  
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    if (focusToken === undefined) return;
    if (!hasHandledFocusTokenRef.current) {
      hasHandledFocusTokenRef.current = true;
      return;
    }

    const shouldAutoFocus =
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 768px)").matches &&
      !window.matchMedia("(pointer: coarse)").matches;

    if (!shouldAutoFocus) return;

    const id = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });

    return () => cancelAnimationFrame(id);
  }, [focusToken]);

  useEffect(() => {
    const currentIds = new Set(attachments.map((attachment) => attachment.id));

    previousAttachmentsRef.current.forEach((attachment) => {
      if (
        !currentIds.has(attachment.id) &&
        attachment.data?.startsWith("blob:")
      ) {
        URL.revokeObjectURL(attachment.data);
      }
    });

    previousAttachmentsRef.current = attachments;
  }, [attachments]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = getChatEnterKeyAction(
      e,
      isComposingKeydown(e),
      isMobileShell
    );
    if (action !== "submit") return;

    e.preventDefault();
    if (!isDisabled) {
      dismissGuestQuickStart();
      onSubmit();
    }
  };

  const handleFilesSelected = async (files: FileList | File[] | null) => {
    if (!files?.length) return;

    const availableSlots = MAX_ATTACHMENTS - attachments.length;
    if (availableSlots <= 0) {
      dispatchAppToast(t("chat.attachmentCountError"), "error");
      return;
    }

    const selectedFiles = Array.from(files).slice(0, availableSlots);
    const nextAttachments: ChatAttachment[] = [];
    setIsUploading(true);

    try {
      for (const file of selectedFiles) {
        const mediaType = getFileMediaType(file);
        if (
          !ACCEPTED_FILE_TYPES.split(",").includes(mediaType) &&
          !OFFICE_FILE_TYPES.has(mediaType)
        ) {
          dispatchAppToast(t("chat.attachmentTypeError"), "error");
          continue;
        }
        if (file.size > MAX_ATTACHMENT_SIZE) {
          dispatchAppToast(t("chat.attachmentSizeError"), "error");
          continue;
        }

        const prepareResponse = await fetch("/api/chat", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: file.name,
            mediaType,
            size: file.size,
          }),
        });
        if (!prepareResponse.ok) {
          throw new Error("Failed to prepare upload.");
        }

        const { key, uploadUrl, uploadHeaders } = await prepareResponse.json();
        const uploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          headers:
            uploadHeaders && typeof uploadHeaders === "object"
              ? (uploadHeaders as Record<string, string>)
              : { "Content-Type": mediaType },
          body: file,
        });
        if (!uploadResponse.ok) {
          throw new Error(`R2 upload failed: ${uploadResponse.status}`);
        }
        const finalizeResponse = await fetch("/api/chat", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key,
            mediaType,
            size: file.size,
          }),
        });
        if (!finalizeResponse.ok) {
          throw new Error(`R2 validation failed: ${finalizeResponse.status}`);
        }
        const finalized = await finalizeResponse.json();

        nextAttachments.push({
          id: crypto.randomUUID(),
          name: file.name,
          mediaType,
          size: finalized.size || file.size,
          objectKey: key,
          data: mediaType.startsWith("image/")
            ? await fileToDataUrl(file)
            : undefined,
          kind: TEXT_FILE_TYPES.has(mediaType) ? "text" : "file",
        });
      }

      onAttachmentsChange([...attachments, ...nextAttachments]);
    } catch (error) {
      console.error("Attachment upload failed:", error);
      dispatchAppToast(t("chat.attachmentUploadError"), "error");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
    };

    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  const handleDropZoneDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(true);
  };

  const handleDropZoneDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = canAttach ? "copy" : "none";
    setIsDragActive(true);
  };

  const handleDropZoneDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragActive(false);
    }
  };

  const handleDropZoneDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);

    if (!canAttach) {
      dispatchAppToast(t("chat.loginToAttach"), "info");
      return;
    }

    void handleFilesSelected(event.dataTransfer.files);
  };

    const handlePaste = (
        event: React.ClipboardEvent<HTMLTextAreaElement>
    ) => {
        const pastedFiles = Array.from(event.clipboardData.files);

        if (pastedFiles.length === 0) {
            const pastedText = event.clipboardData.getData("text/plain");
            if (looksLikeStructuredText(pastedText)) {
                setPreserveFormatting(true);
            }
            return;
        }

        event.preventDefault();

        if (!canAttach) {
            dispatchAppToast(t("chat.loginToAttach"), "info");
            return;
        }

        void handleFilesSelected(pastedFiles);
    };

  const handleGoogleDriveSelect = async () => {
    if (!canAttach || isUploading) return;

    const availableSlots = MAX_ATTACHMENTS - attachments.length;
    if (availableSlots <= 0) {
      dispatchAppToast(t("chat.attachmentCountError"), "error");
      return;
    }

    setIsUploading(true);
    try {
      const configResponse = await fetch("/api/chat");
      if (!configResponse.ok) {
        throw new Error("Google Picker configuration is unavailable.");
      }
      const config: unknown = await configResponse.json();
      if (!isGooglePickerConfig(config)) {
        throw new Error("Google Picker configuration is invalid.");
      }

      await Promise.all([
        loadExternalScript("https://accounts.google.com/gsi/client"),
        loadExternalScript("https://apis.google.com/js/api.js"),
      ]);

      const browserWindow = window as unknown as GooglePickerWindow;
      await new Promise<void>((resolve, reject) => {
        browserWindow.gapi.load("picker", {
          callback: resolve,
          onerror: () => reject(new Error("Google Picker failed to load.")),
        });
      });

      const accessToken = await new Promise<string>((resolve, reject) => {
        const tokenClient = browserWindow.google.accounts.oauth2.initTokenClient({
          client_id: config.clientId,
          scope: GOOGLE_DRIVE_SCOPE,
          callback: (response: GoogleTokenResponse) => {
            if (response.error || !response.access_token) {
              reject(new Error(response.error || "Google authorization failed."));
              return;
            }
            resolve(response.access_token);
          },
        });
        tokenClient.requestAccessToken({ prompt: "" });
      });

      const selectedFiles = await new Promise<
        Array<{ id: string; name: string; mimeType: string }>
      >((resolve) => {
        const google = browserWindow.google;
        const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
          .setIncludeFolders(false)
          .setMimeTypes(GOOGLE_WORKSPACE_TYPES);
        const picker = new google.picker.PickerBuilder()
          .setAppId(config.appId)
          .setOAuthToken(accessToken)
          .setDeveloperKey(config.apiKey)
          .addView(view)
          .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
          .setCallback((data: Record<string, unknown>) => {
            const action = data[google.picker.Response.ACTION];
            if (action === google.picker.Action.PICKED) {
              const documents = data[google.picker.Response.DOCUMENTS];
              resolve(
                (Array.isArray(documents) ? documents : []).flatMap(
                  (document): Array<{
                    id: string;
                    name: string;
                    mimeType: string;
                  }> => {
                    if (!document || typeof document !== "object") return [];
                    const record = document as Record<string, unknown>;
                    const id = record[google.picker.Document.ID];
                    const name = record[google.picker.Document.NAME];
                    const mimeType =
                      record[google.picker.Document.MIME_TYPE];
                    return typeof id === "string" &&
                      typeof name === "string" &&
                      typeof mimeType === "string"
                      ? [{ id, name, mimeType }]
                      : [];
                  }
                )
              );
            } else if (action === google.picker.Action.CANCEL) {
              resolve([]);
            }
          })
          .build();
        picker.setVisible(true);
      });

      const importedAttachments: ChatAttachment[] = [];
      for (const file of selectedFiles.slice(0, availableSlots)) {
        const response = await fetch("/api/chat", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "google-drive-import",
            fileId: file.id,
            name: file.name,
            mediaType: file.mimeType,
            accessToken,
          }),
        });
        if (!response.ok) {
          throw new Error(`Google Drive import failed: ${response.status}`);
        }

        const imported = await response.json();
        importedAttachments.push({
          id: crypto.randomUUID(),
          name: imported.name,
          mediaType: imported.mediaType,
          size: imported.size,
          objectKey: imported.key,
          kind: imported.kind,
        });
      }

      if (importedAttachments.length > 0) {
        onAttachmentsChange([...attachments, ...importedAttachments]);
      }
    } catch (error) {
      console.error("Google Drive attachment failed:", error);
      dispatchAppToast(t("chat.googleDriveError"), "error");
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveAttachment = async (attachment: ChatAttachment) => {
    onAttachmentsChange(
      attachments.filter((item) => item.id !== attachment.id)
    );

    if (!attachment.objectKey) return;

    try {
      const response = await fetch("/api/chat", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: attachment.objectKey }),
      });
      if (!response.ok) {
        throw new Error(`R2 deletion failed: ${response.status}`);
      }
    } catch (error) {
      console.error("Attachment deletion failed:", error);
    }
  };

  // Drives which model-picker layout renders below: the original compact,
  // single-scroll mobile sheet (filters scroll away together with the
  // list, matching this same breakpoint's MobileModelMenuPortal decision
  // above) vs. the wider two-pane modal on desktop.
  const isMobileModelMenu = useSyncExternalStore(
    subscribeToMobileModelMenu,
    getMobileModelMenuSnapshot,
    getServerMobileModelMenuSnapshot
  );

  return (
      <div className={variant === "floating"
        ? "w-full max-w-full shrink-0 overflow-hidden px-0 py-0 md:overflow-visible"
        : "w-full max-w-full shrink-0 overflow-hidden border-t border-zinc-200 bg-zinc-50/95 px-2 py-1 pb-[calc(0.3rem+env(safe-area-inset-bottom))] transition-colors dark:border-zinc-800 dark:bg-zinc-950 md:overflow-visible md:px-6 md:py-3 md:pb-3"
      }>
          <div
            data-testid="chat-input"
            onDragEnter={handleDropZoneDragEnter}
            onDragOver={handleDropZoneDragOver}
            onDragLeave={handleDropZoneDragLeave}
            onDrop={handleDropZoneDrop}
            className={`relative mx-auto w-full max-w-4xl overflow-hidden rounded-[1.4rem] border bg-white p-1.5 shadow-lg shadow-zinc-200/50 transition-colors dark:bg-zinc-900 dark:shadow-black/20 md:overflow-visible md:rounded-2xl md:p-3 ${
              isDragActive
                ? "border-blue-500 bg-blue-50/70 dark:border-blue-400 dark:bg-blue-950/30"
                : "border-zinc-200 dark:border-zinc-800"
            }`}
          >
          {isDragActive && (
            <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border border-dashed border-blue-400 bg-white/85 text-center shadow-sm backdrop-blur-sm dark:bg-zinc-950/85">
              <div className="flex flex-col items-center gap-2 px-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm shadow-blue-950/20">
                  <Paperclip className="h-5 w-5" />
                </span>
                <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  {canAttach ? t("chat.dropFilesHere") : t("chat.loginToAttach")}
                </span>
                {canAttach && (
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {t("chat.dropFilesDescription")}
                  </span>
                )}
              </div>
            </div>
          )}
          {addOnCreditsForRequest > 0 && (
            <div className="mb-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold leading-5 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
              {interpolateCopy(t("chat.addOnCreditsWillBeUsed"), {
                credits: addOnCreditsForRequest,
              })}
            </div>
          )}
          {isUsageLimitReached && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              <span className="font-black">
                {isGuestMode ? t("chat.guestLimitReachedTitle") : t("chat.accountLimitReachedTitle")}
              </span>
              <button
                type="button"
                data-testid="usage-limit-view-options"
                onClick={() => setIsUsageLimitModalOpen(true)}
                className="shrink-0 font-black text-amber-900 underline underline-offset-2 dark:text-amber-100"
              >
                {t("chat.viewOptions")}
              </button>
            </div>
          )}
          {isGuestMode && showGuestQuickStart && (
            <div
              data-testid="guest-quick-start"
              className="mb-2 flex items-center gap-1.5 px-1"
            >
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                {t("chat.guestQuickLine")}
              </span>
              <FeatureHelpPopover
                title={t("chat.guestQuickLineHelp")}
                description={t("chat.guestQuickLineHelpBody")}
                buttonLabel={t("chat.guestQuickLineHelp")}
                learnMoreLabel={helpCopy.learnMore}
                topic="guest_trial"
                align="right"
                testId="guest-quick-start-help"
              />
            </div>
          )}
          {isNewConversation && !value.trim() && attachments.length === 0 && personalizedPrompt && (
            <div className="mb-2 flex max-w-full gap-2 overflow-x-auto overscroll-x-contain pb-1 md:flex-wrap md:overflow-visible md:pb-0">
              <button
                type="button"
                onClick={() => {
                  dismissGuestQuickStart();
                  onChange(personalizedPrompt);
                }}
                className="shrink-0 touch-manipulation rounded-full border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200 dark:hover:bg-blue-950/60"
              >
                {personalizedPrompt}
              </button>
            </div>
          )}
          {showContextualSuggestion &&
            contextualSuggestion &&
            contextualModel &&
            contextualProfile && (
              <div className="mb-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 dark:border-amber-900/60 dark:bg-amber-950/20">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-black text-zinc-900 dark:text-white">
                      {t(
                        contextualSuggestion.reason === "research"
                          ? "modelFinder.contextualTitleResearch"
                          : "modelFinder.contextualTitleDeep"
                      )}
                    </p>
                    <p className="mt-1 text-[11px] leading-5 text-zinc-600 dark:text-zinc-300">
                      {t("modelFinder.contextualCreditNotice")
                        .replace(
                          "{category}",
                          t(
                            `modelUsageClasses.${contextualProfile.category.toLowerCase()}`
                          )
                        )
                        .replace("{credits}", String(contextualProfile.credits))}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const added = onToggleModel(contextualModel.id);
                        if (!added) return;
                        setDismissedSuggestionKey(contextualSuggestion.key);
                        trackProductEvent(
                          "advanced_model_selected",
                          selectedModels.length + 1,
                          {
                            model_id: contextualModel.id,
                            suggestion_reason: contextualSuggestion.reason,
                          }
                        );
                      }}
                      className="rounded-xl bg-amber-600 px-3 py-2 text-[11px] font-black text-white hover:bg-amber-500"
                    >
                      {t("modelFinder.contextualUse").replace(
                        "{model}",
                        contextualModel.name
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDismissedSuggestionKey(contextualSuggestion.key)
                      }
                      className="rounded-xl border border-amber-300 bg-white px-3 py-2 text-[11px] font-bold text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-zinc-950 dark:text-amber-200"
                    >
                      {t("modelFinder.contextualContinue")}
                    </button>
                  </div>
                </div>
              </div>
            )}
          {showWebSearchSuggestion && (
            <div
              data-testid="web-search-auto-suggestion"
              className="mb-2 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-3 dark:border-sky-900/60 dark:bg-sky-950/20"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-black text-zinc-900 dark:text-white">
                    {t("chat.webSearchSuggestionTitle")}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    data-testid="web-search-suggestion-accept"
                    onClick={() => {
                      onWebSearchModeChange?.("always");
                      trackProductEvent(
                        "web_search_suggestion_accepted",
                        selectedModels.length,
                        {}
                      );
                      if (webSearchSuggestionKey) {
                        setDismissedWebSearchSuggestionKey(webSearchSuggestionKey);
                      }
                    }}
                    className="rounded-xl bg-sky-600 px-3 py-2 text-[11px] font-black text-white hover:bg-sky-500"
                  >
                    {t("chat.webSearchSuggestionAccept")}
                  </button>
                  <button
                    type="button"
                    data-testid="web-search-suggestion-decline"
                    onClick={() => {
                      trackProductEvent(
                        "web_search_suggestion_declined",
                        selectedModels.length,
                        {}
                      );
                      if (webSearchSuggestionKey) {
                        setDismissedWebSearchSuggestionKey(webSearchSuggestionKey);
                      }
                    }}
                    className="rounded-xl border border-sky-300 bg-white px-3 py-2 text-[11px] font-bold text-sky-900 hover:bg-sky-100 dark:border-sky-800 dark:bg-zinc-950 dark:text-sky-200"
                  >
                    {t("chat.webSearchSuggestionDecline")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {(webSearchMode !== "off" || isDeepResearchPending) && (
            <div
              data-testid="tool-status-chip-row"
              className="mb-2 flex max-w-full gap-1.5 overflow-x-auto overscroll-x-contain pb-1 md:mb-3 md:flex-wrap md:overflow-visible md:pb-0"
            >
              {webSearchMode !== "off" && (
                <div
                  data-testid="web-search-mode-chip"
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 pl-3 pr-1.5 text-xs font-bold text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200"
                >
                  <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    {t("chat.toolsWebSearch")} ·{" "}
                    {webSearchMode === "always"
                      ? t("chat.toolsWebSearchAlways")
                      : t("chat.toolsWebSearchAuto")}
                  </span>
                  <button
                    type="button"
                    onClick={() => onWebSearchModeChange?.("off")}
                    aria-label={t("chat.removeWebSearchMode")}
                    title={t("chat.removeWebSearchMode")}
                    className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sky-500 before:absolute before:content-[''] hover:bg-sky-100 dark:hover:bg-sky-900/40 ${isMobileShell ? "before:-inset-2.5" : "before:-inset-1"}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {isDeepResearchPending && (
                <div
                  data-testid="deep-research-chip"
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 pl-3 pr-1.5 text-xs font-bold text-violet-800 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-200"
                  title={t("chat.deepResearchChipTooltip")}
                >
                  <Microscope className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{t("chat.deepResearchChipLabel")}</span>
                  <button
                    type="button"
                    onClick={() => onDismissDeepResearchChip?.()}
                    aria-label={t("chat.removeDeepResearchChip")}
                    title={t("chat.removeDeepResearchChip")}
                    className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-violet-500 before:absolute before:content-[''] hover:bg-violet-100 dark:hover:bg-violet-900/40 ${isMobileShell ? "before:-inset-2.5" : "before:-inset-1"}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
          {webSearchMode === "always" && selectedModels.length > 0 && (() => {
            const supportedCount = selectedModels.filter((id) => {
              const support = getWebSearchCapability(id).support;
              return support === "native" || support === "search-model";
            }).length;
            const unsupportedCount = selectedModels.length - supportedCount;
            return (
              <p
                data-testid="web-search-readiness-summary"
                className="mb-2 px-1 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400"
              >
                {t("chat.webSearchReadinessSummary")
                  .replace("{supported}", String(supportedCount))
                  .replace("{unsupported}", String(unsupportedCount))}
              </p>
            );
          })()}
          {attachments.length > 0 && (
            <div className="mb-2 rounded-2xl bg-zinc-50 p-1.5 dark:bg-zinc-950/70 md:mb-3 md:bg-transparent md:p-0">
            <div className="flex max-w-full gap-2 overflow-x-auto overscroll-x-contain pb-1 md:flex-wrap md:overflow-visible md:pb-0">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className={
                    attachment.data
                      ? "relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 md:h-20 md:w-20"
                      : "relative flex h-14 min-w-44 max-w-56 shrink-0 items-center gap-2.5 rounded-xl border border-zinc-200 bg-white py-2 pl-2 pr-8 text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 md:h-16 md:min-w-52 md:max-w-64"
                  }
                >
                  {attachment.data ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={attachment.data}
                      alt={attachment.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <>
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700">
                        {getAttachmentIcon(attachment)}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {attachment.name}
                        </span>
                        <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500">
                          {getAttachmentLabel(attachment)}
                        </span>
                      </span>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemoveAttachment(attachment)}
                    className={`relative before:absolute before:content-[''] ${isMobileShell ? "before:-inset-3" : "before:-inset-1"} ${
                      attachment.data
                        ? "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-950/80 text-white hover:bg-zinc-950"
                        : "absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-700 dark:hover:text-white"
                    }`}
                    title={t("chat.removeAttachment")}
                    aria-label={t("chat.removeAttachment")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            </div>
          )}
          {imageUnsupportedSelectedModels.length > 0 && (
            <div
              role="status"
              data-testid="image-model-compatibility-warning"
              className="mb-2 flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100 sm:flex-row sm:items-center"
            >
              <p className="min-w-0 flex-1 leading-5">
                <span className="font-black">{t("chat.imageUnsupportedSelected")}</span>{" "}
                {imageUnsupportedSelectedModels.map((model) => model.name).join(", ")}
              </p>
              <button
                type="button"
                onClick={() => {
                  imageUnsupportedSelectedModels.forEach((model) =>
                    onToggleModel(model.id)
                  );
                }}
                className="shrink-0 rounded-lg border border-amber-400 bg-white px-2.5 py-1.5 font-bold text-amber-900 transition hover:bg-amber-100 dark:border-amber-700 dark:bg-zinc-950 dark:text-amber-100 dark:hover:bg-amber-950/60"
              >
                {t("chat.removeImageUnsupportedModels")}
              </button>
            </div>
          )}
          <div className="flex flex-col gap-2">
        {preserveFormatting && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-zinc-100 px-2 py-1 text-[11px] font-semibold text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            <span>{t("chat.formatPreserved")}</span>
            <button
              type="button"
              data-testid="convert-to-plain-text"
              onClick={() => setPreserveFormatting(false)}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-blue-600 transition hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
            >
              {t("chat.convertToPlainText")}
            </button>
          </div>
        )}
        <textarea
          data-testid="chat-textarea"
          ref={textareaRef}
          value={value}
          wrap={preserveFormatting ? "off" : "soft"}
          onFocus={() => dismissGuestQuickStart("completed")}
          onChange={(e) => {
            if (e.target.value) dismissGuestQuickStart();
            onChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label={placeholderText}
          placeholder={placeholderText}
          disabled={isDisabled}
          enterKeyHint={isMobileShell ? "enter" : undefined}
          rows={1}
          className={`w-full max-h-[92px] min-h-[36px] resize-none overflow-y-auto border-0 bg-transparent px-1 py-1.5 text-base leading-5 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:text-zinc-100 dark:placeholder:text-zinc-500 md:max-h-[200px] md:min-h-[52px] md:py-2 md:text-sm md:leading-6 ${preserveFormatting ? "overflow-x-auto whitespace-pre font-mono" : ""}`}
        />
        <div className="relative flex items-center justify-between gap-1.5" ref={menuRef}>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            ref={actionMenuButtonRef}
            type="button"
            onClick={() => {
              lastMenuTriggerRef.current = actionMenuButtonRef.current;
              const shouldClose = isMenuOpen && menuView === "actions";
              if (shouldClose) {
                closeMenu(true);
                return;
              }
              setMenuView("actions");
              setIsMenuOpen(true);
              trackProductEvent("chat_tool_menu_opened", selectedModels.length, {});
            }}
            className={`flex shrink-0 touch-manipulation items-center justify-center rounded-full border border-zinc-300 bg-zinc-50 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white ${isMobileShell ? "h-11 w-11" : "h-10 w-10"}`}
            title={t("chat.moreActions")}
            aria-label={t("chat.moreActions")}
            aria-expanded={isMenuOpen && menuView === "actions"}
            aria-controls="chat-input-popover"
            aria-haspopup="dialog"
          >
            {isUploading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Plus className="h-5 w-5" />
            )}
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            ref={modelMenuButtonRef}
            type="button"
            onClick={() => {
              lastMenuTriggerRef.current = modelMenuButtonRef.current;
              const shouldClose = isMenuOpen && menuView === "models";
              if (shouldClose) {
                closeMenu(true);
                return;
              }
              setMenuView("models");
              setIsMenuOpen(true);
              trackProductEvent("model_picker_opened", selectedModels.length, {});
            }}
            className={`flex max-w-[112px] shrink-0 touch-manipulation items-center gap-1 rounded-full border border-zinc-300 bg-zinc-50 px-2.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800 ${isMobileShell ? "h-11" : "h-10"}`}
            title={activeModelNames.join(", ")}
            aria-label={t("chat.modelSelect")}
            aria-expanded={isMenuOpen && menuView === "models"}
            aria-controls="chat-input-popover"
            aria-haspopup="dialog"
          >
            {/* Counts what will actually be sent and billed -- the same basis
                as the credit estimate beside it and as the mobile header's
                "+N", so a paused panel cannot make the two disagree. */}
            {activeSelectedModels.length === 1 ? (
              <ModelLogo
                model={AVAILABLE_MODELS.find((item) => item.id === activeSelectedModels[0])}
                size="xs"
              />
            ) : (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[9px] font-black text-white">
                {activeSelectedModels.length}
              </span>
            )}
            <span
              data-testid="composer-active-model-count"
              className="min-w-0 truncate whitespace-nowrap"
            >
              {modelsSelectedLabel(activeSelectedModels.length)}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          </button>

          {activeSelectedModels.length > 0 && (
            <button
              type="button"
              data-testid="request-credit-estimate"
              onClick={() => setIsCreditBreakdownOpen(true)}
              className={`flex shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 text-[11px] font-bold text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 ${isMobileShell ? "h-11" : "h-9"}`}
              title={
                lang === "ko"
                  ? `예상 ${estimatedRequestCredits}크레딧${inputCreditMultiplier > 1 ? ` · ${inputCreditMultiplier}×` : ""}`
                  : `Estimated ${estimatedRequestCredits} credits${inputCreditMultiplier > 1 ? ` · ${inputCreditMultiplier}×` : ""}`
              }
              aria-label={
                lang === "ko"
                  ? `예상 ${estimatedRequestCredits}크레딧, 상세 보기`
                  : `Estimated ${estimatedRequestCredits} credits, view breakdown`
              }
            >
              <CreditCostBadge
                credits={estimatedRequestCredits}
                size="xs"
                tone="plain"
                label={String(estimatedRequestCredits)}
                title=""
                className="px-0"
              />
              {inputCreditMultiplier > 1 && (
                <span className="text-amber-600 dark:text-amber-400">{inputCreditMultiplier}×</span>
              )}
            </button>
          )}
          {isSending ? (
            <button
              type="button"
              onClick={onCancel}
              className={`flex shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-500 ${isMobileShell ? "h-11 w-11" : "h-9 w-9"}`}
              title={t("chat.stopAllResponses")}
              aria-label={t("chat.stopAllResponses")}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              data-testid="chat-send-button"
              onClick={() => {
                dismissGuestQuickStart();
                onSubmit();
              }}
              disabled={
                isDisabled ||
                activeSelectedModels.length === 0 ||
                (!value.trim() && attachments.length === 0)
              }
              className={`flex shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400 ${isMobileShell ? "h-11 w-11" : "h-9 w-9"}`}
              title={`${t("chat.send")} · ${estimatedRequestCredits} credits`}
              aria-label={`${t("chat.send")} · ${estimatedRequestCredits} credits`}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>

          {isMenuOpen && (
            <MobileModelMenuPortal>
            <>
            <button
              type="button"
              className={`fixed inset-0 z-[90] bg-black/35 backdrop-blur-[1px] ${menuView === "models" ? "" : "md:hidden"}`}
              onClick={() => closeMenu(true)}
              aria-label={t("auth.cancel")}
            />
            <div
              ref={menuPopoverRef}
              id="chat-input-popover"
              role="dialog"
              aria-modal="false"
              aria-label={
                menuView === "models"
                  ? t("chat.modelSelect")
                  : menuView === "webSearch"
                    ? t("chat.toolsWebSearch")
                    : t("chat.moreActions")
              }
              tabIndex={-1}
              className={`fixed inset-x-2 z-[100] flex max-w-[calc(100%_-_1rem)] flex-col overflow-hidden rounded-3xl border border-zinc-200 bg-white p-2 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 md:rounded-2xl ${
                menuView === "models"
                  ? "bottom-[calc(0.5rem+env(safe-area-inset-bottom))] top-[calc(0.5rem+env(safe-area-inset-top))] max-h-none md:inset-x-auto md:left-1/2 md:right-auto md:-translate-x-1/2 md:top-[5vh] md:bottom-[5vh] md:h-[90vh] md:max-h-[900px] md:w-[min(94vw,1000px)] md:max-w-[min(94vw,1000px)]"
                  : "md:left-0 md:right-auto bottom-[calc(0.5rem+env(safe-area-inset-bottom))] max-h-[calc(100dvh-2rem)] md:absolute md:inset-x-auto md:bottom-12 md:top-auto md:max-h-[calc(100dvh-8rem)] md:w-80 md:max-w-[calc(100vw_-_2rem)]"
              }`}
            >
              <div className="mx-auto mb-2 mt-0.5 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
              <div className="mb-2 flex items-center justify-between border-b border-zinc-200 px-2 pb-2 pt-1 dark:border-zinc-800 md:hidden">
                <div>
                  <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    {menuView === "models"
                      ? t("chat.modelSelect")
                      : menuView === "webSearch"
                        ? t("chat.toolsWebSearch")
                        : t("chat.moreActions")}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {menuView === "models"
                      ? `${selectedModels.length}/${maxSelectableModels} ${selectedModels.length === 1 ? t("chat.modelsSelectedOne") : t("chat.modelsSelectedOther")}`
                      : menuView === "webSearch"
                        ? t("chat.toolsWebSearchDescription")
                        : t("chat.uploadFromComputer")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => closeMenu(true)}
                  className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  aria-label={t("auth.cancel")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {menuView === "actions" ? (
                <div className="space-y-1">
                  <button
                    type="button"
                    disabled={!canAttach || attachments.length >= MAX_ATTACHMENTS}
                    onClick={() => {
                      closeMenu(false);
                      fileInputRef.current?.click();
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      <Paperclip className="h-5 w-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.attachFile")}</span>
                      <span className="text-xs text-zinc-500">{t("chat.uploadFromComputer")}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={!canAttach || attachments.length >= MAX_ATTACHMENTS}
                    onClick={() => {
                      closeMenu(false);
                      void handleGoogleDriveSelect();
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                      <HardDrive className="h-5 w-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.attachGoogleDrive")}</span>
                      <span className="text-xs text-zinc-500">{t("chat.googleDriveDescription")}</span>
                    </span>
                  </button>
                  <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
                  <button
                    type="button"
                    data-testid="tools-web-search-row"
                    onClick={() => setMenuView("webSearch")}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500">
                      <Globe2 className="h-5 w-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.toolsWebSearch")}</span>
                      <span className="text-xs text-zinc-500">
                        {webSearchMode === "always"
                          ? t("chat.toolsWebSearchAlways")
                          : webSearchMode === "auto"
                            ? t("chat.toolsWebSearchAuto")
                            : t("chat.toolsWebSearchOff")}
                      </span>
                    </span>
                  </button>
                  {(() => {
                    const deepResearchModel = AVAILABLE_MODELS.find(
                      (model) => model.id === "perplexity/sonar-deep-research"
                    );
                    const deepResearchLocked =
                      !deepResearchModel || !canUseModelWithPlan(currentPlan, deepResearchModel);
                    const deepResearchReason = !deepResearchModel
                      ? null
                      : isGuestMode
                        ? t("modelStatusReasons.loginRequired")
                        : deepResearchLocked
                          ? t("modelStatusReasons.upgradeRequired")
                          : null;
                    return (
                      <button
                        type="button"
                        data-testid="tools-deep-research-row"
                        disabled={!deepResearchModel}
                        onClick={() => {
                          closeMenu(false);
                          if (deepResearchLocked) {
                            // Reuses the same guest-sign-in/upgrade-plan gating
                            // toggling a locked model in the picker already
                            // triggers, instead of inventing a second prompt.
                            onToggleModel("perplexity/sonar-deep-research");
                            return;
                          }
                          trackProductEvent(
                            "deep_research_setup_opened",
                            selectedModels.length,
                            {}
                          );
                          onOpenDeepResearchSetup?.();
                        }}
                        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
                          <Microscope className="h-5 w-5" />
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.toolsDeepResearch")}</span>
                          <span className={`text-xs ${deepResearchReason ? "text-amber-600 dark:text-amber-400" : "text-zinc-500"}`}>
                            {deepResearchReason || t("chat.toolsDeepResearchDescription")}
                          </span>
                        </span>
                      </button>
                    );
                  })()}
                  <button
                    type="button"
                    data-testid="tools-read-webpage-row"
                    disabled
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left opacity-40"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      <Link2 className="h-5 w-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.toolsReadWebpage")}</span>
                      <span className="text-xs text-zinc-500">{t("chat.toolsComingSoon")}</span>
                    </span>
                  </button>
                  <div className="mx-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:text-zinc-400">
                    <p className="font-semibold text-zinc-700 dark:text-zinc-200">
                      {canAttach ? t("chat.attachmentGuideTitle") : t("chat.loginToAttach")}
                    </p>
                    <p className="mt-0.5">
                      {t("chat.attachmentGuideBody")}
                    </p>
                  </div>
                  <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
                  <button
                    type="button"
                    onClick={() => {
                      setMenuView("models");
                      trackProductEvent("model_picker_opened", selectedModels.length, {});
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-500/10 text-purple-500">
                      <Boxes className="h-5 w-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.modelSelect")}</span>
                      <span className="text-xs text-zinc-500">
                        {isGuestMode ? t("chat.maxGuestModelsDescription") : t("chat.maxModelsDescription")}
                      </span>
                    </span>
                  </button>
                </div>
              ) : menuView === "webSearch" ? (
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setMenuView("actions")}
                    className={`mb-1 flex items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white ${isMobileShell ? "h-11 w-11" : "h-8 w-8"}`}
                    aria-label={t("auth.cancel")}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  {WEB_SEARCH_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      data-testid={`web-search-mode-option-${mode}`}
                      aria-pressed={webSearchMode === mode}
                      onClick={() => {
                        onWebSearchModeChange?.(mode);
                        trackProductEvent(
                          "web_search_mode_selected",
                          selectedModels.length,
                          { web_search_mode: mode }
                        );
                        closeMenu(false);
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                        webSearchMode === mode ? "bg-sky-500/10" : ""
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500">
                        <Globe2 className="h-5 w-5" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {mode === "always"
                            ? t("chat.toolsWebSearchAlways")
                            : mode === "auto"
                              ? t("chat.toolsWebSearchAuto")
                              : t("chat.toolsWebSearchOff")}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {mode === "always"
                            ? t("chat.toolsWebSearchAlwaysDescription")
                            : mode === "auto"
                              ? t("chat.toolsWebSearchAutoDescription")
                              : t("chat.toolsWebSearchOffDescription")}
                        </span>
                      </span>
                      {webSearchMode === mode && (
                        <Check className="h-4 w-4 shrink-0 text-sky-500" aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  {(() => {
                    // The AI-combination nudge stays owned by ChatInput because
                    // it depends on the draft text and the model-finder entry
                    // point; the picker just renders it under the
                    // recommendations.
                    const comboFinderSlot = !isGuestMode ? (
                      activeSelectedModels.length >= maxSelectableModels ? (
                        <button
                          type="button"
                          data-testid="model-combo-finder-cta-compact"
                          onClick={() => {
                            closeMenu(false);
                            openModelFinder();
                          }}
                          className={`inline-flex items-center self-start rounded-lg px-2 text-[11px] font-bold text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-500 dark:text-blue-300 ${isMobileShell ? "min-h-11" : "py-1"}`}
                        >
                          {t("modelFinder.pickerCtaCompact")}
                        </button>
                      ) : showComplementarySuggestion &&
                          complementarySuggestion &&
                          complementaryModel &&
                          complementaryProfile ? (
                        <div
                          data-testid="model-combo-complementary-suggestion"
                          className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900/60 dark:bg-amber-950/20"
                        >
                          <p className="text-[11px] font-black text-zinc-900 dark:text-white">
                            {t("modelFinder.complementaryTitle")}
                          </p>
                          <p className="mt-0.5 text-[10px] leading-4 text-zinc-600 dark:text-zinc-300">
                            {t(
                              complementarySuggestion.reason === "reasoning"
                                ? "modelFinder.complementaryReasoning"
                                : complementarySuggestion.reason === "research"
                                  ? "modelFinder.complementaryResearch"
                                  : "modelFinder.complementaryDifferentProvider"
                            )}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              data-testid="model-combo-complementary-add"
                              onClick={() => {
                                const added = onToggleModel(complementaryModel.id);
                                if (!added) return;
                                trackProductEvent(
                                  "advanced_model_selected",
                                  selectedModels.length + 1,
                                  { model_id: complementaryModel.id }
                                );
                              }}
                              className={`inline-flex items-center justify-center rounded-lg bg-amber-600 px-2.5 text-[10px] font-black text-white hover:bg-amber-500 ${isMobileShell ? "min-h-11" : "py-1.5"}`}
                            >
                              {t("modelFinder.complementaryAdd").replace(
                                "{model}",
                                complementaryModel.name
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setDismissedComplementaryModelId(
                                  complementarySuggestion.modelId
                                )
                              }
                              className={`inline-flex items-center justify-center rounded-lg border border-amber-300 bg-white px-2.5 text-[10px] font-bold text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-zinc-950 dark:text-amber-200 ${isMobileShell ? "min-h-11" : "py-1.5"}`}
                            >
                              {t("modelFinder.complementaryDismiss")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          data-testid="model-combo-finder-cta"
                          onClick={() => {
                            closeMenu(false);
                            openModelFinder();
                          }}
                          className={`inline-flex items-center justify-center gap-1.5 self-start rounded-full border border-blue-200 bg-blue-50 px-3 text-[11px] font-black text-blue-700 transition hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200 dark:hover:bg-blue-950 ${isMobileShell ? "min-h-11" : "py-1.5"}`}
                        >
                          <Sparkles className="h-3 w-3" aria-hidden="true" />
                          {t("modelFinder.pickerCta")}
                        </button>
                      )
                    ) : null;

                    return (
                      <ModelPickerPanel
                        models={PUBLIC_MODELS}
                        selectedModelIds={selectedModels}
                        activeSelectedCount={activeSelectedModels.length}
                        maxSelectableModels={maxSelectableModels}
                        currentPlan={currentPlan}
                        isGuestMode={isGuestMode}
                        isMobileShell={isMobileShell}
                        isCompactLayout={isMobileModelMenu}
                        modelStatuses={liveModelStatuses}
                        hasImageAttachments={hasImageAttachments}
                        favoriteModelIds={favoriteModelIds}
                        recentModelIds={recentModelIds}
                        personalizedModelIds={personalizedRecommendationIds}
                        selectedBaseCredits={selectedBaseCredits}
                        searchInputRef={modelSearchInputRef}
                        escapeHandlerRef={modelPickerEscapeRef}
                        onToggleModel={onToggleModel}
                        onRequestSwap={setReplaceModelCandidate}
                        onToggleFavorite={toggleFavoriteModel}
                        onRememberRecentModel={rememberRecentModel}
                        onBackToActions={() => setMenuView("actions")}
                        onDone={() => closeMenu(true, "done")}
                        onTrackEvent={trackModelPickerEvent}
                        comboFinderSlot={comboFinderSlot}
                      />
                    );
                  })()}
                </>
              )}
            </div>
            {replaceModelCandidate && (() => {
              const candidate = replaceModelCandidate;
              return (
                <div
                  className="fixed inset-0 z-[110] flex items-end justify-center bg-black/50 md:items-center"
                  onClick={() => setReplaceModelCandidate(null)}
                >
                  <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={t("chat.swapModelTitle").replace("{model}", candidate.name)}
                    className="w-full max-w-sm rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] dark:bg-zinc-900 md:rounded-3xl"
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-200 dark:bg-zinc-700 md:hidden" />
                    <p className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                      {t("chat.swapModelTitle").replace("{model}", candidate.name)}
                    </p>
                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                      {t("chat.swapModelBody")}
                    </p>
                    <div className="mt-3 space-y-1.5">
                      {selectedModels.map((modelId) => {
                        const currentModel = PUBLIC_MODELS.find((item) => item.id === modelId);
                        return (
                          <button
                            key={modelId}
                            type="button"
                            onClick={() => {
                              const swapped = onSwapModel(modelId, candidate.id);
                              if (swapped) {
                                rememberRecentModel(candidate.id);
                              } else {
                                dispatchAppToast(t("chat.swapModelFailed"), "error");
                              }
                              setReplaceModelCandidate(null);
                            }}
                            className="flex w-full items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2.5 text-left text-sm font-semibold text-zinc-800 transition hover:border-blue-400 hover:bg-blue-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-blue-950/30"
                          >
                            <ModelLogo model={currentModel} size="sm" />
                            <span className="min-w-0 flex-1 truncate">{currentModel?.name || modelId}</span>
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplaceModelCandidate(null)}
                      className="mt-3 w-full rounded-xl border border-zinc-200 py-2.5 text-sm font-bold text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
                    >
                      {t("auth.cancel")}
                    </button>
                  </div>
                </div>
              );
            })()}
            </>
            </MobileModelMenuPortal>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_FILE_TYPES}
          onChange={(event) => handleFilesSelected(event.target.files)}
          className="hidden"
        />

      </div>
      {!hideDisclaimer && (
        <p
          data-testid="chat-ai-disclaimer"
          className="mt-1.5 px-2 text-center text-[10px] leading-4 text-zinc-400 dark:text-zinc-500 md:text-[11px]"
        >
          {t("chat.aiDisclaimer")}
        </p>
      )}
      </div>
      <CreditBreakdownSheet
        open={isCreditBreakdownOpen}
        onClose={() => setIsCreditBreakdownOpen(false)}
        items={creditBreakdown}
        total={estimatedRequestCredits}
        multiplier={inputCreditMultiplier}
        webSearchReservationCredits={webSearchReservationCredits}
      />
      <UsageLimitModal
        open={isUsageLimitModalOpen && isUsageLimitReached}
        onClose={() => setIsUsageLimitModalOpen(false)}
        isGuestMode={isGuestMode}
        isAccountMonthlyLimitReached={isAccountMonthlyLimitReached}
        accountPlan={accountUsage?.plan}
        dailyCreditLimit={dailyCreditLimit}
        planCreditsRemaining={planCreditsRemaining}
        purchasedCreditsRemaining={purchasedCreditsRemaining}
        dailyResetLabel={dailyResetLabel}
        estimatedRequestCredits={estimatedRequestCredits}
        totalAvailableCredits={totalAvailableCredits}
        creditShortfall={creditShortfall}
        signInCallbackUrl={signInCallbackUrl}
        currentChatId={currentChatId}
      />
    </div>
  );
}
