"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { ChatApp } from "@/components/chat/ChatApp";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatInput } from "@/components/chat/ChatInput";
import { Conversation, AVAILABLE_MODELS, ENABLED_MODELS, MAX_SELECTED_MODELS, type ChatAttachment } from "@/components/chat/types";
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
import { isEnabledModelId } from "@/lib/models";
import {
  USER_SETTINGS_UPDATED_EVENT,
  type UserSettingsUpdatedDetail,
} from "@/lib/userSettingsEvents";
import {
  APP_TOAST_EVENT,
  type AppToastEventDetail,
  type AppToastTone,
} from "@/lib/appToast";

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
  value === "en" || value === "ko" || value === "zh";

const cloneAttachmentPreviews = async (
  items: ChatAttachment[]
): Promise<ChatAttachment[]> =>
  Promise.all(
    items.map(async (attachment) => {
      if (!attachment.data) return attachment;

      try {
        const blob = await fetch(attachment.data).then((response) =>
          response.blob()
        );
        return {
          ...attachment,
          data: URL.createObjectURL(blob),
        };
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
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
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

export default function Home() {
    const { t, setLang } = useLanguage();
  const [isConversationsLoaded, setIsConversationsLoaded] = useState(false);  
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const { data: session, status } = useSession();

  const isSending = false;
  const [focusToken, setFocusToken] = useState(0);

    const [userDefaultEngine, setUserDefaultEngine] = useState<string>(APP_DEFAULTS.defaultModelId);
  const [isUserSettingsLoaded, setIsUserSettingsLoaded] = useState(false);

  const [inputValue, setInputValue] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [promptPayload, setPromptPayload] = useState<{ id: string; text: string; chatId: string; userMessageId: string; attachments: ChatAttachment[] } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingRemoveModelId, setPendingRemoveModelId] = useState<string | null>(null);
  const [pendingRevokeShareId, setPendingRevokeShareId] = useState<string | null>(null);
  const [unlockDialog, setUnlockDialog] = useState<{ id: string; password: string; error: string } | null>(null);
  const [lockedSelectDialog, setLockedSelectDialog] = useState<{ id: string; password: string; error: string } | null>(null);
  const [toast, setToast] = useState<AppToast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const [selectedModels, setSelectedModels] = useState<string[]>([APP_DEFAULTS.defaultModelId]);
  
  const [disabledPanels, setDisabledPanels] = useState<string[]>([]);
  const modelSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelSyncAbortRef = useRef<AbortController | null>(null);

  const [isPrivateMode, setIsPrivateMode] = useState(false);

  const isGuestMode = status !== "loading" && !session?.user;
  const [guestMessageCount, setGuestMessageCount] = useState(0);
  const MAX_GUEST_MESSAGES = 20;

  const isInitialSelectedRef = useRef(false);

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

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

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
    if (isGuestMode) {
      let cancelled = false;
      queueMicrotask(() => {
      if (cancelled) return;
      setUserDefaultEngine(APP_DEFAULTS.guestDefaultModelId);
      setSelectedModels([APP_DEFAULTS.guestDefaultModelId]);
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
          console.error("ê²ŒìŠ¤íŠ¸ ëŒ€í™”ë°© íŒŒì‹± ì—ëŸ¬:", e);
        }
      } else {
        const initialChatId = `guest_${Date.now()}`;
        const initialChat = {
          id: initialChatId,
          title: "ìƒˆ ëŒ€í™” (ê²ŒìŠ¤íŠ¸)",
            selectedModels: [APP_DEFAULTS.guestDefaultModelId],
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
  }, [isGuestMode]);  

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
            isInitialSelectedRef.current
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

        const openInitialConversation = async () => {
            try {
                const res = await fetch(`/api/conversations/${firstConversation.id}`, {
                    cache: "no-store",
                });

                if (!res.ok || cancelled) return;

                const data = await res.json();
                applyConversationSettings(data);
                setCurrentChatId(firstConversation.id);
            } catch (error) {
                if (!cancelled) {
                    console.error("Failed to open initial conversation:", error);
                    applyConversationSettings(firstConversation);
                    setCurrentChatId(firstConversation.id);
                }
            }
        };

        openInitialConversation();

        return () => {
            cancelled = true;
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
    if (!session?.user) return;

    try {
	  const res = await fetch(`/api/conversations`, { cache: "no-store" });
      if (res.ok) setConversations(await res.json());
    } catch (error) {
      console.error("ëŒ€í™” ëª©ë¡ì„ ë¶ˆëŸ¬ì˜¤ëŠ” ì¤‘ ì˜¤ë¥˜ ë°œìƒ:", error);
    }
    }, [session?.user]);

    useEffect(() => {
        if (session?.user) {
            queueMicrotask(() => setIsUserSettingsLoaded(false));
            queueMicrotask(() => {
                void fetchConversations();
            });

            fetch("/api/user/settings")
                .then((res) => {
                    if (!res.ok) throw new Error(`Settings load failed: ${res.status}`);
                    return res.json();
                })
                .then((data) => {
                    if (data && isEnabledModelId(data.defaultModel)) {
                        setUserDefaultEngine(data.defaultModel);
                        if (!currentChatId) {
                            setSelectedModels([data.defaultModel]);
                        }
                    }

                    if (data && data.theme) {
                        if (data.theme === "light") {
                            document.documentElement.classList.remove("dark");
                        } else {
                            document.documentElement.classList.add("dark");
                        }
                    }

                    if (data && isLanguage(data.language)) {
                        setLang(data.language);
                    }
                })
                .catch((err) => {
                    console.error("ì‚¬ìš©ìž ì„ í˜¸ ì—”ì§„ ì¡°íšŒ ì‹¤íŒ¨:", err);
                    setUserDefaultEngine(APP_DEFAULTS.defaultModelId);
                    if (!currentChatId) {
                        setSelectedModels([APP_DEFAULTS.defaultModelId]);
                    }
                })
                .finally(() => setIsUserSettingsLoaded(true));
        } else if (status !== "loading") {
            queueMicrotask(() => setIsUserSettingsLoaded(true));
        }
    }, [currentChatId, fetchConversations, session?.user, setLang, status]);

    const handleNewChat = () => {
        setIsPrivateMode(false);
    if (isGuestMode) {
      const newGuestChat = {
        id: `guest_${Date.now()}`,
          title: t("sidebar.autoGeneratedNewRoom"),
          selectedModels: [APP_DEFAULTS.guestDefaultModelId],
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
              [APP_DEFAULTS.guestDefaultModelId]
            )
          );
          setSelectedModels(
            restoredModels.length
              ? restoredModels
              : [APP_DEFAULTS.guestDefaultModelId]
          );
          setDisabledPanels(
            normalizeStringArray(targetConv.disabledPanels, []).filter(
              (modelId) => restoredModels.includes(modelId)
            )
          );
        }
      return;
    }

    if (!session || !session.user) return;

	try {
	  const res = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
		console.log("âœ… [DB Load] ë¶ˆëŸ¬ì˜¨ ì„¤ì •:", data.selectedModels);

          applyConversationSettings(data);
	  }
    } catch (error) {
      console.error("ëŒ€í™”ë°© ì •ë³´ ë¡œë“œ ì‹¤íŒ¨:", error);
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
            console.error("ìž ê¸ˆ ì„¤ì • ì—ëŸ¬:", e);
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
            console.error("ìž ê¸ˆ í•´ì œ ì—ëŸ¬:", e);
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
        console.error("ì´ë¦„ ë³€ê²½ ì¤‘ ì˜¤ë¥˜:", error);
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
        console.error("ëŒ€í™”ë°© ì‚­ì œ ì—ëŸ¬:", error);
      }
    }
  };

  const handleDelete = async (id: string) => {
    setPendingDeleteId(id);
  };
  
  const syncModelSettingsToServer = (targetChatId: string, updatedModels: string[], updatedDisabled: string[]) => {
    if (!targetChatId || targetChatId === "private-chat") return;
    if (!session || !session.user) return;

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
          console.error("ëª¨ë¸ ì„¸íŒ… ë™ê¸°í™” ì‹¤íŒ¨:", error);
        }
      }
    }, 250);
  };  
  
  const handleGlobalSubmit = async () => {
    const trimmed = inputValue.trim();
    if ((!trimmed && attachments.length === 0) || selectedModels.length === 0) return;
    const promptAttachments = await cloneAttachmentPreviews(attachments);
	
    if (isGuestMode) {
      if (guestMessageCount >= MAX_GUEST_MESSAGES) {
          showToast(t("sidebar.exceedDailyLimit"), "error");
        return;
      }
      
      const newCount = guestMessageCount + 1;
      setGuestMessageCount(newCount);
      localStorage.setItem("guest_count", newCount.toString());
    }

    if (isPrivateMode) {
      setPromptPayload({ 
        id: Date.now().toString(), 
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
            title: (trimmed || attachments[0]?.name || t("chat.newChat")).slice(0, 30),
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
        console.error("ëŒ€í™”ë°© ìƒì„± ì¤‘ ì˜¤ë¥˜:", error);
        return;
      }
    }
    }
    
    if (activeChatId) {
	  const userMsgId = crypto.randomUUID();

      if (!isGuestMode) {
      try {
        await fetch(`/api/conversations/${activeChatId}/messages`, {
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
      } catch (e) {
        console.error("ìœ ì € ë©”ì‹œì§€ ì„ ì €ìž¥ ì—ëŸ¬:", e);
      }
    }

      setPromptPayload({ 
        id: Date.now().toString(), 
        text: trimmed, 
        chatId: activeChatId,
        userMessageId: userMsgId,
        attachments: promptAttachments,
      });
      setInputValue("");
      setAttachments([]);
    }
  };

  const togglePrivateModeGlobal = () => {
    if (isPrivateMode) {
      handleNewChat();
    } else {
      setIsPrivateMode(true);
      setCurrentChatId("private-chat");
    }
  };

  const toggleModel = (modelId: string) => {
    if (
      isGuestMode &&
      !clampGuestSelectedModels([modelId]).includes(modelId)
    ) {
      return;
    }
	let nextModels = [...selectedModels];
    let nextDisabled = [...disabledPanels];

	if (nextModels.includes(modelId)) {
      if (nextModels.length === 1) return; 
      nextModels = nextModels.filter((id) => id !== modelId);
      nextDisabled = nextDisabled.filter((id) => id !== modelId);
    } else {
        if (nextModels.length >= MAX_SELECTED_MODELS) {
            showToast(t("chat.maxModelCompare"), "info");
            return;
        }

        nextModels.push(modelId);
      }
    
    nextModels = clampSelectedModels(nextModels);
	setSelectedModels(nextModels);
    setDisabledPanels(nextDisabled);
    if (currentChatId && currentChatId !== "private-chat") {
      syncModelSettingsToServer(currentChatId, nextModels, nextDisabled);
    }
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
        console.error("ê¸°ë¡ ì‚­ì œ ì‹¤íŒ¨:", error);
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

  return (
    <>
      <main className="flex h-screen overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <ChatSidebar 
        conversations={blendedConversations}
        currentChatId={currentChatId}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
		    onRename={handleRename}
        onDelete={handleDelete}		
        isGuestMode={isGuestMode} 
        guestMessageCount={guestMessageCount} 
              maxGuestMessages={MAX_GUEST_MESSAGES}        
              onLock={handleLock}     
              onUnlock={handleUnlock} 
onShare={handleShareConversation}
              onRevokeShare={handleRevokeShare}
              onDownload={handleDownloadConversation}              
              isPrivateMode={isPrivateMode}
              onTogglePrivateMode={togglePrivateModeGlobal}
      />

      <section className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">        
              <div className="flex flex-1 min-h-0 overflow-hidden gap-4 bg-zinc-100/80 px-4 pb-4 pt-4 dark:bg-zinc-950">

          {selectedModels.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center text-zinc-500 select-none">
              <div className="text-4xl mb-4 opacity-50">ðŸ¤–</div>
                          <p className="text-sm font-medium">{t("chat.inactivePanel")}</p>
                          <p className="text-xs mt-1 opacity-70">{t("chat.chooseModel")}</p>
            </div>
          )}
		  
		{selectedModels.map((modelId) => {
            const modelInfo = AVAILABLE_MODELS.find(m => m.id === modelId);
			const isPanelDisabled = disabledPanels.includes(modelId);
            
			return (
                <React.Fragment key={modelId}>               
                <div className={`flex flex-col bg-white border border-zinc-200 dark:bg-zinc-950 dark:border-zinc-800 rounded-2xl overflow-hidden relative transition-all duration-300 ease-in-out shadow-sm shadow-zinc-200/60 dark:shadow-black/20 ${isPanelDisabled ? "w-44 shrink-0" : "flex-1 min-w-0"
                }`}>
                  {(
                      <div className="flex min-h-12 items-center justify-between shrink-0 border-b border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/70 dark:text-zinc-400">
                      <div className={`flex flex-1 min-w-0 items-center gap-2 transition-opacity ${isPanelDisabled ? 'opacity-50' : ''}`}>
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700">
                          {modelInfo?.icon}
                        </span>
                        
                        {isPanelDisabled ? (
                          <span className="min-w-0 flex flex-col truncate select-none">
                            <span className="truncate text-sm font-semibold text-zinc-600 dark:text-zinc-300">{modelInfo?.name}</span>
                            <span className="truncate text-[10px] font-medium text-zinc-400">{modelInfo?.provider}</span>
                          </span>
                        ) : (
                        <span className="min-w-0 flex flex-col">
                          <select
                            value={modelId}
                            onChange={(e) => changePanelModel(modelId, e.target.value)}
                            disabled={isPanelDisabled}
                            className="min-w-0 cursor-pointer truncate bg-transparent text-sm font-semibold text-zinc-800 outline-none hover:text-zinc-950 dark:text-zinc-100 dark:hover:text-white"
                          >
                            {ENABLED_MODELS.map((m) => {
                              const isAlreadyUsed = selectedModels.includes(m.id) && m.id !== modelId;
                              return (
                                <option 
                                  key={m.id} 
                                  value={m.id}
                                  disabled={isAlreadyUsed}
                                  className="bg-zinc-900 text-zinc-100"
                                >
                                      {m.name} {isAlreadyUsed ? t("chat.inUsed") : ""}
                                </option>
                              );
                            })}
                          </select>
                          <span className="truncate text-[10px] font-medium text-zinc-400">
                            {modelInfo?.provider} Â· {modelInfo?.tier}
                          </span>
                        </span>
						)}
                      </div>

					  <div className="flex items-center gap-2 shrink-0">

                    {selectedModels.length > 1 && (
                      <>                      
                      <button
                        onClick={() => togglePanelDisable(modelId)}
                        className="cursor-pointer flex items-center gap-2 rounded-full px-2 py-1 hover:bg-zinc-100 transition-colors dark:hover:bg-zinc-800"
                        title={isPanelDisabled ? t("chat.resumePanel") : t("chat.pausePanel")}
                        aria-pressed={!isPanelDisabled}
                      >
                        <span className="text-[10px] font-bold text-zinc-500">
                          {isPanelDisabled ? "OFF" : "ON"}
                        </span>
                        <div className={`h-4 w-8 rounded-full p-0.5 transition-colors ${!isPanelDisabled ? "bg-blue-500" : "bg-zinc-700"}`}>
                          <div className={`h-3 w-3 rounded-full bg-white transition-transform ${!isPanelDisabled ? "translate-x-4" : "translate-x-0"}`} />
                        </div>
                      </button>
					  
					  <div className="w-[1px] h-4 bg-zinc-200 dark:bg-zinc-700/50"></div>
                      
                      <button
                        onClick={() => handleRemoveModel(modelId)}
                        className="cursor-pointer flex items-center justify-center p-1.5 rounded-full text-zinc-500 hover:bg-red-500/10 hover:text-red-500 transition-colors"
                        title={t("chat.closeModelPanel")}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                      </button>	
					  </>
                    )}					  
                    </div>
					</div>
                  )}
                  
                  <ChatApp 
                    key={`${modelId}:${currentChatId || "new"}`}
				            modelId={modelId}
                    initialConversationId={currentChatId} 
                    promptPayload={promptPayload}
					          isPanelDisabled={isPanelDisabled}
                    isGuestMode={isGuestMode}
                  />
                </div>
              </React.Fragment>
            );
          })}
        </div>

        <ChatInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleGlobalSubmit}
          onCancel={() => {}} 
          isSending={isSending}
		      focusToken={focusToken}		  
          selectedModels={selectedModels}
          onToggleModel={toggleModel}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          canAttach={!isGuestMode}
          isGuestMode={isGuestMode}
          isGuestLimitReached={isGuestMode && guestMessageCount >= MAX_GUEST_MESSAGES}          
        />
      </section>
    </main>
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
