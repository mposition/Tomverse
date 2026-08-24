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
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Bot,
  Braces,
  Check,
  ChevronDown,
  File as FileIcon,
  FileText,
  HardDrive,
  BookMarked,
  Globe2,
  Loader2,
  Lock,
  ImagePlus,
  MessageSquare,
  Microscope,
  Paperclip,
  Plus,
  Presentation,
  RefreshCw,
  Settings2,
  Sheet,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { assistantProfileCreateHref } from "@/lib/assistantProfileReturn";
import { settingsSectionHref } from "@/lib/settingsNavigation";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import {
  MAX_SELECTED_MODELS,
  getModelUsageProfile,
  type ChatAttachment,
} from "@/components/chat/types";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { useLanguage } from "@/components/LanguageProvider";
import type {
  ChatAssistantProfile,
  ChatAssistantProfileOption,
} from "@/lib/conversationProfileBinding";
import { FeatureHelpPopover } from "@/components/chat/FeatureHelpPopover";
import { chatHelpCopy } from "@/components/chat/chatHelpCopy";
import { dispatchAppToast } from "@/lib/appToast";
import {
  attachmentKindForFormat,
  chatAttachmentAcceptAttribute,
  chatAttachmentExtensionsByGroup,
  resolveChatAttachmentFormat,
} from "@/lib/chatAttachmentFormats";
import { chatAttachmentErrorCopyKey } from "@/lib/chatAttachmentErrorCopy";
import { APP_DEFAULTS, WEB_SEARCH_MODES, type WebSearchMode } from "@/lib/appDefaults";
import {
  CONVERSATION_MEMORY_MODES,
  type ConversationMemoryMode,
} from "@/lib/conversationMemoryMode";
import {
  canUseModelWithPlan,
  getModel as getStaticModel,
  getInputCreditMultiplier,
  modelSupportsImageInput,
  resolveSelectableModelId,
  type AiModel,
} from "@/lib/models";
import { estimateRequestCredits } from "@/lib/webSearchCredits";
import { useChatAvailability } from "@/components/chat/useChatAvailability";
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
import { draftSuggestionKey, suggestsWebSearchInComposer } from "@/lib/webSearchSuggestion";
import { deriveWebSearchComposerState } from "@/lib/webSearchComposerState";
import { openModelFinder } from "@/lib/modelFinderEvents";
import { CreditBreakdownSheet } from "@/components/chat/CreditBreakdownSheet";
import { UsageLimitModal } from "@/components/chat/UsageLimitModal";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";
import { looksLikeStructuredText } from "@/lib/structuredPasteDetection";
import { useIsMobileShell } from "@/components/chat/useIsMobileShell";
import { useKeyboardInset } from "@/components/chat/useVisualViewport";
import {
  getChatEnterKeyAction,
  isComposingKeydown,
} from "@/lib/chatKeyboardPolicy";
import {
  draftKeyFor,
  type AttachmentsChangeHandler,
} from "@/components/chat/useConversationDrafts";
import { type ChatAttachmentCapabilities } from "@/lib/guestAttachmentPolicy";
import { useGuestVerification } from "@/components/chat/GuestVerificationProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { discardResponseBody } from "@/lib/discardResponseBody";

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
/**
 * Everything about which files may be picked now comes from the shared
 * registry (`lib/chatAttachmentFormats.ts`). What used to live here was four
 * literals -- a text set, an Office set, an Office extension repair map and a
 * joined `accept` string -- and the repair map covered only the six Office
 * extensions. A `.txt`, `.md`, `.csv` or `.json` whose browser-reported type
 * came back empty therefore failed this component's own guard before the
 * server was ever asked, which is a rejection the server would not have made.
 */
const ACCEPTED_FILE_TYPES = chatAttachmentAcceptAttribute();

const GUEST_ACCEPT_ATTRIBUTE = chatAttachmentAcceptAttribute({ guest: true });

/**
 * A signed-in account with an attachment-capable plan. The composer is used in
 * places that never pass capabilities explicitly, so the permissive
 * signed-in shape stays the default and guests are the narrowing.
 */
const DEFAULT_ATTACHMENT_CAPABILITIES: ChatAttachmentCapabilities = {
  canAttachLocalFiles: true,
  canConnectGoogleDrive: true,
  maxAttachmentsPerMessage: MAX_ATTACHMENTS,
  maxAttachmentBytes: MAX_ATTACHMENT_SIZE,
  attachmentPersistence: "account",
};

/**
 * What this file actually is, from its name and whatever the browser managed
 * to say about it. `File.type` is a hint here exactly as it is on the server:
 * the same function decides in both places, so the client can pre-empt a
 * rejection without being able to invent one.
 */
const getFileFormat = (file: File) =>
  resolveChatAttachmentFormat({
    filename: file.name,
    declaredMediaType: file.type,
  });

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

/**
 * A drag one drop surface has already taken responsibility for.
 *
 * While a chat is empty the composer portals *into* the conversation canvas
 * (ChatWelcomeScreen's input slot), so one drop travels through both drop
 * surfaces. Marking the DOM event is what makes "handled once" a property of
 * the event rather than of a containment test -- and containment is exactly
 * what is stale for the render in which the composer moves between its two
 * slots, because the portal host is moved in an effect. The canvas listens in
 * the capture phase, so on a nested drop the canvas claims the event and the
 * composer stands down: one overlay, one upload, wherever the pointer is.
 */
const claimedDragEvents = new WeakSet<Event>();
const claimDragEvent = (event: Event) => {
  if (claimedDragEvents.has(event)) return false;
  claimedDragEvents.add(event);
  return true;
};
const isDragEventClaimed = (event: Event) => claimedDragEvents.has(event);

/**
 * Regions inside the conversation canvas that own what a dropped file means.
 * A dialog opened over the canvas is not part of the question being composed,
 * and a surface that declares itself a dropzone has already answered.
 */
const DROP_EXCLUDED_SELECTOR =
  '[data-chat-drop-exclude="true"],[role="dialog"],[role="alertdialog"]';

const isExcludedDropTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(DROP_EXCLUDED_SELECTOR));

/**
 * What a drop surface says while a file is over it. Shared by the composer's
 * own zone and by the conversation canvas so the two cannot drift into saying
 * different things about the same gesture.
 */
function DropGuidance({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm shadow-blue-950/20">
        <Paperclip className="h-5 w-5" />
      </span>
      <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
        {title}
      </span>
      {description ? (
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {description}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The conversation canvas as a drop target for the composer's own upload
 * path.
 *
 * The listeners are native and are registered on an element this component
 * does not render, which is the point: a shell hands over its answer canvas
 * and gets the composer's format checks, size limits, attachment count, guest
 * Turnstile step and error copy with it, instead of growing a second copy of
 * all of them. Nothing about `window` changes -- the window-level handlers
 * stay the safety net that stops the browser navigating to a dropped file,
 * and uploading stays scoped to this element.
 */
function useConversationDropSurface({
  surface,
  canAttach,
  onFiles,
  onRefused,
}: {
  surface: HTMLElement | null;
  canAttach: boolean;
  onFiles: (files: FileList) => void;
  onRefused: () => void;
}) {
  const [isDragActive, setIsDragActive] = useState(false);
  // `dragenter`/`dragleave` fire for every element the pointer crosses, so a
  // drag moving between children reports leaving one before entering the
  // next. Counting depth rather than holding a boolean is what stops the
  // overlay flickering on the way across the canvas.
  const depthRef = useRef(0);
  const latestRef = useRef({ canAttach, onFiles, onRefused });
  useEffect(() => {
    latestRef.current = { canAttach, onFiles, onRefused };
  });

  useEffect(() => {
    if (!surface) return;

    const reset = () => {
      depthRef.current = 0;
      setIsDragActive(false);
    };

    // Text, links and everything else that is not a file are somebody else's
    // gesture, and so is anything over a region that owns its own drop.
    const claim = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return false;
      if (isExcludedDropTarget(event.target)) return false;
      return claimDragEvent(event);
    };

    const handleDragEnter = (event: DragEvent) => {
      if (!claim(event)) return;
      event.preventDefault();
      depthRef.current += 1;
      setIsDragActive(true);
    };

    const handleDragOver = (event: DragEvent) => {
      if (!claim(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = latestRef.current.canAttach
          ? "copy"
          : "none";
      }
      // A drag already in progress when this surface mounted never reported
      // an enter of its own, so the first `dragover` is the only evidence
      // that the pointer is here.
      if (depthRef.current === 0) depthRef.current = 1;
      setIsDragActive(true);
    };

    const handleDragLeave = (event: DragEvent) => {
      if (!claim(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setIsDragActive(false);
    };

    const handleDrop = (event: DragEvent) => {
      if (!claim(event)) return;
      event.preventDefault();
      reset();
      if (!latestRef.current.canAttach) {
        latestRef.current.onRefused();
        return;
      }
      const files = event.dataTransfer?.files;
      if (files?.length) latestRef.current.onFiles(files);
    };

    surface.addEventListener("dragenter", handleDragEnter, true);
    surface.addEventListener("dragover", handleDragOver, true);
    surface.addEventListener("dragleave", handleDragLeave, true);
    surface.addEventListener("drop", handleDrop, true);
    // A drag can end without this element hearing about it: cancelled with
    // Escape, dropped on another window, or the tab losing focus entirely.
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);

    return () => {
      surface.removeEventListener("dragenter", handleDragEnter, true);
      surface.removeEventListener("dragover", handleDragOver, true);
      surface.removeEventListener("dragleave", handleDragLeave, true);
      surface.removeEventListener("drop", handleDrop, true);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
      // A canvas that goes away mid-drag -- an image conversation replacing
      // the chat surface, a shell swap -- must not leave its overlay behind.
      reset();
    };
  }, [surface]);

  return isDragActive;
}

// UI-STATE-002. An attachment that is still on its way in. `stage` is the
// step actually running, so "uploading" (bytes leaving the browser) and
// "processing" (server validating/extracting them) are two different states
// on screen and in the accessibility tree, not one shared spinner.
// `scopeId` is the draft key of the conversation the file was picked in. An
// upload belongs to that conversation's question, so its in-flight and failed
// cards are only ever shown there -- switching conversations must not surface
// another conversation's uploads, and coming back must still show them.
type PendingAttachment = {
  id: string;
  name: string;
  stage: "uploading" | "processing";
  scopeId: string;
};

// A file that did not make it. `file` is retained so retry can re-run this
// one file's pipeline; without it "retry" could only reopen the picker.
type FailedAttachment = {
  id: string;
  name: string;
  reason: string;
  file: File;
  scopeId: string;
};

/**
 * The archive summary a chip carries, from whichever upload path answered.
 *
 * Both endpoints report the same three counts, and both may omit the block
 * entirely -- a `.txt` has no plan. Read through one function so the chip and
 * the toast cannot disagree about what the server said.
 */
const archiveSummaryOf = (archive?: {
  includedFiles?: number;
  excludedFiles?: number;
} | null) => {
  const included = Number(archive?.includedFiles);
  const excluded = Number(archive?.excludedFiles);
  if (!Number.isFinite(included) && !Number.isFinite(excluded)) return undefined;
  return {
    includedFiles: Number.isFinite(included) ? included : 0,
    excludedFiles: Number.isFinite(excluded) ? excluded : 0,
  };
};

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
  onAttachmentsChange: AttachmentsChangeHandler;
  /**
   * What this caller may actually do with files, as four independent facts
   * rather than one boolean. `canAttach={!isGuestMode}` used to answer "may I
   * attach at all", "how many", "from where" and "what happens afterwards"
   * with a single "no" for guests, which is why the product promised a file
   * upload the composer refused to offer.
   */
  attachmentCapabilities?: ChatAttachmentCapabilities;
  /** Opens the shell's sign-in prompt from a capability the guest lacks. */
  onGuestSignInPrompt?: () => void;
  isGuestMode?: boolean;
  guestPreviewMode?: boolean;
  variant?: "bar" | "floating";
  /**
   * The bar variant normally draws the single boundary between the answer
   * canvas and the bottom dock. When a comparison rail sits directly above it
   * that rail owns the boundary instead, so the composer must not add a
   * second full-width border to the same seam.
   */
  hideTopBorder?: boolean;
  // MobileChatShell renders its own copy pinned to the true screen bottom
  // (independent of the composer's floating/docked position) instead of
  // this one, which always sits directly under the input box.
  hideDisclaimer?: boolean;
  webSearchMode?: WebSearchMode;
  /**
   * This conversation's stored memory mode (§8.1 invariant 1), or undefined
   * when the control does not apply — a guest, who has no account memory at
   * all, or a draft with no conversation to store a mode on.
   */
  memoryMode?: ConversationMemoryMode;
  onMemoryModeChange?: (mode: ConversationMemoryMode) => void;
  /**
   * Auto model selection (UI contract auto-model-selection.md §1).
   *
   * `autoSelectionOffered` is the server's single boolean: it already folds
   * the feature flag, the conversation's product and cohort eligibility
   * together, so nothing here may derive availability from any of them
   * separately. False renders no control at all -- not a disabled one.
   */
  autoSelectionOffered?: boolean;
  selectionMode?: "manual" | "auto";
  selectionModePending?: boolean;
  onSelectionModeChange?: (next: boolean) => void;
  /**
   * The assistant this conversation runs under (§14), or null when it runs
   * under none. Undefined when the control does not apply at all — a guest,
   * or an account with the feature switched off.
   *
   * The revision is part of it because pinning is the contract: a
   * conversation keeps answering under the version it started with, and a
   * screen that only knew the profile's name could not say so.
   */
  assistantProfile?: ChatAssistantProfile | null;
  /** The account's published profiles, for the picker. Empty is a valid list. */
  assistantProfileOptions?: ChatAssistantProfileOption[];
  /** `null` detaches. Re-sending the bound id moves it to the newest revision. */
  onAssistantProfileChange?: (profileId: string | null) => void;
  /** The account default `inherit` resolves to, for describing that choice. */
  accountMemoryDefault?: "on" | "off";
  onWebSearchModeChange?: (mode: WebSearchMode) => void;
  onOpenDeepResearchSetup?: () => void;
  /**
   * Switches to the image draft, carrying the composer's current text as the
   * starting prompt. Absent when the image feature flag is off. `modelId` is
   * set when the user arrived from the catalogue's image tab and therefore
   * already chose which model to start from.
   */
  onStartImageDraft?: (draftText: string, modelId?: string) => void;
  /** Set when image generation is visible to this viewer but not usable. */
  imageGenerationLock?: "sign_in" | "upgrade" | null;
  onLockedImageGenerationClick?: (lock: "sign_in" | "upgrade") => void;
  isDeepResearchPending?: boolean;
  onDismissDeepResearchChip?: () => void;
  /**
   * The answer canvas of the conversation this composer is composing for.
   * Files dropped anywhere on it run this composer's upload path and land in
   * this composer's draft, so dropping on a message list, on the welcome
   * surface or on one of several model panels all mean the same thing --
   * attach to the next question -- rather than nothing at all.
   *
   * The shells pass the element itself rather than rendering their own
   * handlers: the format table, size and count limits, guest verification
   * step and error copy live here and stay in one place.
   */
  conversationDropSurface?: HTMLElement | null;
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
  attachmentCapabilities = DEFAULT_ATTACHMENT_CAPABILITIES,
  onGuestSignInPrompt,
  isGuestMode = false,
  guestPreviewMode = false,
  variant = "bar",
  hideTopBorder = false,
  hideDisclaimer = false,
  webSearchMode = "off",
  memoryMode,
  onMemoryModeChange,
  autoSelectionOffered = false,
  selectionMode = "manual",
  selectionModePending = false,
  onSelectionModeChange,
  assistantProfile,
  assistantProfileOptions = [],
  onAssistantProfileChange,
  accountMemoryDefault = "on",
  onWebSearchModeChange,
  onOpenDeepResearchSetup,
  onStartImageDraft,
  imageGenerationLock = null,
  onLockedImageGenerationClick,
  isDeepResearchPending = false,
  onDismissDeepResearchChip,
  conversationDropSurface = null,
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
  /** True while an IME composition is in progress, so Enter must not submit. */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The draft this composer is currently editing. Everything scoped below is
  // scoped to this, not to the component instance: the composer is shared by
  // every conversation and is deliberately never remounted between them (that
  // would take the portal host, focus and in-flight uploads with it).
  const draftScopeId = draftKeyFor(currentChatId);
  const draftScopeIdRef = useRef(draftScopeId);
  useEffect(() => {
    draftScopeIdRef.current = draftScopeId;
  }, [draftScopeId]);
  const previousAttachmentsRef = useRef<{
    scopeId: string;
    items: ChatAttachment[];
  }>({ scopeId: draftScopeId, items: attachments });
  const hasHandledFocusTokenRef = useRef(false);
  const guestQuickStartActiveRef = useRef(false);
  const trackedLimitScopeRef = useRef<"guest" | "daily" | "monthly" | null>(
    null
  );
  const [isUploading, setIsUploading] = useState(false);
  // UI-STATE-002. See uploadOneFile: the composer distinguishes the transfer
  // step from the server-side finalize step, and keeps a failed file around
  // so retry is a real action rather than a dead button.
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [failedAttachments, setFailedAttachments] = useState<
    FailedAttachment[]
  >([]);
  // Only this conversation's uploads are on screen. The entries for other
  // conversations stay in state so returning to one still shows its own
  // in-flight and failed files.
  const scopedPendingAttachments = useMemo(
    () => pendingAttachments.filter((item) => item.scopeId === draftScopeId),
    [draftScopeId, pendingAttachments]
  );
  const scopedFailedAttachments = useMemo(
    () => failedAttachments.filter((item) => item.scopeId === draftScopeId),
    [draftScopeId, failedAttachments]
  );
  const [isDragActive, setIsDragActive] = useState(false);
  const [preserveFormatting, setPreserveFormatting] = useState(false);
  useEffect(() => {
    if (value.trim()) return;
    queueMicrotask(() => setPreserveFormatting(false));
  }, [value]);
  const [showGuestQuickStart, setShowGuestQuickStart] = useState(false);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);
  // Collapsed by default: the exception detail (which models cannot search and
  // what they do instead) is a user-initiated disclosure, never a permanent row.
  const [isWebSearchExceptionOpen, setIsWebSearchExceptionOpen] = useState(false);
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
    // Local files and Google Drive are two separate permissions: a guest gets
    // the first (one ephemeral file, validated and parsed server-side) and not
    // the second, because Drive needs an OAuth grant an anonymous session
    // cannot hold. The plan check only ever *removes* a capability.
    const canAttach =
      attachmentCapabilities.canAttachLocalFiles &&
      accountUsage?.limits.allowAttachments !== false;
    const canConnectGoogleDrive =
      attachmentCapabilities.canConnectGoogleDrive &&
      accountUsage?.limits.allowAttachments !== false;
    const maxAttachments = Math.max(
      1,
      attachmentCapabilities.maxAttachmentsPerMessage
    );
    const maxAttachmentBytes = attachmentCapabilities.maxAttachmentBytes;
    const isEphemeralAttachment =
      attachmentCapabilities.attachmentPersistence === "ephemeral";
    const acceptedFileTypes = isEphemeralAttachment
      ? GUEST_ACCEPT_ATTRIBUTE
      : ACCEPTED_FILE_TYPES;
    const { requestToken: requestGuestVerificationToken } = useGuestVerification();
    /**
     * Every upload rejection the server can produce, mapped to the one
     * sentence that tells the user what to do about it.
     *
     * Shared by both upload paths now. The guest path always had a switch
     * like this; the signed-in path threw the server's answer away and showed
     * "Couldn't upload the file. Please try again." for a corrupt PDF, an
     * animated GIF, an encrypted archive and a rate limit alike -- and "try
     * again" was wrong advice for all four. The code-to-key map lives in
     * `lib/chatAttachmentErrorCopy.ts` so a new refusal code cannot ship
     * without a sentence.
     */
    const attachmentErrorMessage = useCallback(
      (code?: string | null, fallbackKey = "chat.attachmentUploadError") => {
        const key = chatAttachmentErrorCopyKey(code);
        if (!key) return t(fallbackKey);
        if (
          key === "chat.guestAttachmentSizeError" ||
          key === "chat.attachmentSizeError"
        ) {
          return isEphemeralAttachment
            ? interpolateCopy(t("chat.guestAttachmentSizeError"), {
                megabytes: Math.floor(maxAttachmentBytes / (1024 * 1024)),
              })
            : t("chat.attachmentSizeError");
        }
        return t(key);
      },
      [isEphemeralAttachment, maxAttachmentBytes, t]
    );
    const guestAttachmentErrorMessage = useCallback(
      (code?: string) => {
        if (code === "GUEST_ATTACHMENT_TOO_LARGE") {
          return interpolateCopy(t("chat.guestAttachmentSizeError"), {
            megabytes: Math.floor(maxAttachmentBytes / (1024 * 1024)),
          });
        }
        return attachmentErrorMessage(code, "chat.guestAttachmentFailed");
      },
      [attachmentErrorMessage, maxAttachmentBytes, t]
    );
    /**
     * An archive that arrived with entries this product cannot read is not a
     * failure -- the readable ones are attached and usable -- but it is also
     * not nothing. Said once, at upload, while the person is still looking at
     * the file they picked, rather than left for them to notice missing from
     * an answer.
     */
    const noticeArchiveExclusions = useCallback(
      (archive?: { includedFiles?: number; excludedFiles?: number } | null) => {
        const excluded = Number(archive?.excludedFiles) || 0;
        if (excluded <= 0) return;
        dispatchAppToast(
          interpolateCopy(t("chat.archiveExcludedNotice"), { count: excluded }),
          "info"
        );
      },
      [t]
    );
    /**
     * What may be attached, grouped, derived from the shared registry rather
     * than typed next to it -- so a format cannot be added to the picker and
     * left out of the sentence that tells people it exists.
     *
     * The long groups are capped on screen and given in full in the tooltip:
     * forty source-code extensions is a list nobody reads, and "+28 more"
     * says the same thing in a line.
     */
    const supportedFormatGroups = useMemo(() => {
      const groups = chatAttachmentExtensionsByGroup({
        guest: isEphemeralAttachment,
      });
      const labels: Record<string, string> = {
        image: t("chat.attachFormatGroupImage"),
        document: t("chat.attachFormatGroupDocument"),
        data: t("chat.attachFormatGroupData"),
        markup: t("chat.attachFormatGroupMarkup"),
        code: t("chat.attachFormatGroupCode"),
        archive: t("chat.attachFormatGroupArchive"),
      };
      const VISIBLE = 10;
      return Object.entries(groups)
        .filter(([, extensions]) => extensions.length > 0)
        .map(([group, extensions]) => ({
          group,
          label: labels[group] || group,
          shown: extensions.slice(0, VISIBLE).join(", "),
          overflow: Math.max(0, extensions.length - VISIBLE),
          all: extensions.join(", "),
        }));
    }, [isEphemeralAttachment, t]);
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
  // Derived from the same active-model list the credit estimate uses, so the
  // chip, its support counts and the reservation can never describe different
  // selections -- changing or pausing a model updates all three together.
  const webSearchState = deriveWebSearchComposerState({
    webSearchMode,
    selectedModelIds: activeSelectedModels,
  });
  const webSearchChipLabel = webSearchState.allUnsupported
    ? t("chat.webSearchChipUnavailable")
    : webSearchState.hasException
      ? interpolateCopy(t("chat.webSearchChipPartial"), {
          supported: webSearchState.supportedCount,
          total: webSearchState.selectedCount,
        })
      : webSearchMode === "auto"
        ? t("chat.webSearchChipAuto")
        : t("chat.webSearchChipOn");
  // The mobile chip no longer owns a row of its own -- it shares the
  // composer's first input line -- so it drops the separator and the word
  // "supported" while keeping every state distinguishable: "Web search",
  // "Web search auto", "Web search 2/3", "No web search". The full sentence is
  // still what assistive tech gets (web-search-state-description below), and a
  // blocking state additionally keeps its own full-width notice, so no state is
  // ever reduced to a bare icon.
  const webSearchChipCompactLabel = webSearchState.allUnsupported
    ? t("chat.webSearchChipUnavailableCompact")
    : webSearchState.hasException
      ? interpolateCopy(t("chat.webSearchChipPartialCompact"), {
          supported: webSearchState.supportedCount,
          total: webSearchState.selectedCount,
        })
      : webSearchMode === "auto"
        ? t("chat.webSearchChipAutoCompact")
        : t("chat.webSearchChipOnCompact");
  const webSearchStateDescription =
    webSearchMode === "always"
      ? interpolateCopy(t("chat.webSearchChipDescriptionAlways"), {
          supported: webSearchState.supportedCount,
          total: webSearchState.selectedCount,
          unsupported: webSearchState.unsupportedCount,
          credits: webSearchState.estimatedSurchargeCredits,
        })
      : interpolateCopy(t("chat.webSearchChipDescriptionAuto"), {
          supported: webSearchState.supportedCount,
          total: webSearchState.selectedCount,
          unsupported: webSearchState.unsupportedCount,
        });
  const webSearchUnsupportedModelNames = webSearchState.unsupportedModelIds
    .map(
      (modelId) =>
        AVAILABLE_MODELS.find((model) => model.id === modelId)?.name || modelId
    )
    .join(", ");
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
  // Guardrail and provider-budget state lives in server-side buckets the
  // composer cannot see, so it is probed whenever the selection or the
  // web-search mode changes rather than only discovered after sending.
  const serverAvailability = useChatAvailability({
    enabled: !isGuestMode && activeSelectedModels.length > 0,
    modelIds: activeSelectedModels,
    webSearchMode,
  });
  const operationalHoldActive =
    serverAvailability?.runnable === false &&
    serverAvailability.blockLayer === "operational_guardrail";
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

  // Why Send is unavailable, for the cases a user cannot work out from the
  // button itself. `title` alone does not reach a screen reader or a keyboard
  // user, so this is rendered as text the button points at with
  // aria-describedby (docs/ui-contracts/mobile-chat-composer.md).
  const sendDisabledReason = isUsageLimitReached
    ? t("chat.exceedDailyLimit")
    : activeSelectedModels.length === 0
      ? t("chat.chooseModel")
      : null;
  
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<
    "actions" | "models" | "webSearch" | "memory" | "assistant" | "attachSource"
  >("actions");
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
        ? parsed
            .filter((item): item is string => typeof item === "string")
            .map((modelId) => resolveSelectableModelId(modelId, getStaticModel))
            .filter((modelId): modelId is string => Boolean(modelId))
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
        ? parsed
            .filter((item): item is string => typeof item === "string")
            .map((modelId) => resolveSelectableModelId(modelId, getStaticModel))
            .filter((modelId): modelId is string => Boolean(modelId))
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
    webSearchMode === "auto" && suggestsWebSearchInComposer(value)
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
  const replaceModelDialogRef = useRef<HTMLDivElement | null>(null);
  const replaceModelCancelRef = useRef<HTMLButtonElement | null>(null);
  const replaceModelReturnFocusRef = useRef<HTMLButtonElement | null>(null);
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
  const closeReplaceModelDialog = useCallback(
    () => setReplaceModelCandidate(null),
    []
  );
  const requestModelSwap = useCallback(
    (model: AiModel, trigger: HTMLButtonElement) => {
      replaceModelReturnFocusRef.current = trigger;
      setReplaceModelCandidate(model);
    },
    []
  );

  useModalDialog({
    open: Boolean(replaceModelCandidate),
    onClose: closeReplaceModelDialog,
    dialogRef: replaceModelDialogRef,
    panelRef: replaceModelDialogRef,
    initialFocusRef: replaceModelCancelRef,
    returnFocusRef: replaceModelReturnFocusRef,
  });

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
      .then((response) =>
        response.ok ? response.json() : discardResponseBody(response).then(() => null)
      )
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
      .then((response) =>
        response.ok ? response.json() : discardResponseBody(response).then(() => null)
      )
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
      const nestedDialog =
        event.target instanceof Element
          ? event.target.closest('[role="dialog"][aria-modal="true"]')
          : null;
      if (nestedDialog && !menuPopoverRef.current?.contains(nestedDialog)) return;

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

      // UX-027. Home and End belong to the caret whenever one exists. This
      // listener is on `document` in the capture phase, so while the user was
      // typing in the model search box it took both keys before the input saw
      // them: pressing Home to get back to the start of a query jumped focus to
      // the first model in the list instead, and the query was left as typed.
      // Arrow keys stay intercepted -- moving through options while focus stays
      // in the text field is the combobox behaviour this menu wants.
      const isTextEntry =
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLInputElement &&
          !["checkbox", "radio", "button", "submit", "range", "color"].includes(
            activeElement.type
          )) ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable);
      if (isTextEntry && (event.key === "Home" || event.key === "End")) return;

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

    // 10rem rather than a fixed 160px: at 200% text scaling the auto-grow cap
    // has to grow with the text, or the box stops one line short of what the
    // reader can actually see.
    const rootFontSize =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, rootFontSize * 10)}px`;
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
    // Only a removal *within one conversation* frees a preview. When the list
    // changes because another conversation was opened, the previous entries
    // are still that conversation's draft: revoking them here is what used to
    // make an attachment unrecoverable the moment the user looked away.
    // Drafts that are genuinely spent (sent, or their conversation deleted)
    // are released by the draft store that owns them.
    const previous = previousAttachmentsRef.current;
    previousAttachmentsRef.current = { scopeId: draftScopeId, items: attachments };
    if (previous.scopeId !== draftScopeId) return;

    const currentIds = new Set(attachments.map((attachment) => attachment.id));
    previous.items.forEach((attachment) => {
      if (
        !currentIds.has(attachment.id) &&
        attachment.data?.startsWith("blob:")
      ) {
        URL.revokeObjectURL(attachment.data);
      }
    });
  }, [attachments, draftScopeId]);

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

  /**
   * UI-STATE-002. Uploading one file is three sequential network steps --
   * prepare (PUT), transfer to object storage (PUT), then server-side
   * finalize/extract (PATCH) -- but the composer used to represent all of it
   * with one boolean and a spinner on the attach button. Nothing named the
   * file, nothing said which step was running, and a failure only ever
   * surfaced as a toast that took the file down with it. That is why the
   * "uploading" and "processing" goldens were byte-identical: they really
   * were the same picture.
   *
   * Each file now carries its own stage while it is in flight, and a failure
   * keeps the File itself so "retry" can re-run that one file's pipeline
   * rather than asking the user to find it in the picker again.
   */
  const uploadOneFile = useCallback(
    async (file: File, trackingId: string, scopeId: string) => {
      const format = getFileFormat(file);
      const mediaType = format?.mediaType || file.type || "application/octet-stream";
      const fail = (reason: string) => {
        setPendingAttachments((current) =>
          current.filter((item) => item.id !== trackingId)
        );
        setFailedAttachments((current) => [
          ...current.filter((item) => item.id !== trackingId),
          { id: trackingId, name: file.name, reason, file, scopeId },
        ]);
      };

      const isTypeAccepted = Boolean(
        format && (!isEphemeralAttachment || format.guestAllowed)
      );
      if (!format || !isTypeAccepted) {
        fail(t("chat.attachmentTypeError"));
        return;
      }
      if (file.size > maxAttachmentBytes) {
        fail(
          isEphemeralAttachment
            ? interpolateCopy(t("chat.guestAttachmentSizeError"), {
                megabytes: Math.floor(maxAttachmentBytes / (1024 * 1024)),
              })
            : t("chat.attachmentSizeError")
        );
        return;
      }

      setFailedAttachments((current) =>
        current.filter((item) => item.id !== trackingId)
      );
      setPendingAttachments((current) => [
        ...current.filter((item) => item.id !== trackingId),
        { id: trackingId, name: file.name, stage: "uploading", scopeId },
      ]);

      try {
        if (isEphemeralAttachment) {
          // Guests take a different route on purpose, not a relaxed version of
          // the same one: a single request that carries the bytes, validated
          // and parsed server-side before anything is stored, writing to a key
          // scoped to their own signed guest session. There is no presigned
          // direct-to-storage step, because there is no account to scope one
          // to -- see app/api/chat/guest-attachment/route.ts.
          const uploadGuestFile = (turnstileToken?: string) => {
            const query = new URLSearchParams({
              name: file.name,
              mediaType,
            });
            if (turnstileToken) query.set("turnstileToken", turnstileToken);
            return fetch(`/api/chat/guest-attachment?${query.toString()}`, {
              method: "POST",
              headers: { "Content-Type": mediaType },
              body: file,
            });
          };

          let response = await uploadGuestFile();
          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as
              | { code?: string }
              | null;
            if (payload?.code === "TURNSTILE_REQUIRED") {
              // User-initiated, so the shared verification sheet may be shown.
              const token = await requestGuestVerificationToken(
                "guest_attachment"
              );
              response = await uploadGuestFile(token);
            }
            if (!response.ok) {
              const finalPayload =
                payload?.code === "TURNSTILE_REQUIRED"
                  ? ((await response.json().catch(() => null)) as
                      | { code?: string }
                      | null)
                  : payload;
              fail(guestAttachmentErrorMessage(finalPayload?.code));
              return;
            }
          }

          const uploaded = (await response.json()) as {
            objectKey: string;
            name: string;
            mediaType: string;
            size: number;
            kind: "text" | "file";
            archive?: { includedFiles?: number; excludedFiles?: number };
          };
          const guestAttachment: ChatAttachment = {
            id: crypto.randomUUID(),
            name: uploaded.name,
            mediaType: uploaded.mediaType,
            size: uploaded.size,
            objectKey: uploaded.objectKey,
            data: uploaded.mediaType.startsWith("image/")
              ? await fileToDataUrl(file)
              : undefined,
            kind: uploaded.kind,
            archive: archiveSummaryOf(uploaded.archive),
          };
          setPendingAttachments((current) =>
            current.filter((item) => item.id !== trackingId)
          );
          onAttachmentsChange((current) => [...current, guestAttachment], scopeId);
          noticeArchiveExclusions(uploaded.archive);
          return;
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
          const prepared = (await prepareResponse
            .json()
            .catch(() => null)) as { code?: string } | null;
          fail(attachmentErrorMessage(prepared?.code));
          return;
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
        await discardResponseBody(uploadResponse);
        if (!uploadResponse.ok) {
          throw new Error(`R2 upload failed: ${uploadResponse.status}`);
        }

        // The bytes have left the browser; what remains is the server
        // validating and extracting them. That is a different wait with a
        // different explanation, so it is a different stage on screen.
        setPendingAttachments((current) =>
          current.map((item) =>
            item.id === trackingId ? { ...item, stage: "processing" } : item
          )
        );

        const finalizeResponse = await fetch("/api/chat", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key,
            name: file.name,
            mediaType,
            size: file.size,
          }),
        });
        if (!finalizeResponse.ok) {
          // The server said why. Until now this threw the answer away and the
          // catch below showed "try again" for every cause there is.
          const finalizeError = (await finalizeResponse
            .json()
            .catch(() => null)) as { code?: string } | null;
          fail(attachmentErrorMessage(finalizeError?.code));
          return;
        }
        const finalized = (await finalizeResponse.json()) as {
          uploadId?: string;
          name?: string;
          size?: number;
          kind?: "file" | "text";
          archive?: { includedFiles?: number; excludedFiles?: number };
        };

        /*
          The storage key stops here.

          Finalisation is the last step that knows one; what it hands back is
          an opaque upload id, and that is what the composer holds, what the
          send carries, and what the message save binds. A key the browser
          keeps is a key a request body carries, and a key in a request body is
          something a route then has to decide whether to believe
          (docs/policy/user-attachment-persistence.md).
        */
        const attachment: ChatAttachment = {
          id: crypto.randomUUID(),
          name: finalized.name || file.name,
          mediaType,
          size: finalized.size || file.size,
          uploadId: finalized.uploadId,
          data: mediaType.startsWith("image/")
            ? await fileToDataUrl(file)
            : undefined,
          kind: finalized.kind || attachmentKindForFormat(format),
          archive: archiveSummaryOf(finalized.archive),
        };
        setPendingAttachments((current) =>
          current.filter((item) => item.id !== trackingId)
        );
        // Appended through a reducer rather than by rebuilding the list this
        // closure captured: several files can finish while it still holds the
        // list as it looked when the batch started, and appending to a stale
        // copy silently drops whichever one landed first. `scopeId` sends it
        // to the conversation the file was picked in, which may no longer be
        // the one on screen.
        onAttachmentsChange((current) => [...current, attachment], scopeId);
        noticeArchiveExclusions(finalized.archive);
      } catch (error) {
        console.error("Attachment upload failed:", error);
        fail(t("chat.attachmentUploadError"));
      }
    },
    [
      attachmentErrorMessage,
      guestAttachmentErrorMessage,
      isEphemeralAttachment,
      maxAttachmentBytes,
      noticeArchiveExclusions,
      onAttachmentsChange,
      requestGuestVerificationToken,
      t,
    ]
  );

  const runUploadBatch = useCallback(
    async (
      entries: Array<{ file: File; trackingId: string }>,
      // Read once, when the batch starts, so every file in it is attributed to
      // the conversation the user actually picked it in.
      scopeId: string = draftScopeIdRef.current
    ) => {
      setIsUploading(true);
      try {
        for (const entry of entries) {
          await uploadOneFile(entry.file, entry.trackingId, scopeId);
        }
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [uploadOneFile]
  );

  const handleFilesSelected = async (files: FileList | File[] | null) => {
    if (!files?.length) return;

    const availableSlots =
      maxAttachments - attachments.length - scopedPendingAttachments.length;
    if (availableSlots <= 0) {
      dispatchAppToast(
        isEphemeralAttachment
          ? t("chat.guestAttachmentCountError")
          : t("chat.attachmentCountError"),
        "error"
      );
      return;
    }

    const entries = Array.from(files)
      .slice(0, availableSlots)
      .map((file) => ({ file, trackingId: crypto.randomUUID() }));
    await runUploadBatch(entries);
  };

  const handleRetryFailedAttachment = useCallback(
    (failed: FailedAttachment) => {
      // Retried into the conversation it originally failed in, which is the
      // only one its card is ever shown in.
      void runUploadBatch(
        [{ file: failed.file, trackingId: failed.id }],
        failed.scopeId
      );
    },
    [runUploadBatch]
  );

  const handleDismissFailedAttachment = useCallback((id: string) => {
    setFailedAttachments((current) => current.filter((item) => item.id !== id));
  }, []);

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

  /**
   * Refusal is the same sentence and the same toast wherever the file was
   * dropped: the composer's own zone and the conversation canvas both end
   * here rather than each writing their own.
   */
  const refuseAttachmentDrop = useCallback(() => {
    dispatchAppToast(t("chat.loginToAttach"), "info");
  }, [t]);

  const isConversationDragActive = useConversationDropSurface({
    surface: conversationDropSurface,
    canAttach,
    onFiles: (files) => {
      void handleFilesSelected(files);
    },
    onRefused: refuseAttachmentDrop,
  });

  // Each of the four stands down for an event the canvas already claimed --
  // which is every drag over the composer while it is portalled into the
  // welcome surface, because the canvas listens in the capture phase. Without
  // it, the same file would be uploaded twice from one drop.
  const handleDropZoneDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (isDragEventClaimed(event.nativeEvent)) return;
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(true);
  };

  const handleDropZoneDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (isDragEventClaimed(event.nativeEvent)) return;
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = canAttach ? "copy" : "none";
    setIsDragActive(true);
  };

  const handleDropZoneDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (isDragEventClaimed(event.nativeEvent)) return;
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragActive(false);
    }
  };

  const handleDropZoneDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (isDragEventClaimed(event.nativeEvent)) return;
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);

    if (!canAttach) {
      refuseAttachmentDrop();
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
    if (!canConnectGoogleDrive || isUploading) return;

    const availableSlots = maxAttachments - attachments.length;
    if (availableSlots <= 0) {
      dispatchAppToast(t("chat.attachmentCountError"), "error");
      return;
    }

    setIsUploading(true);
    try {
      const configResponse = await fetch("/api/chat");
      if (!configResponse.ok) {
        await discardResponseBody(configResponse);
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
          await discardResponseBody(response);
          throw new Error(`Google Drive import failed: ${response.status}`);
        }

        const imported = await response.json();
        importedAttachments.push({
          id: crypto.randomUUID(),
          name: imported.name,
          mediaType: imported.mediaType,
          size: imported.size,
          uploadId: imported.uploadId,
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

    // Nothing to reclaim: a file that never finished uploading, or one whose
    // message is already saved. The second case is deliberate -- removing a
    // card from the composer is editing a draft, and a stored turn keeps the
    // files it was sent with (docs/policy/user-attachment-persistence.md).
    if (!attachment.objectKey && !attachment.uploadId) return;
    if (attachment.attachmentId) return;

    try {
      // A guest object lives on its own endpoint, scoped to the guest session
      // that uploaded it. Deleting it here is what keeps the common case --
      // pick a file, change your mind -- from leaving an orphan for the TTL
      // sweep to find an hour later. A signed-in account names the upload id
      // instead: the composer has no storage key to send.
      const response = await fetch(
        isEphemeralAttachment ? "/api/chat/guest-attachment" : "/api/chat",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isEphemeralAttachment
              ? { key: attachment.objectKey }
              : { uploadId: attachment.uploadId }
          ),
        }
      );
      await discardResponseBody(response);
      if (!response.ok) {
        throw new Error(`R2 deletion failed: ${response.status}`);
      }
    } catch (error) {
      console.error("Attachment deletion failed:", error);
    }
  };

  // Both composer tool chips. They always sit in a row of their own above the
  // textarea -- see docs/ui-contracts/mobile-chat-composer.md -- and only the
  // label length differs between the shells, so the two never drift apart.
  const hasToolStatusChips = webSearchState.isVisible || isDeepResearchPending;
  const toolStatusChips = hasToolStatusChips ? (
    <>
    {webSearchState.isVisible && (
      <div
        data-testid="web-search-mode-chip"
        data-tone={webSearchState.tone}
        data-supported-count={webSearchState.supportedCount}
        data-unsupported-count={webSearchState.unsupportedCount}
        // 32px tall on mobile so the row the chip got back costs the answer
        // canvas as little as possible; the controls inside keep their 44px
        // touch area through ::before insets rather than through box height.
        className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-full border pl-3 pr-1.5 text-xs font-bold ${isMobileShell ? "h-8" : "h-9"} ${
          webSearchState.tone === "blocked"
            ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
            : webSearchState.tone === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
              : "border-accent-web-search-200 bg-accent-web-search-50 text-accent-web-search-800 dark:border-accent-web-search-900/60 dark:bg-accent-web-search-950/30 dark:text-accent-web-search-200"
        }`}
      >
        <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {/*
          When nothing can search there is no "which ones" worth
          expanding -- the blocking notice below already names the
          two ways out, so the chip stays a plain label.
        */}
        {webSearchState.hasException && !webSearchState.allUnsupported ? (
          <button
            type="button"
            data-testid="web-search-exception-toggle"
            aria-expanded={isWebSearchExceptionOpen}
            aria-controls="web-search-exception-detail"
            aria-describedby="web-search-state-description"
            onClick={() => setIsWebSearchExceptionOpen((open) => !open)}
            // The chip itself is 36px tall, so the toggle borrows
            // vertical hit area from a pseudo-element rather than
            // growing the chip. Horizontal inset stays small so it
            // never overlaps the adjacent remove control.
            className={`relative truncate rounded-full text-left underline decoration-dotted underline-offset-2 before:absolute before:content-[''] before:-inset-x-1 ${
              isMobileShell ? "before:-inset-y-3.5" : "before:-inset-y-1"
            }`}
          >
            {isMobileShell ? webSearchChipCompactLabel : webSearchChipLabel}
          </button>
        ) : (
          <span
            className="truncate"
            aria-describedby="web-search-state-description"
          >
            {isMobileShell ? webSearchChipCompactLabel : webSearchChipLabel}
          </span>
        )}
        <button
          type="button"
          onClick={() => onWebSearchModeChange?.("off")}
          aria-label={t("chat.removeWebSearchMode")}
          title={t("chat.removeWebSearchMode")}
          className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full before:absolute before:content-[''] hover:bg-black/5 dark:hover:bg-white/10 ${isMobileShell ? "before:-inset-2.5" : "before:-inset-1"}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )}
    {isDeepResearchPending && (
      <div
        data-testid="deep-research-chip"
        className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-accent-deep-research-200 bg-accent-deep-research-50 pl-3 pr-1.5 text-xs font-bold text-accent-deep-research-800 dark:border-accent-deep-research-900/60 dark:bg-accent-deep-research-950/30 dark:text-accent-deep-research-200 ${isMobileShell ? "h-8" : "h-9"}`}
        title={t("chat.deepResearchChipTooltip")}
      >
        <Microscope className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{t("chat.deepResearchChipLabel")}</span>
        <button
          type="button"
          onClick={() => onDismissDeepResearchChip?.()}
          aria-label={t("chat.removeDeepResearchChip")}
          title={t("chat.removeDeepResearchChip")}
          className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-accent-deep-research-500 before:absolute before:content-[''] hover:bg-accent-deep-research-100 dark:hover:bg-accent-deep-research-900/40 ${isMobileShell ? "before:-inset-2.5" : "before:-inset-1"}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )}
    </>
  ) : null;
  const webSearchExceptionDetail =
    webSearchState.hasException &&
    !webSearchState.allUnsupported &&
    isWebSearchExceptionOpen ? (
      <p
        id="web-search-exception-detail"
        data-testid="web-search-exception-detail"
        className="mb-2 px-1 text-[11px] leading-4 text-zinc-600 dark:text-zinc-300"
      >
        {interpolateCopy(t("chat.webSearchUnsupportedModels"), {
          models: webSearchUnsupportedModelNames,
        })}{" "}
        {t("chat.webSearchUnsupportedBehavior")}
      </p>
    ) : null;

  // Drives which model-picker layout renders below: the original compact,
  // single-scroll mobile sheet (filters scroll away together with the
  // list, matching this same breakpoint's MobileModelMenuPortal decision
  // above) vs. the wider two-pane modal on desktop.
  const isMobileModelMenu = useSyncExternalStore(
    subscribeToMobileModelMenu,
    getMobileModelMenuSnapshot,
    getServerMobileModelMenuSnapshot
  );

  // UI-001. The sheet below is `position: fixed`, and a fixed element is laid
  // out against the *layout* viewport -- which iOS Safari (and Android Chrome
  // in its default mode) leaves at full height when the keyboard opens. So
  // `bottom: 0.5rem` resolves to half a rem above the bottom of a viewport the
  // user can no longer see, and the footer that carries "Done" plus the last
  // candidate rows go under the keyboard. `dvh` does not help: it tracks the
  // dynamic viewport (URL bar), not the keyboard.
  //
  // Adding the occluded height back as a bottom inset is the whole fix. The
  // sheet's own `flex` contract does the rest: header, search, selected summary
  // and footer are all `shrink-0`, the candidate list is the only `flex-1`
  // region, so a shorter sheet takes the height out of the list -- which
  // scrolls -- and never out of the controls that end the task.
  const keyboardInset = useKeyboardInset();
  const compactSheetKeyboardInset = isMobileModelMenu ? keyboardInset : 0;

  return (
      <div className={variant === "floating"
        ? "w-full max-w-full shrink-0 overflow-hidden px-0 py-0 md:overflow-visible"
        : `w-full max-w-full shrink-0 overflow-hidden bg-zinc-50/95 px-2 py-1 pb-[calc(0.3rem+env(safe-area-inset-bottom))] transition-colors dark:bg-zinc-950 md:overflow-visible md:px-6 md:py-3 md:pb-3 ${
            hideTopBorder ? "" : "border-t border-zinc-200 dark:border-zinc-800"
          }`
      }>
          {/*
            The canvas overlay is portalled into the surface itself rather
            than drawn from here: it has to cover the whole answer area, which
            is the shell's element, and it must not take part in that
            element's layout. Absolutely positioned and `pointer-events-none`,
            so nothing behind it moves and nothing behind it stops receiving
            the drag.
          */}
          {conversationDropSurface && isConversationDragActive
            ? createPortal(
                <div
                  data-testid="chat-conversation-drop-overlay"
                  className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-white/80 text-center backdrop-blur-sm dark:bg-zinc-950/80"
                >
                  <div className="rounded-3xl border border-dashed border-blue-400 bg-white/90 px-8 py-6 shadow-sm dark:bg-zinc-900/90">
                    <DropGuidance
                      title={
                        canAttach ? t("chat.dropFilesHere") : t("chat.loginToAttach")
                      }
                      description={
                        canAttach ? t("chat.dropFilesDescription") : undefined
                      }
                    />
                  </div>
                </div>,
                conversationDropSurface
              )
            : null}
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
            <div
              data-testid="chat-composer-drop-overlay"
              className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border border-dashed border-blue-400 bg-white/85 text-center shadow-sm backdrop-blur-sm dark:bg-zinc-950/85"
            >
              <DropGuidance
                title={canAttach ? t("chat.dropFilesHere") : t("chat.loginToAttach")}
                description={canAttach ? t("chat.dropFilesDescription") : undefined}
              />
            </div>
          )}
          {addOnCreditsForRequest > 0 && (
            <div className="mb-2 rounded-xl border border-status-success-200 bg-status-success-50 px-3 py-2 text-xs font-semibold leading-5 text-status-success-900 dark:border-status-success-900/60 dark:bg-status-success-950/30 dark:text-status-success-100">
              {interpolateCopy(t("chat.addOnCreditsWillBeUsed"), {
                credits: addOnCreditsForRequest,
              })}
            </div>
          )}
          {operationalHoldActive && !isUsageLimitReached && (
            <div
              data-testid="operational-hold-notice"
              role="status"
              className="mb-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
            >
              {serverAvailability?.blockCode === "PROVIDER_BUDGET_EXHAUSTED"
                ? t("chat.providerCostSafetyLimit")
                : t("chat.operationalCostGuardrail")}
            </div>
          )}
          {isUsageLimitReached && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              <span className="font-bold">
                {isGuestMode ? t("chat.guestLimitReachedTitle") : t("chat.accountLimitReachedTitle")}
              </span>
              <button
                type="button"
                data-testid="usage-limit-view-options"
                onClick={() => setIsUsageLimitModalOpen(true)}
                className="shrink-0 font-bold text-amber-900 underline underline-offset-2 dark:text-amber-100"
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
            <div className="mb-2 flex max-w-full flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  dismissGuestQuickStart();
                  onChange(personalizedPrompt);
                }}
                className="min-w-0 max-w-full touch-manipulation whitespace-normal break-words rounded-full border border-blue-300 bg-blue-50 px-3 py-1.5 text-left text-xs font-bold text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200 dark:hover:bg-blue-950/60"
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
                    <p className="text-xs font-bold text-zinc-900 dark:text-white">
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
                      className="rounded-xl bg-amber-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-amber-500"
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
              className="mb-2 rounded-2xl border border-accent-web-search-200 bg-accent-web-search-50 px-3 py-3 dark:border-accent-web-search-900/60 dark:bg-accent-web-search-950/20"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-zinc-900 dark:text-white">
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
                    className="rounded-xl bg-accent-web-search-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-accent-web-search-500"
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
                    className="rounded-xl border border-accent-web-search-300 bg-white px-3 py-2 text-[11px] font-bold text-accent-web-search-900 hover:bg-accent-web-search-100 dark:border-accent-web-search-800 dark:bg-zinc-950 dark:text-accent-web-search-200"
                  >
                    {t("chat.webSearchSuggestionDecline")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {/*
            The chips own a row of their own in *both* shells. They used to ride
            the mobile textarea's first line, which left the input whatever
            horizontal space the chips did not want; the composer contract in
            docs/ui-contracts/mobile-chat-composer.md forbids that. Chips wrap
            onto a second line rather than scrolling sideways or squeezing the
            row below them. Only the label length is shell-specific, which
            `data-label-variant` states so tests read it from the DOM.
          */}
          {hasToolStatusChips && (
            <div
              data-testid="tool-status-chip-row"
              data-placement="row"
              data-label-variant={isMobileShell ? "compact" : "full"}
              className="mb-1.5 flex max-w-full flex-wrap gap-1.5 md:mb-3"
            >
              {toolStatusChips}
            </div>
          )}
          {/*
            The full request state -- mode, how many models can honour it, how
            many cannot, the credit ceiling and what the unsupported models
            actually do -- always exists for assistive tech, but only costs a
            visible row when there is a real exception to resolve. "Unsupported
            0" is the normal case and no longer earns a line of its own.
          */}
          {webSearchState.isVisible && (
            <p id="web-search-state-description" className="sr-only">
              {webSearchStateDescription}
            </p>
          )}
          {/* The detail belongs directly under the chip row it expands from,
              in both shells. */}
          {webSearchExceptionDetail}
          {webSearchState.allUnsupported && (
            <div
              role="status"
              data-testid="web-search-unavailable-notice"
              className="mb-2 flex flex-col gap-2 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100 sm:flex-row sm:items-center"
            >
              <p className="min-w-0 flex-1">{t("chat.webSearchUnavailableAction")}</p>
              <button
                type="button"
                data-testid="web-search-unavailable-turn-off"
                onClick={() => onWebSearchModeChange?.("off")}
                className={`shrink-0 rounded-lg border border-red-400 bg-white px-2.5 font-bold text-red-900 transition hover:bg-red-100 dark:border-red-700 dark:bg-zinc-950 dark:text-red-100 dark:hover:bg-red-950/60 ${isMobileShell ? "min-h-11" : "py-1.5"}`}
              >
                {t("chat.webSearchTurnOff")}
              </button>
            </div>
          )}
          {(attachments.length > 0 ||
            scopedPendingAttachments.length > 0 ||
            scopedFailedAttachments.length > 0) && (
            <div
              data-testid="attachment-tray"
              className="mb-2 rounded-2xl bg-zinc-50 p-1.5 dark:bg-zinc-950/70 md:mb-3 md:bg-transparent md:p-0"
            >
            <div className="flex max-h-[35dvh] max-w-full flex-wrap gap-2 overflow-x-hidden overflow-y-auto overscroll-contain md:max-h-none md:overflow-visible">
              {/* UI-STATE-002. In-flight files are cards of their own, in the
                  same tray as finished ones, so the user can see which file
                  is where. Each names the file and the step actually running;
                  neither offers a cancel button, because the upload pipeline
                  has no abort path today and a control that does nothing is
                  worse than the honest "please wait" this gives instead. */}
              {scopedPendingAttachments.map((pending) => {
                const stageLabel =
                  pending.stage === "uploading"
                    ? t("chat.attachmentUploadingLabel")
                    : t("chat.attachmentProcessingLabel");
                const stageHint =
                  pending.stage === "uploading"
                    ? t("chat.attachmentUploadingHint")
                    : t("chat.attachmentProcessingHint");
                return (
                  <div
                    key={pending.id}
                    role="status"
                    aria-live="polite"
                    data-testid="attachment-pending"
                    data-stage={pending.stage}
                    aria-describedby={`attachment-stage-${pending.id}`}
                    className="relative flex min-h-14 w-full min-w-0 max-w-full items-center gap-[10px] rounded-xl border border-zinc-200 bg-white py-2 pl-[8px] pr-[8px] text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 md:min-h-16 md:w-auto md:min-w-52 md:max-w-64 md:shrink-0"
                  >
                    <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-lg bg-white text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span
                        data-testid="attachment-pending-name"
                        className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100"
                      >
                        {pending.name}
                      </span>
                      <span
                        data-testid="attachment-pending-stage"
                        className="truncate text-[11px] font-semibold text-zinc-600 dark:text-zinc-300"
                      >
                        {stageLabel}
                      </span>
                    </span>
                    {/* The wait explanation is the accessible description
                        rather than a third visible line: the tray is beside a
                        composer that must keep its own full-width row. */}
                    <span id={`attachment-stage-${pending.id}`} className="sr-only">
                      {`${pending.name}: ${stageLabel}. ${stageHint}`}
                    </span>
                  </div>
                );
              })}
              {scopedFailedAttachments.map((failed) => (
                <div
                  key={failed.id}
                  role="alert"
                  data-testid="attachment-failed"
                  // The failure card is allowed to be taller than the chips
                  // beside it: the reason is the point of the card, so it
                  // wraps rather than truncating to an ellipsis the user then
                  // has no way to read.
                  className="relative flex min-h-14 w-full min-w-0 max-w-full items-center gap-[10px] rounded-xl border border-red-300 bg-red-50 px-[8px] py-2 text-red-900 shadow-sm dark:border-red-800 dark:bg-red-950/40 dark:text-red-100 md:min-h-16 md:w-auto md:min-w-56 md:max-w-72 md:shrink-0"
                >
                  <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-lg bg-white text-red-600 ring-1 ring-red-200 dark:bg-zinc-900 dark:text-red-300 dark:ring-red-900">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      data-testid="attachment-failed-name"
                      className="truncate text-sm font-medium"
                    >
                      {failed.name}
                    </span>
                    <span
                      data-testid="attachment-failed-reason"
                      className="text-[11px] font-semibold leading-4"
                    >
                      {failed.reason}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    {/* Both actions really run: retry re-uploads the File this
                        entry still holds, remove drops the entry. Each names
                        the file so two failures are told apart by voice. */}
                    <button
                      type="button"
                      data-testid="attachment-retry"
                      onClick={() => handleRetryFailedAttachment(failed)}
                      aria-label={`${t("chat.attachmentRetry")}: ${failed.name}`}
                      className={`relative flex items-center justify-center rounded-full text-red-800 transition hover:bg-red-200 dark:text-red-100 dark:hover:bg-red-900/60 ${
                        isMobileShell ? "h-11 w-11" : "h-7 w-7"
                      }`}
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      data-testid="attachment-failed-dismiss"
                      onClick={() => handleDismissFailedAttachment(failed.id)}
                      aria-label={`${t("chat.removeAttachment")}: ${failed.name}`}
                      className={`relative flex items-center justify-center rounded-full text-red-800 transition hover:bg-red-200 dark:text-red-100 dark:hover:bg-red-900/60 ${
                        isMobileShell ? "h-11 w-11" : "h-7 w-7"
                      }`}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </span>
                </div>
              ))}
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  data-testid="attachment-complete"
                  className={
                    attachment.data
                      ? "relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 md:h-20 md:w-20"
                      : "relative flex min-h-14 w-full min-w-0 max-w-full items-center gap-[10px] rounded-xl border border-zinc-200 bg-white py-2 pl-[8px] pr-[32px] text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 md:min-h-16 md:w-auto md:min-w-52 md:max-w-64 md:shrink-0"
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
                      <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-lg bg-white text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700">
                        {getAttachmentIcon(attachment)}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {attachment.name}
                        </span>
                        <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500">
                          {getAttachmentLabel(attachment)}
                        </span>
                        {attachment.archive ? (
                          /*
                            The archive's own contents, for as long as the file
                            is attached. This used to be a four-second toast and
                            nothing else, so a skipped file became visible only
                            as an absence in the answer.
                          */
                          <span
                            data-testid="attachment-archive-summary"
                            className={`text-[11px] font-medium ${
                              attachment.archive.excludedFiles > 0
                                ? "text-amber-700 dark:text-amber-400"
                                : "text-zinc-400 dark:text-zinc-500"
                            }`}
                          >
                            {[
                              interpolateCopy(t("chat.archiveReadSummary"), {
                                count: attachment.archive.includedFiles,
                              }),
                              ...(attachment.archive.excludedFiles > 0
                                ? [
                                    interpolateCopy(
                                      t("chat.archiveExcludedSummary"),
                                      { count: attachment.archive.excludedFiles }
                                    ),
                                  ]
                                : []),
                            ].join(" · ")}
                          </span>
                        ) : null}
                      </span>
                    </>
                  )}
                  <button
                    type="button"
                    data-testid="attachment-remove"
                    onClick={() => handleRemoveAttachment(attachment)}
                    // No `relative` here. Both branches below position the
                    // button with `absolute`, and an absolutely positioned
                    // element is already the containing block its own
                    // `before:` touch target needs. Spelling both out let
                    // Tailwind's stylesheet order decide -- `.relative` is
                    // emitted after `.absolute`, so it won, the button fell
                    // back into flow, and the image branch's `overflow-hidden`
                    // clipped it away: an attached image had no remove control
                    // at all.
                    className={`before:absolute before:content-[''] ${isMobileShell ? "before:-inset-3" : "before:-inset-1"} ${
                      attachment.data
                        ? "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-950/80 text-white hover:bg-zinc-950"
                        : "absolute right-[8px] top-[8px] flex h-[20px] w-[20px] items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-700 dark:hover:text-white"
                    }`}
                    title={t("chat.removeAttachment")}
                    aria-label={`${t("chat.removeAttachment")}: ${attachment.name}`}
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
                <span className="font-bold">{t("chat.imageUnsupportedSelected")}</span>{" "}
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
        {/*
          The textarea's own row. Nothing else may enter it: no chip, no badge,
          no absolutely positioned control. Whatever the tool state is, the
          input keeps the composer's full inner width and at least one complete
          visible line -- the invariant in
          docs/ui-contracts/mobile-chat-composer.md.
        */}
        <div data-testid="composer-textarea-row" className="flex w-full min-w-0">
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
          // The min/max heights are in rem, not px, so a reader at 200% text
          // scaling still gets a complete first line instead of a box frozen
          // at one 16px-root line's worth of height.
          className={`w-full min-w-0 max-h-[5.75rem] min-h-[2.25rem] flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1.5 text-base leading-5 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:text-zinc-100 dark:placeholder:text-zinc-500 md:max-h-[12.5rem] md:min-h-[3.25rem] md:py-2 md:text-sm md:leading-6 ${preserveFormatting ? "overflow-x-auto whitespace-pre font-mono" : ""}`}
        />
        </div>
        {/*
          The actions row. It wraps and its model button truncates rather than
          pushing the send button past the composer's edge: at 200% zoom (a
          195px layout viewport) a fixed-width rail used to overflow, and the
          composer's own `overflow-hidden` then clipped Send out of sight.
        */}
        <div className="relative flex flex-wrap items-center justify-between gap-1.5" ref={menuRef}>
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
            data-testid="composer-tools-button"
            title={t("chat.addAndTools")}
            aria-label={t("chat.addAndTools")}
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

        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
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
            className={`flex min-w-0 max-w-[112px] touch-manipulation items-center gap-1 rounded-full border border-zinc-300 bg-zinc-50 px-2.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800 ${isMobileShell ? "h-11" : "h-10"}`}
            // Named so the outage banner can hand focus back to the model
            // selector when a swap or a recovered provider unmounts the
            // control the user was standing on (ProviderStatusBanner).
            data-testid="composer-model-select"
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
              // The same number is the visible label beside it
              // ("3 AIs") and part of the button's accessible name, so the
              // badge is a decorative repeat and stays out of the
              // accessibility tree.
              <span
                aria-hidden="true"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white"
              >
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
                t("chat.creditEstimateAria").replace(
                  "{credits}",
                  String(estimatedRequestCredits)
                )
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
              title={`${t("chat.send")} · ${estimatedRequestCredits} ${t("chat.creditUnit")}`}
              aria-label={`${t("chat.send")} · ${estimatedRequestCredits} ${t("chat.creditUnit")}`}
              aria-describedby={
                sendDisabledReason ? "chat-send-disabled-reason" : undefined
              }
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
          {sendDisabledReason && (
            <p
              id="chat-send-disabled-reason"
              data-testid="chat-send-disabled-reason"
              className="sr-only"
            >
              {sendDisabledReason}
            </p>
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
              // The dialog is named for the view inside it, so a screen
              // reader announces where the user actually is rather than the
              // menu they opened three steps ago.
              aria-label={
                menuView === "models"
                  ? t("chat.modelSelect")
                  : menuView === "webSearch"
                    ? t("chat.toolsWebSearch")
                    : menuView === "attachSource"
                      ? t("chat.attachSourceTitle")
                      : menuView === "assistant"
                        ? t("chat.assistantPickerTitle")
                        : menuView === "memory"
                          ? t("chat.toolsMemory")
                          : t("chat.addAndTools")
              }
              tabIndex={-1}
              // Exposed for the responsive suite so a keyboard fixture can
              // assert the sheet actually reacted, rather than inferring it
              // from a rect that would also pass with no keyboard at all.
              data-keyboard-inset={compactSheetKeyboardInset || undefined}
              style={
                compactSheetKeyboardInset > 0
                  ? {
                      bottom: `calc(${compactSheetKeyboardInset}px + 0.5rem + env(safe-area-inset-bottom))`,
                      maxHeight: `calc(100dvh - ${compactSheetKeyboardInset}px - 1rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))`,
                    }
                  : undefined
              }
              className={`fixed inset-x-2 z-[100] flex max-w-[calc(100%_-_1rem)] flex-col overflow-hidden rounded-3xl border border-zinc-200 bg-white p-2 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 md:rounded-2xl ${
                menuView === "models"
                  ? "bottom-[calc(0.5rem+env(safe-area-inset-bottom))] top-[calc(0.5rem+env(safe-area-inset-top))] max-h-none md:inset-x-auto md:left-1/2 md:right-auto md:-translate-x-1/2 md:top-[5vh] md:bottom-[5vh] md:h-[90vh] md:max-h-[900px] md:w-[min(94vw,1000px)] md:max-w-[min(94vw,1000px)]"
                  : "md:left-0 md:right-auto bottom-[calc(0.5rem+env(safe-area-inset-bottom))] max-h-[calc(100dvh-2rem)] md:absolute md:inset-x-auto md:bottom-12 md:top-auto md:max-h-[calc(100dvh-8rem)] md:w-80 md:max-w-[calc(100vw_-_2rem)]"
              }`}
            >
              <div className="mx-auto mb-2 mt-0.5 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
              {/*
                The models view supplies its own header -- a back control, the
                screen title and the selection count -- so this row would be the
                second title in a row: "Choose AI models" stacked directly on
                "All models". Two headers cost 65px, and at 320x568 the model
                list is only 129px tall, which is how a catalogue of 30+ models
                ended up unable to show one complete row. The dialog keeps its
                accessible name either way; it lives on the dialog element, not
                on this text. The picker's own header carries the close control
                on the compact sheet.
              */}
              {menuView !== "models" && (
                <div className="mb-2 flex items-center justify-between border-b border-zinc-200 px-2 pb-2 pt-1 dark:border-zinc-800 md:hidden">
                  <div>
                    {/* Each view says its own name. The subtitle used to
                        read "upload from your computer" on every view that was
                        not web search, which described one row of one of
                        them. */}
                    <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                      {menuView === "webSearch"
                        ? t("chat.toolsWebSearch")
                        : menuView === "attachSource"
                          ? t("chat.attachSourceTitle")
                          : menuView === "assistant"
                            ? t("chat.assistantPickerTitle")
                            : menuView === "memory"
                              ? t("chat.toolsMemory")
                              : t("chat.addAndTools")}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {menuView === "webSearch"
                        ? t("chat.toolsWebSearchDescription")
                        : menuView === "attachSource"
                          ? t("chat.attachSourceSubtitle")
                          : ""}
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
              )}
              {menuView === "actions" ? (
                <div className="space-y-1">
                  {/*
                    One row, not two. Where a file comes from is a question
                    about attaching, so it is asked after the user says they
                    want to attach -- and the limits that used to sit in a
                    bordered card under the whole menu are asked there too,
                    beside the control they describe.
                  */}
                  <button
                    type="button"
                    data-testid="tools-attach-row"
                    disabled={!canAttach || attachments.length >= maxAttachments}
                    onClick={() => setMenuView("attachSource")}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      <Paperclip className="h-5 w-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.attachFile")}</span>
                      <span className="truncate text-xs text-zinc-500">
                        {isEphemeralAttachment
                          ? t("chat.guestAttachmentOneFile")
                          : t("chat.attachSourceSubtitle")}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    data-testid="tools-web-search-row"
                    onClick={() => setMenuView("webSearch")}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-web-search-500/10 text-accent-web-search-500">
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
                  <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
                  {/* §14. Absent for a guest and for an account with the
                      feature off, rather than shown disabled: a guest has no
                      profile of their own for a control to act on. */}
                  {assistantProfile !== undefined && onAssistantProfileChange && (
                    <button
                      type="button"
                      data-testid="tools-assistant-row"
                      onClick={() => setMenuView("assistant")}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-assistant-profile-500/10 text-accent-assistant-profile-500">
                        <Bot className="h-5 w-5" />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {t("chat.toolsAssistant")}
                        </span>
                        <span className="truncate text-xs text-zinc-500">
                          {assistantProfile
                            ? `${assistantProfile.name} \u00B7 ${t("chat.toolsAssistantRevision").replace("{revision}", String(assistantProfile.revision))}`
                            : t("chat.toolsAssistantNone")}
                        </span>
                      </span>
                      {/* A dot, which is what this was, carried the state to
                          nobody: the 2026-08-21 staging round recorded that
                          the mark was seen and its meaning was not, and
                          `aria-hidden` meant a screen reader was told nothing
                          at all. Said in words instead, and the words are the
                          accessible name too. */}
                      {assistantProfile?.status === "superseded" && (
                        <span
                          data-testid="tools-assistant-superseded-badge"
                          className="ml-auto shrink-0 rounded-full bg-accent-assistant-profile-500/10 px-2 py-0.5 text-xs font-medium text-accent-assistant-profile-500"
                        >
                          {t("chat.toolsAssistantNewRevisionAvailable")}
                        </span>
                      )}
                    </button>
                  )}
                  {/* docs/policy/external-conversation-import-and-memory.md
                      §8.1 invariant 1. Absent for a guest rather than shown
                      disabled: a guest has no account memory for a control to
                      act on, and offering one would imply otherwise. */}
                  {memoryMode && onMemoryModeChange && (
                    <button
                      type="button"
                      data-testid="tools-memory-row"
                      onClick={() => setMenuView("memory")}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-account-memory-500/10 text-accent-account-memory-500">
                        <BookMarked className="h-5 w-5" />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {t("chat.toolsMemory")}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {memoryMode === "on"
                            ? t("chat.toolsMemoryOn")
                            : memoryMode === "off"
                              ? t("chat.toolsMemoryOff")
                              : accountMemoryDefault === "off"
                                ? t("chat.toolsMemoryInheritOff")
                                : t("chat.toolsMemoryInheritOn")}
                        </span>
                      </span>
                    </button>
                  )}
                  <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
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
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-deep-research-500/10 text-accent-deep-research-500">
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
                  {(onStartImageDraft || imageGenerationLock) && (
                    <button
                      type="button"
                      data-testid="tools-image-generation-row"
                      data-locked={imageGenerationLock ? "true" : "false"}
                      onClick={() => {
                        closeMenu(false);
                        if (imageGenerationLock) {
                          // Same routing the locked model rows use: state the
                          // requirement, then hand off to the existing
                          // sign-in / upgrade prompt rather than inventing a
                          // second one.
                          onLockedImageGenerationClick?.(imageGenerationLock);
                          return;
                        }
                        // No server row is created here: switching to the
                        // image draft is a client-side move, and the
                        // conversation only exists once a generation is
                        // actually reserved (policy section 6).
                        onStartImageDraft?.(value);
                      }}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-image-500/10 text-accent-image-500">
                        <ImagePlus className="h-5 w-5" />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {t("chat.toolsImageGeneration")}
                        </span>
                        <span
                          className={`text-xs ${
                            imageGenerationLock
                              ? "font-semibold text-amber-600 dark:text-amber-400"
                              : "text-zinc-500"
                          }`}
                        >
                          {imageGenerationLock === "sign_in"
                            ? t("modelStatusReasons.loginRequired")
                            : imageGenerationLock === "upgrade"
                              ? t("modelStatusReasons.upgradeRequired")
                              : t("chat.toolsImageGenerationDescription")}
                        </span>
                      </span>
                    </button>
                  )}
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
                        webSearchMode === mode ? "bg-accent-web-search-500/10" : ""
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-web-search-500/10 text-accent-web-search-500">
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
                        <Check className="h-4 w-4 shrink-0 text-accent-web-search-500" aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
              ) : menuView === "memory" ? (
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setMenuView("actions")}
                    className={`mb-1 flex items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white ${isMobileShell ? "h-11 w-11" : "h-8 w-8"}`}
                    aria-label={t("auth.cancel")}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  {CONVERSATION_MEMORY_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      data-testid={`memory-mode-option-${mode}`}
                      aria-pressed={memoryMode === mode}
                      onClick={() => {
                        onMemoryModeChange?.(mode);
                        closeMenu(false);
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                        memoryMode === mode
                          ? "bg-accent-account-memory-500/10"
                          : ""
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-account-memory-500/10 text-accent-account-memory-500">
                        <BookMarked className="h-5 w-5" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {mode === "on"
                            ? t("chat.toolsMemoryOn")
                            : mode === "off"
                              ? t("chat.toolsMemoryOff")
                              : t("chat.toolsMemoryInherit")}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {mode === "on"
                            ? t("chat.toolsMemoryOnDescription")
                            : mode === "off"
                              ? t("chat.toolsMemoryOffDescription")
                              : accountMemoryDefault === "off"
                                ? t("chat.toolsMemoryInheritOffDescription")
                                : t("chat.toolsMemoryInheritOnDescription")}
                        </span>
                      </span>
                      {memoryMode === mode && (
                        <Check
                          className="h-4 w-4 shrink-0 text-accent-account-memory-500"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ))}
                </div>
              ) : menuView === "attachSource" ? (
                /*
                  Where a file comes from, asked once the user has said they
                  want to attach one.

                  The limits live here rather than in the bordered card that
                  used to sit under the whole root menu: they describe this
                  control, and stated beside it they are supporting text
                  instead of a paragraph everybody scrolls past on their way
                  to something else.
                */
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setMenuView("actions")}
                    className={`mb-1 flex items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white ${isMobileShell ? "h-11 w-11" : "h-8 w-8"}`}
                    aria-label={t("chat.backToMenu")}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    data-testid="attach-local-file-row"
                    disabled={!canAttach || attachments.length >= maxAttachments}
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
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {t("chat.uploadFromComputer")}
                      </span>
                    </span>
                  </button>
                  {/*
                    Google Drive needs an OAuth grant an anonymous session
                    cannot hold, so for a guest this is not a disabled control
                    with no explanation -- it names the reason and offers the
                    one action that changes it.
                  */}
                  <button
                    type="button"
                    data-testid="attach-google-drive-row"
                    data-locked={canConnectGoogleDrive ? "false" : "true"}
                    disabled={
                      canConnectGoogleDrive &&
                      attachments.length >= maxAttachments
                    }
                    onClick={() => {
                      closeMenu(false);
                      if (!canConnectGoogleDrive) {
                        onGuestSignInPrompt?.();
                        return;
                      }
                      void handleGoogleDriveSelect();
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                      {canConnectGoogleDrive ? (
                        <HardDrive className="h-5 w-5" />
                      ) : (
                        <Lock className="h-5 w-5" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.attachGoogleDrive")}</span>
                      <span
                        className={`text-xs ${
                          canConnectGoogleDrive
                            ? "text-zinc-500"
                            : "text-amber-600 dark:text-amber-400"
                        }`}
                      >
                        {canConnectGoogleDrive
                          ? t("chat.googleDriveDescription")
                          : t("chat.guestGoogleDriveSignIn")}
                      </span>
                    </span>
                  </button>
                  <p
                    data-testid="attach-limits"
                    className="px-3 pt-1 text-xs leading-5 text-zinc-500"
                  >
                    {canAttach ? t("chat.attachLimitsSummary") : t("chat.loginToAttach")}
                  </p>
                  {/*
                    Which formats, before the picker opens. Derived from the
                    shared registry, so this cannot fall behind what the
                    picker actually accepts.
                  */}
                  {canAttach && (
                    <ul
                      data-testid="attach-supported-formats"
                      className="space-y-0.5 px-3 text-xs leading-5 text-zinc-500"
                    >
                      {supportedFormatGroups.map((group) => (
                        <li key={group.group} title={`${group.label}: ${group.all}`}>
                          <span className="font-semibold text-zinc-600 dark:text-zinc-300">
                            {group.label}
                          </span>{" "}
                          {group.shown}
                          {group.overflow > 0
                            ? ` ${interpolateCopy(t("chat.attachFormatsOverflow"), {
                                count: group.overflow,
                              })}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {/*
                    A guest's files are held for a short time and are never
                    added to a saved chat, a project, a share link or an
                    export. That is a promise the product has to make where the
                    file is picked, which is now here.
                  */}
                  {isEphemeralAttachment && (
                    <p
                      data-testid="guest-attachment-temporary-note"
                      className="px-3 text-xs font-semibold leading-5 text-zinc-700 dark:text-zinc-200"
                    >
                      {t("chat.guestAttachmentTemporary")}
                    </p>
                  )}
                </div>
              ) : menuView === "assistant" ? (
                /*
                  A collection, not a fixed set of actions, so this is the one
                  view that scrolls by design: the account decides how many
                  assistants there are. The root menu does not scroll for the
                  same reason -- its length is a design decision, and a
                  scrollbar there would be a symptom of one gone wrong.

                  The back control stays put and the list scrolls under it;
                  `min-h-0` is what lets the flex child shrink far enough for
                  `overflow-y-auto` to mean anything.
                */
                <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-picker">
                  <button
                    type="button"
                    onClick={() => setMenuView("actions")}
                    className={`mb-1 flex shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white ${isMobileShell ? "h-11 w-11" : "h-8 w-8"}`}
                    aria-label={t("chat.backToMenu")}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <div
                    data-testid="assistant-picker-list"
                    className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain"
                  >
                  {/* §14. Offered only when the profile has actually published
                      past this conversation, and never performed on its own:
                      a conversation that changed its instructions without
                      being asked could not explain its own earlier answers. */}
                  {assistantProfile?.status === "superseded" && (
                    <button
                      type="button"
                      data-testid="assistant-move-to-latest"
                      onClick={() => {
                        onAssistantProfileChange?.(assistantProfile.profileId);
                        closeMenu(false);
                      }}
                      className="flex w-full items-start gap-3 rounded-xl border border-accent-assistant-profile-300 px-3 py-2.5 text-left transition hover:bg-accent-assistant-profile-500/10"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-assistant-profile-500/10 text-accent-assistant-profile-500">
                        <RefreshCw className="h-5 w-5" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {t("chat.toolsAssistantMoveToLatest")}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {t("chat.toolsAssistantSuperseded")
                            .replace("{revision}", String(assistantProfile.revision))
                            .replace("{latest}", String(assistantProfile.latestRevision))}
                        </span>
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="assistant-option-none"
                    aria-pressed={!assistantProfile}
                    onClick={() => {
                      onAssistantProfileChange?.(null);
                      closeMenu(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                      !assistantProfile ? "bg-accent-assistant-profile-500/10" : ""
                    }`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      <MessageSquare className="h-5 w-5" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {t("chat.toolsAssistantNone")}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {t("chat.toolsAssistantNoneDescription")}
                      </span>
                    </span>
                    {!assistantProfile && (
                      <Check
                        className="h-4 w-4 shrink-0 text-accent-assistant-profile-500"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  {assistantProfileOptions.map((option) => {
                    /*
                     * The row for the profile this conversation already runs
                     * under reports the revision *it* runs, not the one the
                     * profile is on. `option.revision` is `currentRevision` --
                     * the profile's newest -- so a conversation pinned to
                     * revision 1 of a profile since published to 2 read
                     * "Revision 2" with a tick beside it: a claim that the
                     * conversation had moved, when §14 is that nothing moves
                     * it but the user. The tick is right (this profile is the
                     * chosen one); the number was not.
                     *
                     * The description gives way to that line rather than
                     * sitting beside it. On the chosen row the question is
                     * what is running; a description is there to help pick
                     * among the rows that are not.
                     */
                    const boundHere =
                      assistantProfile?.profileId === option.id
                        ? assistantProfile
                        : null;
                    const revisionLine = boundHere
                      ? boundHere.status === "superseded"
                        ? t("chat.toolsAssistantRevisionInUse")
                            .replace("{revision}", String(boundHere.revision))
                            .replace("{latest}", String(boundHere.latestRevision))
                        : t("chat.toolsAssistantRevision").replace(
                            "{revision}",
                            String(boundHere.revision)
                          )
                      : null;
                    return (
                    <button
                      key={option.id}
                      type="button"
                      data-testid={`assistant-option-${option.id}`}
                      aria-pressed={assistantProfile?.profileId === option.id}
                      onClick={() => {
                        onAssistantProfileChange?.(option.id);
                        closeMenu(false);
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                        assistantProfile?.profileId === option.id
                          ? "bg-accent-assistant-profile-500/10"
                          : ""
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-assistant-profile-500/10 text-base">
                        {option.icon ?? (
                          <Bot className="h-5 w-5 text-accent-assistant-profile-500" />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {option.name}
                        </span>
                        <span
                          data-testid={`assistant-option-${option.id}-detail`}
                          className="truncate text-xs text-zinc-500"
                        >
                          {revisionLine ??
                            (option.description ||
                              t("chat.toolsAssistantRevision").replace(
                                "{revision}",
                                String(option.revision)
                              ))}
                        </span>
                      </span>
                      {assistantProfile?.profileId === option.id && (
                        <Check
                          className="h-4 w-4 shrink-0 text-accent-assistant-profile-500"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                    );
                  })}
                  {assistantProfileOptions.length === 0 && (
                    <p
                      data-testid="assistant-options-empty"
                      className="px-3 py-2 text-xs text-zinc-500"
                    >
                      {t("chat.toolsAssistantEmpty")}
                    </p>
                  )}
                  {/*
                    The two ways out of this list. With nothing published the
                    empty state used to be a sentence telling the user a
                    profile could be made "in settings", which left them to
                    work out where -- so creating is a link here, and it is the
                    primary control when the list is empty.

                    Rendered inside `menuView === "assistant"`, which a guest
                    never reaches (the row that opens it is not rendered for
                    them) and which is absent entirely when the flag is off,
                    because `assistantProfileOptions` is only supplied once the
                    profiles API has answered.
                  */}
                  <div className="mt-1 flex flex-col gap-1 border-t border-zinc-200 pt-2 dark:border-zinc-800">
                    <Link
                      href={assistantProfileCreateHref({ fromChat: true })}
                      data-testid="assistant-create-cta"
                      onClick={() => closeMenu(false)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-assistant-profile-500 ${
                        isMobileShell ? "min-h-11 py-2.5" : "py-2.5"
                      } ${
                        assistantProfileOptions.length === 0
                          ? "bg-accent-assistant-profile-500/10 hover:bg-accent-assistant-profile-500/20"
                          : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-assistant-profile-500/10 text-accent-assistant-profile-500">
                        <Plus className="h-5 w-5" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {t("chat.toolsAssistantCreate")}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {t("chat.toolsAssistantCreateDescription")}
                        </span>
                      </span>
                    </Link>
                    {/*
                      Straight to the settings tab that manages them, not to
                      the standalone page: the tab is the management home now,
                      and it keeps the visitor inside the surface they were
                      already in.
                    */}
                    <Link
                      href={settingsSectionHref("assistants")}
                      data-testid="assistant-manage-cta"
                      onClick={() => closeMenu(false)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 text-left transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-assistant-profile-500 dark:hover:bg-zinc-800 ${
                        isMobileShell ? "min-h-11 py-2.5" : "py-2.5"
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        <Settings2 className="h-5 w-5" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {t("chat.toolsAssistantManage")}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {t("chat.toolsAssistantManageDescription")}
                        </span>
                      </span>
                    </Link>
                  </div>
                  </div>
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
                          <p className="text-[11px] font-bold text-zinc-900 dark:text-white">
                            {t("modelFinder.complementaryTitle")}
                          </p>
                          <p className="mt-0.5 text-[11px] leading-4 text-zinc-600 dark:text-zinc-300">
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
                              className={`inline-flex items-center justify-center rounded-lg bg-amber-600 px-2.5 text-xs font-bold text-white hover:bg-amber-500 ${isMobileShell ? "min-h-11" : "py-1.5"}`}
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
                              className={`inline-flex items-center justify-center rounded-lg border border-amber-300 bg-white px-2.5 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-zinc-950 dark:text-amber-200 ${isMobileShell ? "min-h-11" : "py-1.5"}`}
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
                          className={`inline-flex items-center justify-center gap-1.5 self-start rounded-full border border-blue-200 bg-blue-50 px-3 text-[11px] font-bold text-blue-700 transition hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200 dark:hover:bg-blue-950 ${isMobileShell ? "min-h-11" : "py-1.5"}`}
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
                        isKeyboardCompact={compactSheetKeyboardInset > 0}
                        modelStatuses={liveModelStatuses}
                        hasImageAttachments={hasImageAttachments}
                        favoriteModelIds={favoriteModelIds}
                        recentModelIds={recentModelIds}
                        personalizedModelIds={personalizedRecommendationIds}
                        selectedBaseCredits={selectedBaseCredits}
                        searchInputRef={modelSearchInputRef}
                        escapeHandlerRef={modelPickerEscapeRef}
                        onToggleModel={onToggleModel}
                        onRequestSwap={requestModelSwap}
                        onToggleFavorite={toggleFavoriteModel}
                        onRememberRecentModel={rememberRecentModel}
                        onBackToActions={() => setMenuView("actions")}
                        onDone={() => closeMenu(true, "done")}
                        onTrackEvent={trackModelPickerEvent}
                        comboFinderSlot={comboFinderSlot}
                        onSelectImageModel={
                          onStartImageDraft
                            ? (modelId) => {
                                closeMenu(false);
                                onStartImageDraft(value, modelId);
                              }
                            : undefined
                        }
                        autoSelectionOffered={
                          // Both halves, because either alone would be a
                          // control that cannot act: no handler means nothing
                          // to save to.
                          autoSelectionOffered && Boolean(onSelectionModeChange)
                        }
                        selectionMode={selectionMode}
                        selectionModePending={selectionModePending}
                        onSelectionModeChange={onSelectionModeChange}
                        imageGenerationLock={imageGenerationLock}
                        onLockedImageGenerationClick={(lock) => {
                          closeMenu(false);
                          onLockedImageGenerationClick?.(lock);
                        }}
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
                  className="fixed inset-0 z-[140] flex items-end justify-center bg-black/50 p-3 md:items-center"
                  onClick={closeReplaceModelDialog}
                >
                  <div
                    ref={replaceModelDialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-label={t("chat.swapModelTitle").replace("{model}", candidate.name)}
                    data-testid="replace-model-dialog"
                    className="max-h-full w-full max-w-sm overflow-y-auto overscroll-contain rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] dark:bg-zinc-900 md:rounded-3xl"
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
                              closeReplaceModelDialog();
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
                      ref={replaceModelCancelRef}
                      type="button"
                      onClick={closeReplaceModelDialog}
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
          accept={acceptedFileTypes}
          onChange={(event) => handleFilesSelected(event.target.files)}
          className="hidden"
        />

      </div>
      {!hideDisclaimer && (
        <p
          data-testid="chat-ai-disclaimer"
          // UI-CONTRAST-001. Aligned with AiDisclaimerNotice's mobile copy of
          // the same supporting-text role, which already measures above AA.
          // The previous zinc-400/zinc-500 pair composited to 2.62:1 on the
          // light composer surface and 3.67:1 on the dark one -- both below
          // the 4.5:1 this 11-12px, 400-weight body text requires.
          className="mt-1.5 px-2 text-center text-[11px] leading-4 text-zinc-600 dark:text-zinc-300 md:text-xs"
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
