"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Boxes,
  Braces,
  ChevronDown,
  File as FileIcon,
  FileText,
  HardDrive,
  Paperclip,
  Plus,
  Presentation,
  Search,
  Sheet,
  Square,
  Star,
  X,
} from "lucide-react";
import {
  AVAILABLE_MODELS,
  MAX_SELECTED_MODELS,
  getModelUsageProfile,
  type ChatAttachment,
} from "@/components/chat/types";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { useLanguage } from "@/components/LanguageProvider";
import { dispatchAppToast } from "@/lib/appToast";
import { getModelBestFor, getModelExperienceStatus, getModelExperienceTags } from "@/lib/modelExperience";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { useUserUsage } from "@/components/chat/useUserUsage";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";

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
const PROVIDER_DISPLAY_ORDER = ["openai", "google", "anthropic", "deepseek", "mistral"];
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

const PROMPT_SUGGESTIONS = [
  "chat.promptSummarizeDocument",
  "chat.promptCompareModels",
  "chat.promptReviewCode",
  "chat.promptDraftEmail",
  "chat.promptAnalyzeImage",
];

const getProviderSortRank = (provider: string) => {
  const priorityIndex = PROVIDER_DISPLAY_ORDER.indexOf(provider);
  return priorityIndex === -1 ? PROVIDER_DISPLAY_ORDER.length : priorityIndex;
};

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
  onSubmit: () => void;
  onCancel: () => void;
  disabled?: boolean;
  isSending?: boolean;
  focusToken?: number;
  selectedModels: string[];
  isGuestLimitReached?: boolean;
  onToggleModel: (modelId: string) => void;
  attachments: ChatAttachment[];
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  canAttach?: boolean;
  isGuestMode?: boolean;
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
  onSubmit,
  onCancel,
  disabled = false,
  isSending = false,
  focusToken,
  selectedModels,
  isGuestLimitReached = false,
  onToggleModel,
  attachments,
  onAttachmentsChange,
  canAttach: canAttachProp = true,
  isGuestMode = false,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previousAttachmentsRef = useRef<ChatAttachment[]>([]);
  const hasHandledFocusTokenRef = useRef(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
    const { t, lang } = useLanguage();
    const signInCallbackUrl = withChatLanguage("/chat", lang);
    const accountUsage = useUserUsage(!isGuestMode);
    const canAttach =
      canAttachProp &&
      !isGuestMode &&
      accountUsage?.limits.allowAttachments !== false;
    const maxSelectableModels = isGuestMode
      ? APP_DEFAULTS.maxGuestSelectedModels
      : accountUsage?.limits.maxModels || MAX_SELECTED_MODELS;

  const activeModelNames = selectedModels
    .map(id => AVAILABLE_MODELS.find(m => m.id === id)?.name)
    .filter(Boolean);

  const dailyCreditLimit = accountUsage?.limits.creditsDay || 0;
  const monthlyCreditLimit = accountUsage?.limits.creditsMonth || 0;
  const isAccountDailyLimitReached =
    !isGuestMode &&
    dailyCreditLimit > 0 &&
    (accountUsage?.usage.creditsDay || 0) >= dailyCreditLimit;
  const isAccountMonthlyLimitReached =
    !isGuestMode &&
    monthlyCreditLimit > 0 &&
    (accountUsage?.usage.creditsMonth || 0) >= monthlyCreditLimit;
  const isUsageLimitReached =
    isGuestLimitReached || isAccountDailyLimitReached || isAccountMonthlyLimitReached;

  const placeholderText = isUsageLimitReached
    ? t("chat.exceedDailyLimit")
    : t("chat.inputPlaceholder");
  
  const isDisabled = disabled || isSending || isUploading || isUsageLimitReached;
  
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"actions" | "models">("actions");
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [usageClassFilter, setUsageClassFilter] = useState("all");
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
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  const actionMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const modelMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const modelSearchInputRef = useRef<HTMLInputElement | null>(null);
  const lastMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

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

  const closeMenu = useCallback((restoreFocus = true) => {
    setIsMenuOpen(false);
    setMenuView("actions");

    if (restoreFocus) {
      requestAnimationFrame(() => {
        lastMenuTriggerRef.current?.focus();
      });
    }
  }, [setMenuView]);

  const modelProviders = useMemo(
    () =>
      Array.from(new Set(AVAILABLE_MODELS.map((model) => model.provider))).sort(
        (a, b) =>
          getProviderSortRank(a) - getProviderSortRank(b) ||
          a.localeCompare(b)
      ),
    []
  );

  const filteredModels = useMemo(() => {
    const normalizedQuery = modelSearchQuery.trim().toLowerCase();

    return AVAILABLE_MODELS.filter((model) => {
      const usageCategory = getModelUsageProfile(model).category;
      const matchesQuery =
        !normalizedQuery ||
        model.name.toLowerCase().includes(normalizedQuery) ||
        model.provider.toLowerCase().includes(normalizedQuery) ||
        usageCategory.toLowerCase().includes(normalizedQuery);
      const matchesProvider =
        providerFilter === "all" || model.provider === providerFilter;
      const matchesUsageClass =
        usageClassFilter === "all" || usageCategory === usageClassFilter;

      return matchesQuery && matchesProvider && matchesUsageClass;
    });
  }, [modelSearchQuery, providerFilter, usageClassFilter]);

  const groupedModels = useMemo(() => {
    const favoriteSet = new Set(favoriteModelIds);
    const recentSet = new Set(recentModelIds);
    const sortedModels = [...filteredModels].sort((a, b) => {
      const favoriteDelta =
        Number(favoriteSet.has(b.id)) - Number(favoriteSet.has(a.id));
      if (favoriteDelta !== 0) return favoriteDelta;
      const recentDelta = Number(recentSet.has(b.id)) - Number(recentSet.has(a.id));
      if (recentDelta !== 0) return recentDelta;
      const providerDelta =
        getProviderSortRank(a.provider) - getProviderSortRank(b.provider);
      if (providerDelta !== 0) return providerDelta;
      return a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name);
    });

    return sortedModels.reduce<Array<{ provider: string; models: typeof filteredModels }>>(
      (groups, model) => {
        const provider = favoriteSet.has(model.id)
          ? t("chat.favoriteModels")
          : recentSet.has(model.id)
            ? t("chat.recentModels")
          : model.provider;
        const group = groups.find((item) => item.provider === provider);
        if (group) group.models.push(model);
        else groups.push({ provider, models: [model] });
        return groups;
      },
      []
    );
  }, [favoriteModelIds, filteredModels, recentModelIds, t]);

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
            (record.status === "available" ||
              record.status === "limited" ||
              record.status === "unavailable")
          ) {
            const isUnavailable = record.status === "unavailable";
            next[record.id] = {
              status: isUnavailable ? "unavailable" : "available",
              fallbackModelIds: isUnavailable && Array.isArray(record.fallbackModelIds)
                ? record.fallbackModelIds.filter((id): id is string => typeof id === "string").slice(0, 3)
                : [],
            };
          }
        }
        setLiveModelStatuses(next);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const rememberRecentModel = (modelId: string) => {
    setRecentModelIds((current) => {
      const next = [modelId, ...current.filter((id) => id !== modelId)].slice(0, 6);
      localStorage.setItem(RECENT_MODEL_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        closeMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeMenu]);

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
  }, [closeMenu, getMenuFocusableElements, isMenuOpen]);

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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isDisabled) {
        onSubmit();
      }
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

        if (pastedFiles.length === 0) return;

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

  return (
      <div className="w-full max-w-full shrink-0 overflow-hidden border-t border-zinc-200 bg-zinc-50/95 px-2 py-1 pb-[calc(0.3rem+env(safe-area-inset-bottom))] transition-colors dark:border-zinc-800 dark:bg-zinc-950 md:overflow-visible md:px-6 md:py-3 md:pb-3">
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
          {isUsageLimitReached && (
            <div className="mb-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <span className="font-black">
                  {isGuestMode ? t("chat.guestLimitReachedTitle") : t("chat.accountLimitReachedTitle")}
                </span>
                <a
                  href={isGuestMode ? `/auth/signin?callbackUrl=${encodeURIComponent(signInCallbackUrl)}` : "/pricing"}
                  className="font-black text-amber-900 underline underline-offset-2 dark:text-amber-100"
                >
                  {isGuestMode ? t("auth.signIn") : t("billing.joinWaitlist")}
                </a>
              </div>
              <p className="mt-1 leading-5 opacity-90">
                {isGuestMode
                  ? t("chat.guestLimitReachedBody")
                  : isAccountMonthlyLimitReached
                    ? t("chat.monthlyLimitReachedBody")
                    : t("chat.dailyLimitReachedBody")}
              </p>
            </div>
          )}
          {!value.trim() && attachments.length === 0 && (
            <div className="mb-2 hidden max-w-full gap-2 overflow-x-auto overscroll-x-contain pb-1 md:flex md:flex-wrap md:overflow-visible md:pb-0">
              {PROMPT_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onChange(t(suggestion))}
                  className="shrink-0 touch-manipulation rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {t(suggestion)}
                </button>
              ))}
            </div>
          )}
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
                    className={
                      attachment.data
                        ? "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-950/80 text-white hover:bg-zinc-950"
                        : "absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-700 dark:hover:text-white"
                    }
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
          <div className="flex max-w-full flex-wrap items-center gap-2">
        <div className="relative order-1 flex min-w-0 max-w-full flex-1 items-center gap-2 md:order-none md:flex-none" ref={menuRef}>
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
            }}
            className="flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-full border border-zinc-300 bg-zinc-50 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
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
            }}
            className="flex h-10 min-w-0 max-w-full flex-1 touch-manipulation items-center gap-2 rounded-full border border-zinc-300 bg-zinc-50 px-3 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800 md:max-w-none md:flex-none"
            title={activeModelNames.join(", ")}
            aria-label={t("chat.modelSelect")}
            aria-expanded={isMenuOpen && menuView === "models"}
            aria-controls="chat-input-popover"
            aria-haspopup="dialog"
          >
            <span className="flex -space-x-1">
              {selectedModels.slice(0, 3).map((id) => {
                const model = AVAILABLE_MODELS.find((item) => item.id === id);
                return model ? (
                  <ModelLogo key={id} model={model} size="xs" />
                ) : null;
              })}
            </span>
            <span className="min-w-0 truncate whitespace-nowrap">
              {selectedModels.length} {t("chat.modelsSelected")}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
          </button>

          {isMenuOpen && (
            <>
            <button
              type="button"
              className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] md:hidden"
              onClick={() => closeMenu(true)}
              aria-label={t("auth.cancel")}
            />
            <div
              ref={menuPopoverRef}
              id="chat-input-popover"
              role="dialog"
              aria-modal="false"
              aria-label={menuView === "models" ? t("chat.modelSelect") : t("chat.moreActions")}
              tabIndex={-1}
              className="fixed inset-x-2 bottom-[calc(9rem+env(safe-area-inset-bottom))] z-50 flex max-h-[min(34rem,calc(100dvh-10.5rem))] max-w-[calc(100%_-_1rem)] flex-col overflow-hidden rounded-3xl border border-zinc-200 bg-white p-2 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 md:absolute md:inset-x-auto md:bottom-12 md:left-0 md:max-h-[calc(100dvh-8rem)] md:w-80 md:max-w-[calc(100vw_-_2rem)] md:rounded-2xl"
            >
              <div className="mx-auto mb-2 mt-0.5 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
              <div className="mb-2 flex items-center justify-between border-b border-zinc-200 px-2 pb-2 pt-1 dark:border-zinc-800 md:hidden">
                <div>
                  <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    {menuView === "models" ? t("chat.modelSelect") : t("chat.moreActions")}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {menuView === "models"
                      ? `${selectedModels.length}/${maxSelectableModels} ${t("chat.modelsSelected")}`
                      : t("chat.uploadFromComputer")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => closeMenu(true)}
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
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
                    onClick={() => setMenuView("models")}
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
              ) : (
                <>
                  <div className="mb-2 flex items-center gap-2 px-1 py-1">
                    <button
                      type="button"
                      onClick={() => setMenuView("actions")}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"
                      aria-label={t("auth.cancel")}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("chat.modelSelect")}</span>
                      <span className="block text-xs text-zinc-500">
                        {selectedModels.length}/{maxSelectableModels} {t("chat.modelsSelected")}
                      </span>
                    </div>
                  </div>
                  <div className="mb-2 space-y-2 px-1">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      <input
                        ref={modelSearchInputRef}
                        value={modelSearchQuery}
                        onChange={(event) => setModelSearchQuery(event.target.value)}
                        placeholder={t("chat.searchModels")}
                        className="h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 pl-9 pr-3 text-xs text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-blue-500"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={providerFilter}
                        onChange={(event) => setProviderFilter(event.target.value)}
                        className="h-9 rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-xs font-medium text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                      >
                        <option value="all">{t("chat.allProviders")}</option>
                        {modelProviders.map((provider) => (
                          <option key={provider} value={provider}>
                            {provider}
                          </option>
                        ))}
                      </select>
                      <select
                        value={usageClassFilter}
                        onChange={(event) => setUsageClassFilter(event.target.value)}
                        className="h-9 rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-xs font-medium text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                      >
                        <option value="all">{t("chat.allTiers")}</option>
                        <option value="Standard">{t("modelUsageClasses.standard")}</option>
                        <option value="Advanced">{t("modelUsageClasses.advanced")}</option>
                        <option value="Premium">{t("modelUsageClasses.premium")}</option>
                        <option value="Reasoning">{t("modelUsageClasses.reasoning")}</option>
                        <option value="Research">{t("modelUsageClasses.research")}</option>
                      </select>
                    </div>
                  </div>
                  <p className="px-2 text-[10px] leading-4 text-zinc-400">
                    {t("usage.creditWeightNotice")}
                  </p>
                  <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain pr-1">
                    {groupedModels.map((group) => (
                      <div key={group.provider} className="space-y-1">
                        <div className="px-2 text-[10px] font-bold uppercase tracking-wide text-zinc-400">
                          {group.provider}
                        </div>
                        {group.models.map((model) => {
                          const isSelected = selectedModels.includes(model.id);
                          const isFavorite = favoriteModelIds.includes(model.id);
                          const modelTags = getModelExperienceTags(model);
                          const liveStatus = liveModelStatuses[model.id];
                          const modelStatus = liveStatus?.status || getModelExperienceStatus(model);
                          const fallbackModels = (liveStatus?.fallbackModelIds || [])
                            .map((id) => AVAILABLE_MODELS.find((item) => item.id === id))
                            .filter((item): item is (typeof AVAILABLE_MODELS)[number] => Boolean(item))
                            .filter((item) => item.enabled && item.id !== model.id)
                            .slice(0, 2);
                          const isTierLocked =
                            isGuestMode
                              ? model.tier !== "Free"
                              : accountUsage?.plan === "Free" && model.tier === "Max";
                          const unavailable = !model.enabled || modelStatus === "unavailable" || isTierLocked;
                          const usageProfile = getModelUsageProfile(model);
                          const statusReason = isTierLocked
                            ? isGuestMode
                              ? t("modelStatusReasons.loginRequired")
                              : t("modelStatusReasons.upgradeRequired")
                            : !model.enabled || modelStatus === "unavailable"
                              ? t("modelStatusReasons.unavailable")
                              : model.status !== "enabled" || modelStatus === "limited"
                                ? t("modelStatusReasons.limited")
                                : t(getModelBestFor(model));
                          return (
                            <div
                              key={model.id}
                              className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            >
                              <button
                                type="button"
                                onClick={() => toggleFavoriteModel(model.id)}
                                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${isFavorite ? "text-amber-400" : "text-zinc-400 hover:text-amber-400"}`}
                                aria-pressed={isFavorite}
                                aria-label={t("chat.favoriteModels")}
                              >
                                <Star className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
                              </button>
                              <button
                                type="button"
                                data-testid="model-option"
                                data-model-id={model.id}
                                disabled={unavailable}
                                onClick={() => {
                                  rememberRecentModel(model.id);
                                  onToggleModel(model.id);
                                }}
                                aria-pressed={isSelected}
                                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-sm disabled:cursor-not-allowed disabled:opacity-45"
                              >
                                <ModelLogo model={model} size="md" />
                                <span className="min-w-0 flex-1 text-left">
                                  <span className="flex min-w-0 items-center gap-1.5">
                                    <span className="truncate text-zinc-800 dark:text-zinc-100">{model.name}</span>
                                    <span
                                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                        modelStatus === "available"
                                          ? "bg-emerald-500"
                                          : modelStatus === "limited"
                                            ? "bg-amber-500"
                                            : "bg-zinc-400"
                                      }`}
                                      title={modelStatus}
                                    />
                                  </span>
                                  <span className="block truncate text-[10px] font-medium text-zinc-400">
                                    {model.provider} - {unavailable ? t("chat.unavailableModel") : t("chat.availableModel")}
                                  </span>
                                  <span className="block truncate text-[10px] text-zinc-500 dark:text-zinc-400">
                                    {statusReason}
                                  </span>
                                  <span className="mt-1 flex max-w-full flex-wrap gap-1">
                                    {modelTags.map((tag) => (
                                      <span
                                        key={tag}
                                        className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9px] font-bold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300"
                                      >
                                        {t(`modelTags.${tag}`)}
                                      </span>
                                    ))}
                                  </span>
                                  <span className="sr-only">{t(getModelBestFor(model))}</span>
                                  {(modelStatus === "limited" || modelStatus === "unavailable") && fallbackModels.length > 0 && (
                                    <span className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-zinc-500">
                                      <span>{t("chat.trySimilarModel")}</span>
                                      {fallbackModels.map((fallback) => (
                                        <span
                                          key={fallback.id}
                                          className="rounded-full bg-blue-500/10 px-1.5 py-0.5 font-bold text-blue-500"
                                        >
                                          {fallback.name}
                                        </span>
                                      ))}
                                    </span>
                                  )}
                                </span>
                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${usageProfile.category === "Standard" ? "bg-emerald-500/10 text-emerald-500" : usageProfile.category === "Advanced" ? "bg-blue-500/10 text-blue-500" : usageProfile.category === "Premium" ? "bg-purple-500/10 text-purple-500" : usageProfile.category === "Reasoning" ? "bg-amber-500/10 text-amber-500" : "bg-cyan-500/10 text-cyan-500"}`}>
                                  {t(`modelUsageClasses.${usageProfile.category.toLowerCase()}`)} · {usageProfile.credits}
                                </span>
                                <span className={`h-4 w-8 rounded-full p-0.5 transition-colors ${isSelected ? "bg-blue-500" : "bg-zinc-300 dark:bg-zinc-700"}`}>
                                  <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${isSelected ? "translate-x-4" : ""}`} />
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                    {filteredModels.length === 0 && (
                      <div className="rounded-xl border border-dashed border-zinc-200 px-4 py-8 text-center text-xs text-zinc-400 dark:border-zinc-700">
                        {t("chat.noModelsFound")}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            </>
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

        <textarea
          data-testid="chat-textarea"
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label={placeholderText}
          placeholder={placeholderText}
          disabled={isDisabled}
          rows={1}
                  className="order-2 max-h-[96px] min-h-[44px] w-full flex-none resize-none overflow-y-auto border-0 bg-transparent px-1 py-1.5 text-[13px] leading-5 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:text-zinc-100 dark:placeholder:text-zinc-500 md:order-first md:max-h-[160px] md:min-h-[56px] md:py-2 md:text-sm md:leading-6"
              />

        {isSending ? (
          <button
            type="button"
            onClick={onCancel}
            className="order-3 ml-auto flex h-9 w-9 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-500 md:h-9 md:w-9"
            title={t("chat.cancel")}
            aria-label={t("chat.cancel")}
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={isDisabled || (!value.trim() && attachments.length === 0)}
            className="order-3 ml-auto flex h-9 w-9 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400 md:h-9 md:w-9"
            title={t("chat.send")}
            aria-label={t("chat.send")}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
		
      </div>
      </div>
    </div>
  );
}
