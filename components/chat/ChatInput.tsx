"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  X,
} from "lucide-react";
import { AVAILABLE_MODELS, MAX_SELECTED_MODELS, type ChatAttachment } from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_WORKSPACE_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
].join(",");
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
  canAttach = true,
  isGuestMode = false,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previousAttachmentsRef = useRef<ChatAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
    const { t } = useLanguage(); // 💡 t 함수 꺼내기

  // 💡 선택된 모델의 이름들을 가져와서 플레이스홀더 문구를 동적으로 만듭니다.
  const activeModelNames = selectedModels
    .map(id => AVAILABLE_MODELS.find(m => m.id === id)?.name)
    .filter(Boolean);

    let placeholderText = t("chat.inputPlaceholder");
  if (isGuestLimitReached) {
      placeholderText = t("chat.exceedDailyLimit");
  } else if (activeModelNames.length === 1) {
      placeholderText = `[${activeModelNames[0]}]` + t("chat.sendSingMessage");
  } else if (activeModelNames.length > 1) {
      placeholderText = `[${activeModelNames.join(", ")}]` + t("chat.sendMultipleMessages");
  }
  
  // 💡 최종 비활성화 조건 계산
  const isDisabled = disabled || isSending || isUploading || isGuestLimitReached;
  
  // 팝업 메뉴 열림/닫힘 상태
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"actions" | "models">("actions");
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [tierFilter, setTierFilter] = useState("all");
  const menuRef = useRef<HTMLDivElement>(null);

  const modelProviders = useMemo(
    () => Array.from(new Set(AVAILABLE_MODELS.map((model) => model.provider))),
    []
  );

  const filteredModels = useMemo(() => {
    const normalizedQuery = modelSearchQuery.trim().toLowerCase();

    return AVAILABLE_MODELS.filter((model) => {
      const matchesQuery =
        !normalizedQuery ||
        model.name.toLowerCase().includes(normalizedQuery) ||
        model.provider.toLowerCase().includes(normalizedQuery) ||
        model.tier.toLowerCase().includes(normalizedQuery);
      const matchesProvider =
        providerFilter === "all" || model.provider === providerFilter;
      const matchesTier = tierFilter === "all" || model.tier === tierFilter;

      return matchesQuery && matchesProvider && matchesTier;
    });
  }, [modelSearchQuery, providerFilter, tierFilter]);

// 화면 바깥 클릭 시 팝업 닫기
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
        setMenuView("actions");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    if (focusToken === undefined) return;

    const id = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });

    return () => cancelAnimationFrame(id);
  }, [focusToken]);

  useEffect(() => {
    const currentIds = new Set(attachments.map((attachment) => attachment.id));

    previousAttachmentsRef.current.forEach((attachment) => {
      if (!currentIds.has(attachment.id) && attachment.data) {
        URL.revokeObjectURL(attachment.data);
      }
    });

    previousAttachmentsRef.current = attachments;
  }, [attachments]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // isDisabled로 검사하도록 변경
      if (!isDisabled) {
        onSubmit();
      }
    }
  };

  const handleFilesSelected = async (files: FileList | File[] | null) => {
    if (!files?.length) return;

    const availableSlots = MAX_ATTACHMENTS - attachments.length;
    if (availableSlots <= 0) {
      alert(t("chat.attachmentCountError"));
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
          alert(t("chat.attachmentTypeError"));
          continue;
        }
        if (file.size > MAX_ATTACHMENT_SIZE) {
          alert(t("chat.attachmentSizeError"));
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
            ? URL.createObjectURL(file)
            : undefined,
          kind: TEXT_FILE_TYPES.has(mediaType) ? "text" : "file",
        });
      }

      onAttachmentsChange([...attachments, ...nextAttachments]);
    } catch (error) {
      console.error("Attachment upload failed:", error);
      alert(t("chat.attachmentUploadError"));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

    const handlePaste = (
        event: React.ClipboardEvent<HTMLTextAreaElement>
    ) => {
        const pastedFiles = Array.from(event.clipboardData.files);

        if (pastedFiles.length === 0) return;

        event.preventDefault();

        if (!canAttach) {
            alert(t("chat.loginToAttach"));
            return;
        }

        void handleFilesSelected(pastedFiles);
    };

  const handleGoogleDriveSelect = async () => {
    if (!canAttach || isUploading) return;

    const availableSlots = MAX_ATTACHMENTS - attachments.length;
    if (availableSlots <= 0) {
      alert(t("chat.attachmentCountError"));
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
      alert(t("chat.googleDriveError"));
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
      <div className="shrink-0 border-t border-zinc-200 bg-zinc-50/95 px-3 py-3 transition-colors dark:border-zinc-800 dark:bg-zinc-950 md:px-6">
          <div className="mx-auto max-w-4xl rounded-2xl border border-zinc-200 bg-white p-3 shadow-lg shadow-zinc-200/50 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/20">
          {attachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className={
                    attachment.data
                      ? "relative h-20 w-20 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
                      : "relative flex h-16 min-w-52 max-w-64 items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 py-2 pl-2 pr-8 text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
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
          )}
          <div className="flex flex-wrap items-end gap-2">
        <div className="relative flex items-center gap-2" ref={menuRef}>
          <button
            type="button"
            onClick={() => {
              setMenuView("actions");
              setIsMenuOpen((open) => !open || menuView !== "actions");
            }}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-zinc-300 bg-zinc-50 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
            title={t("chat.moreActions")}
            aria-label={t("chat.moreActions")}
            aria-expanded={isMenuOpen && menuView === "actions"}
          >
            {isUploading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Plus className="h-5 w-5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              const shouldClose = isMenuOpen && menuView === "models";
              setMenuView("models");
              setIsMenuOpen(!shouldClose);
            }}
            className="flex h-10 min-w-0 items-center gap-2 rounded-full border border-zinc-300 bg-zinc-50 px-3 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800"
            title={activeModelNames.join(", ")}
          >
            <span className="flex -space-x-1">
              {selectedModels.slice(0, 3).map((id) => {
                const model = AVAILABLE_MODELS.find((item) => item.id === id);
                return model ? (
                  <span
                    key={id}
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs ring-1 ring-zinc-200 dark:bg-zinc-950 dark:ring-zinc-700"
                  >
                    {model.icon}
                  </span>
                ) : null;
              })}
            </span>
            <span className="whitespace-nowrap">
              {selectedModels.length} {t("chat.modelsSelected")}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
          </button>

          {isMenuOpen && (
            <div className="absolute bottom-12 left-0 z-50 flex max-h-[calc(100dvh-8rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white p-2 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
              {menuView === "actions" ? (
                <div className="space-y-1">
                  <button
                    type="button"
                    disabled={!canAttach || attachments.length >= MAX_ATTACHMENTS}
                    onClick={() => {
                      setIsMenuOpen(false);
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
                      setIsMenuOpen(false);
                      void handleGoogleDriveSelect();
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
                      <HardDrive className="h-5 w-5" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Google Drive</span>
                      <span className="text-xs text-zinc-500">Docs, Sheets, Slides</span>
                    </span>
                  </button>
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
                      <span className="text-xs text-zinc-500">{t("chat.maxModelsDescription")}</span>
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
                        {selectedModels.length}/{MAX_SELECTED_MODELS} {t("chat.modelsSelected")}
                      </span>
                    </div>
                  </div>
                  <div className="mb-2 space-y-2 px-1">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      <input
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
                        value={tierFilter}
                        onChange={(event) => setTierFilter(event.target.value)}
                        className="h-9 rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-xs font-medium text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                      >
                        <option value="all">{t("chat.allTiers")}</option>
                        <option value="Free">Free</option>
                        <option value="Pro">Pro</option>
                        <option value="Max">Max</option>
                      </select>
                    </div>
                  </div>
                  <div className="min-h-0 space-y-1 overflow-y-auto overscroll-contain pr-1">
                    {filteredModels.map((model) => {
                      const isSelected = selectedModels.includes(model.id);
                      const isTierLocked =
                        isGuestMode && model.tier !== "Free";
                      return (
                        <button
                          key={model.id}
                          type="button"
                          disabled={!model.enabled || isTierLocked}
                          onClick={() => onToggleModel(model.id)}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-zinc-800"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">{model.icon}</span>
                          <span className="min-w-0 flex-1 text-left">
                            <span className="block truncate text-zinc-800 dark:text-zinc-100">{model.name}</span>
                            <span className="block truncate text-[10px] font-medium text-zinc-400">{model.provider}</span>
                          </span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${model.tier === "Free" ? "bg-emerald-500/10 text-emerald-500" : model.tier === "Pro" ? "bg-blue-500/10 text-blue-500" : "bg-purple-500/10 text-purple-500"}`}>{model.tier}</span>
                          {!model.enabled ? (
                            <span className="text-[10px] font-medium text-zinc-400">
                              {model.status}
                            </span>
                          ) : null}
                          <span className={`h-4 w-8 rounded-full p-0.5 transition-colors ${isSelected ? "bg-blue-500" : "bg-zinc-300 dark:bg-zinc-700"}`}>
                            <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${isSelected ? "translate-x-4" : ""}`} />
                          </span>
                        </button>
                      );
                    })}
                    {filteredModels.length === 0 && (
                      <div className="rounded-xl border border-dashed border-zinc-200 px-4 py-8 text-center text-xs text-zinc-400 dark:border-zinc-700">
                        {t("chat.noModelsFound")}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
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

		{/* 💡 텍스트 입력 영역 */}	  
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholderText}
          disabled={isDisabled}
          rows={1}
                  className="order-first max-h-[160px] min-h-[56px] w-full flex-none resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 text-sm leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />

        {isSending ? (
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-500"
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
            className="ml-auto flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
            title={t("chat.send")}
            aria-label={t("chat.send")}
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        )}
		
      </div>
      </div>
    </div>
  );
}
