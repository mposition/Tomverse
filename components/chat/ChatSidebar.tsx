"use client";

import { Conversation } from "./types";
import { getModel } from "@/components/chat/types";
import { AuthButton } from "@/components/auth/AuthButton";
import { useCallback, useState, useEffect, useRef } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import Link from "next/link";
import { AlertTriangle, CloudUpload, Crown, Database, Download, Link2Off, Lock, MessageSquare, MoreVertical, Pencil, Pin, Search, Send, Share2, ShieldCheck, Sparkles, Star, Trash2, Unlock, X } from "lucide-react";
import { FeedbackButton } from "@/components/chat/FeedbackButton";
import { useUserUsage, type UserPlan } from "@/components/chat/useUserUsage";

type ChatSidebarProps = {
    conversations: Conversation[];
    currentChatId: string | null;
    isGuestMode?: boolean;
    guestMessageCount?: number;
    maxGuestMessages?: number;
    onNewChat: () => void;
    onSelectConversation: (id: string) => void;
    onRename: (id: string, title: string) => void;
    onDelete: (id: string) => void;
    onLock?: (id: string, password: string) => void;
    onUnlock?: (id: string) => void;
    onShare: (id: string, title: string) => void;
    onRevokeShare: (id: string) => void;
    onDownload: (id: string, title: string) => void;    
    isPrivateMode?: boolean;
    onTogglePrivateMode: () => void;
    currentModelId?: string | null;
};

export function ChatSidebar({
    conversations,
    currentChatId,
    isGuestMode,
    guestMessageCount,
    maxGuestMessages,
    onNewChat,
    onSelectConversation,
    onRename,
    onDelete,
    onLock,
    onUnlock,
    onShare,
    onRevokeShare,
    onDownload,    
    isPrivateMode = false,
    onTogglePrivateMode,
    currentModelId,
}: ChatSidebarProps) {
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [showPrivateNotice, setShowPrivateNotice] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [conversationFilter, setConversationFilter] = useState<"all" | "locked" | "shared">("all");
    const [pinnedConversationIds, setPinnedConversationIds] = useState<string[]>(() => {
        if (typeof window === "undefined") return [];
        try {
            const saved = JSON.parse(localStorage.getItem("tomverse_pinned_conversations") || "[]");
            return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
        } catch {
            return [];
        }
    });
    const [favoriteConversationIds, setFavoriteConversationIds] = useState<string[]>(() => {
        if (typeof window === "undefined") return [];
        try {
            const saved = JSON.parse(localStorage.getItem("tomverse_favorite_conversations") || "[]");
            return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
        } catch {
            return [];
        }
    });
    const [messageSearchResults, setMessageSearchResults] = useState<Array<{
        id: string;
        conversationId: string;
        conversationTitle: string;
        snippet: string;
    }>>([]);
    const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [lockTarget, setLockTarget] = useState<Conversation | null>(null);
    const [lockPassword, setLockPassword] = useState("");
    const [lockError, setLockError] = useState("");
    const privateModeButtonRef = useRef<HTMLButtonElement | null>(null);
    const privateNoticeDialogRef = useRef<HTMLDivElement | null>(null);
    const { t } = useLanguage();
    const accountUsage = useUserUsage(!isGuestMode);
    const displayedPlan: UserPlan | "Guest" | null = isGuestMode ? "Guest" : accountUsage?.plan || null;
    const displayedUsage = isGuestMode
        ? {
            used: guestMessageCount || 0,
            limit: maxGuestMessages || 20,
        }
        : {
            used: accountUsage?.usage.messagesDay || 0,
            limit: accountUsage?.limits.messagesDay || 0,
        };
    const displayedRemaining =
        displayedUsage.limit > 0
            ? Math.max(displayedUsage.limit - displayedUsage.used, 0)
            : 0;
    const displayedUsageWidth =
        displayedUsage.limit > 0
            ? `${Math.min((displayedUsage.used / displayedUsage.limit) * 100, 100)}%`
            : "0%";
    const isDailyUnlimited = !isGuestMode && displayedUsage.limit <= 0 && accountUsage?.plan === "Max";
    const planDescriptionKey =
        displayedPlan === null
            ? null
            : displayedPlan === "Guest"
            ? "sidebar.guestPlanDescription"
            : `sidebar.${displayedPlan.toLowerCase()}PlanDescription`;
    const menuItemBase =
        "flex w-full items-center justify-between whitespace-nowrap rounded px-3 py-2 text-sm transition-colors";

    const menuItemEnabled =
        "cursor-pointer text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100";

    const menuItemDisabled =
        "cursor-not-allowed bg-zinc-900/50 text-zinc-600";

    const menuIconClass = "h-3.5 w-3.5 shrink-0";
    const crownClass = "h-3.5 w-3.5 shrink-0 text-amber-400";
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const messageMatchedIds = new Set(messageSearchResults.map((result) => result.conversationId));
    const filteredConversations = conversations.filter((conversation) => {
        const matchesSearch =
            !normalizedSearch ||
            conversation.title.toLowerCase().includes(normalizedSearch) ||
            messageMatchedIds.has(conversation.id);
        const matchesFilter =
            conversationFilter === "all" ||
            (conversationFilter === "locked" && conversation.isLocked) ||
            (conversationFilter === "shared" && conversation.shareEnabled);

        return matchesSearch && matchesFilter;
    }).sort((a, b) => {
        const pinnedDelta =
            Number(pinnedConversationIds.includes(b.id)) -
            Number(pinnedConversationIds.includes(a.id));
        if (pinnedDelta !== 0) return pinnedDelta;
        const favoriteDelta =
            Number(favoriteConversationIds.includes(b.id)) -
            Number(favoriteConversationIds.includes(a.id));
        return favoriteDelta;
    });

    useEffect(() => {
        if (isGuestMode || normalizedSearch.length < 2) {
            const timer = window.setTimeout(() => setMessageSearchResults([]), 0);
            return () => window.clearTimeout(timer);
        }
        const controller = new AbortController();
        const timer = window.setTimeout(() => {
            void fetch(`/api/conversations/search?q=${encodeURIComponent(searchQuery.trim())}`, {
                signal: controller.signal,
                cache: "no-store",
            })
                .then((response) => (response.ok ? response.json() : { results: [] }))
                .then((data) => setMessageSearchResults(Array.isArray(data.results) ? data.results : []))
                .catch(() => {});
        }, 250);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [isGuestMode, normalizedSearch.length, searchQuery]);

    const toggleStoredId = (storageKey: string, id: string, setter: (ids: string[]) => void) => {
        let next: string[] = [];
        try {
            const current = JSON.parse(localStorage.getItem(storageKey) || "[]");
            const values = Array.isArray(current) ? current.filter((item): item is string => typeof item === "string") : [];
            next = values.includes(id) ? values.filter((item) => item !== id) : [id, ...values];
            localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
            next = [id];
            localStorage.setItem(storageKey, JSON.stringify(next));
        }
        setter(next);
    };

    const togglePinned = (id: string) =>
        toggleStoredId("tomverse_pinned_conversations", id, setPinnedConversationIds);
    const toggleFavorite = (id: string) =>
        toggleStoredId("tomverse_favorite_conversations", id, setFavoriteConversationIds);

    const getConversationModelSummary = (conversation: Conversation) => {
        const models = conversation.selectedModels
            ?.map((modelId) => getModel(modelId)?.name)
            .filter(Boolean);

        if (!models?.length) return t("sidebar.noModelInfo");
        if (models.length === 1) return models[0];
        return `${models[0]} +${models.length - 1}`;
    };

    const closePrivateNotice = useCallback((restoreFocus = true) => {
        setShowPrivateNotice(false);
        if (restoreFocus) {
            requestAnimationFrame(() => privateModeButtonRef.current?.focus());
        }
    }, []);

    const getPrivateNoticeFocusableElements = useCallback(() => {
        const dialog = privateNoticeDialogRef.current;
        if (!dialog) return [];

        return Array.from(
            dialog.querySelectorAll<HTMLElement>(
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
        function handleClickOutside(event: MouseEvent) {
            const target = event.target as HTMLElement;
            if (!target.closest('.context-menu-wrapper')) {
                setOpenMenuId(null);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    useEffect(() => {
        if (!showPrivateNotice) return;
        const animationFrame = requestAnimationFrame(() => {
            getPrivateNoticeFocusableElements()[0]?.focus();
        });
        return () => cancelAnimationFrame(animationFrame);
    }, [getPrivateNoticeFocusableElements, showPrivateNotice]);

    useEffect(() => {
        if (!showPrivateNotice) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closePrivateNotice(true);
                return;
            }

            if (event.key !== "Tab") return;

            const focusableElements = getPrivateNoticeFocusableElements();
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
        document.addEventListener("keydown", handleKeyDown, true);
        return () => document.removeEventListener("keydown", handleKeyDown, true);
    }, [closePrivateNotice, getPrivateNoticeFocusableElements, showPrivateNotice]);

    return (
        <>
        <aside className="w-72 shrink-0 bg-zinc-50 border-r border-zinc-200 dark:bg-zinc-950 dark:border-zinc-800 flex flex-col h-full select-none">

            <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200 shadow-sm dark:ring-zinc-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src="/tomverse-logo.png"
                        alt="Tomverse AI"
                        className="h-full w-full object-cover"
                    />
                </span>
                <h1 className="text-base font-bold tracking-tight text-zinc-800 dark:text-zinc-100">
                    Tomverse AI
                </h1>
            </div>

            <div className="p-3 border-b border-zinc-200/60 dark:border-zinc-800/40">
                <button
                    onClick={onNewChat}
                    className="w-full cursor-pointer flex items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-xs font-semibold text-white transition-all hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                >
                    <span className="text-sm">+</span> {t("sidebar.newChat")}
                </button>

                <button
                    ref={privateModeButtonRef}
                    onClick={() => {
                        if (isPrivateMode) {
                            onTogglePrivateMode();
                        } else {
                            setShowPrivateNotice(true);
                        }
                    }}
                    disabled={isGuestMode}
                    className={`mt-2 w-full flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-xs font-semibold transition-all ${isGuestMode
                            ? "cursor-not-allowed opacity-50 border-zinc-200 bg-white text-zinc-400 dark:border-zinc-700/50 dark:bg-zinc-800/50 dark:text-zinc-500"
                            : isPrivateMode
                                ? "cursor-pointer border-purple-700/70 bg-purple-950/40 text-purple-200 hover:bg-purple-900/50"
                                : "cursor-pointer border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700/50 dark:bg-zinc-800/50 dark:text-zinc-300 dark:hover:bg-zinc-700/60 dark:hover:text-white"
                        }`}
                    title={isGuestMode ? t("sidebar.loginRequired") : ""}
                >
                    {isPrivateMode ? t("sidebar.privateModeStop") : t("sidebar.privateModeStart")}
                    {isGuestMode && <Crown className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
            </div>

            <div className="border-b border-zinc-200/60 px-3 py-3 dark:border-zinc-800/40">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                    <input
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder={t("sidebar.searchPlaceholder")}
                        className="h-9 w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-3 text-xs text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-blue-500"
                    />
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-900">
                    {[
                        ["all", t("chat.allTiers")],
                        ["locked", t("sidebar.lockedBadge")],
                        ["shared", t("sidebar.sharedBadge")],
                    ].map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setConversationFilter(value as "all" | "locked" | "shared")}
                            className={`rounded-lg px-2 py-1.5 text-[11px] font-bold transition-colors ${
                                conversationFilter === value
                                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                            }`}
                            aria-pressed={conversationFilter === value}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="min-h-[10rem] flex-1 overflow-y-auto overscroll-contain p-2 space-y-1 md:min-h-0">
                {messageSearchResults.length > 0 && (
                    <div className="mb-2 rounded-xl border border-blue-200 bg-blue-50 p-2 text-xs dark:border-blue-900/50 dark:bg-blue-950/20">
                        <p className="px-1 pb-1 font-black text-blue-700 dark:text-blue-300">
                            {t("sidebar.messageMatches")}
                        </p>
                        {messageSearchResults.slice(0, 4).map((result) => (
                            <button
                                key={result.id}
                                type="button"
                                onClick={() => onSelectConversation(result.conversationId)}
                                className="block w-full rounded-lg px-2 py-1.5 text-left text-zinc-600 hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-900"
                            >
                                <span className="block truncate font-bold">{result.conversationTitle}</span>
                                <span className="block truncate text-[11px] text-zinc-400">{result.snippet}</span>
                            </button>
                        ))}
                    </div>
                )}
                {filteredConversations.length === 0 && (
                    <div className="flex h-32 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 px-4 text-center text-xs text-zinc-400 dark:border-zinc-800">
                        <MessageSquare className="mb-2 h-5 w-5" />
                        {t("sidebar.noConversations")}
                    </div>
                )}
                {filteredConversations.map((conv) => {
                    const isActive = currentChatId === conv.id;
                    const isPrivate = conv.id === "private-chat";
                    const isMenuOpen = openMenuId === conv.id;

                    return (
                        <div
                            key={conv.id}
                            onClick={() => onSelectConversation(conv.id)}
                            className={`relative group flex items-center justify-between rounded-xl px-3 py-2.5 text-xs cursor-pointer transition-all border ${isMenuOpen ? "z-20" : "z-10"} ${isPrivate
                                    ? isActive
                                    ? "bg-purple-100 border-purple-300 text-purple-700 font-semibold dark:bg-purple-900/30 dark:border-purple-700/60 dark:text-purple-200"
                                    : "bg-purple-50/50 border-purple-100 text-purple-500 hover:bg-purple-100 dark:bg-purple-950/15 dark:border-purple-900/20 dark:text-purple-400/80 dark:hover:bg-purple-900/20 dark:hover:text-purple-300"
                                : isActive
                                    ? "bg-zinc-200 border-zinc-300 text-zinc-900 font-semibold dark:bg-zinc-800 dark:border-zinc-700/80 dark:text-zinc-100"
                                    : "bg-transparent border-transparent text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200"
                                }`}
                            title={isGuestMode ? t("sidebar.loginRequired") : ""}
                        >
                            <div className="cursor-pointer flex min-w-0 flex-1 items-center gap-2.5 pr-6">
                                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${isPrivate ? "bg-purple-500/10 text-purple-500" : conv.isLocked ? "bg-amber-500/10 text-amber-500" : "bg-blue-500/10 text-blue-500"}`}>
                                    {isPrivate || conv.isLocked ? (
                                        <Lock className="h-3.5 w-3.5" />
                                    ) : (
                                        <MessageSquare className="h-3.5 w-3.5" />
                                    )}
                                </span>
                                <span className="min-w-0 flex flex-col gap-1">
                                    <span className="truncate text-[13px] leading-4">{conv.title}</span>
                                    <span className="flex items-center gap-1.5 truncate text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                                        {pinnedConversationIds.includes(conv.id) && <Pin className="h-3 w-3 shrink-0 text-blue-500" />}
                                        {favoriteConversationIds.includes(conv.id) && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                                        <Sparkles className="h-3 w-3 shrink-0" />
                                        <span className="truncate">{getConversationModelSummary(conv)}</span>
                                        {conv.shareEnabled && (
                                            <span className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-bold text-blue-500">
                                                {t("sidebar.sharedBadge")}
                                            </span>
                                        )}
                                        {conv.isLocked && (
                                            <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-500">
                                                {t("sidebar.lockedBadge")}
                                            </span>
                                        )}
                                    </span>
                                </span>
                            </div>

                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center context-menu-wrapper">
                                <button
                                    type="button"
                                    data-testid="conversation-menu"
                                    data-conversation-id={conv.id}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenMenuId(openMenuId === conv.id ? null : conv.id);
                                    }}
                                    className="cursor-pointer p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                                    title={t("chat.moreActions")}
                                    aria-label={`${t("chat.moreActions")}: ${conv.title}`}
                                >
                                    <MoreVertical className="h-4 w-4" />
                                </button>

                                {isMenuOpen && (
                                    <div
                                        data-testid="conversation-menu-panel"
                                        className="absolute right-0 top-6 z-50 w-56 rounded-lg border border-zinc-800 bg-zinc-900 p-1.5 shadow-xl flex flex-col text-xs text-zinc-300 animate-fadeIn"
                                    >
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setOpenMenuId(null);
                                                setRenameTarget(conv);
                                                setRenameValue(conv.title);
                                            }}
                                            className={`${menuItemBase} ${menuItemEnabled}`}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Pencil className={menuIconClass} />
                                                <span>{t("sidebar.rename")}</span>
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                togglePinned(conv.id);
                                                setOpenMenuId(null);
                                            }}
                                            className={`${menuItemBase} ${menuItemEnabled}`}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Pin className={menuIconClass} />
                                                <span>{pinnedConversationIds.includes(conv.id) ? t("sidebar.unpinChat") : t("sidebar.pinChat")}</span>
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                toggleFavorite(conv.id);
                                                setOpenMenuId(null);
                                            }}
                                            className={`${menuItemBase} ${menuItemEnabled}`}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Star className={menuIconClass} />
                                                <span>{favoriteConversationIds.includes(conv.id) ? t("sidebar.removeFavorite") : t("sidebar.favoriteChat")}</span>
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (!isGuestMode) {
                                                    onShare(conv.id, conv.title);
                                                    setOpenMenuId(null);
                                                }
                                            }}
                                            disabled={isGuestMode}
                                            className={`${menuItemBase} ${isGuestMode ? menuItemDisabled : menuItemEnabled}`}
                                            title={isGuestMode ? t("sidebar.loginRequired") : ""}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Share2 className={menuIconClass} />
                                                <span>
                                                    {conv.shareEnabled
                                                        ? t("sidebar.refreshShare")
                                                        : t("sidebar.share")}
                                                </span>
                                            </span>
                                            {isGuestMode && <Crown className={crownClass} />}
                                        </button>

                                        {conv.shareEnabled && !isGuestMode && (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setOpenMenuId(null);
                                                    onRevokeShare(conv.id);
                                                }}
                                                className={`${menuItemBase} ${menuItemEnabled}`}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Link2Off className={menuIconClass} />
                                                    <span>{t("sidebar.revokeShare")}</span>
                                                </span>
                                            </button>
                                        )}

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (!isGuestMode) {
                                                    onDownload(conv.id, conv.title);
                                                    setOpenMenuId(null);
                                                }
                                            }}
                                            disabled={isGuestMode}
                                            className={`${menuItemBase} ${isGuestMode ? menuItemDisabled : menuItemEnabled}`}
                                            title={isGuestMode ? t("sidebar.loginRequired") : ""}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Download className={menuIconClass} />
                                                <span>{t("sidebar.downloadTxt")}</span>
                                            </span>
                                            {isGuestMode && <Crown className={crownClass} />}
                                        </button>


                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setOpenMenuId(null);
                                                onDelete(conv.id);
                                            }}
                                            className={`${menuItemBase} cursor-pointer text-red-400 hover:bg-zinc-800 hover:text-red-300`}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Trash2 className={menuIconClass} />
                                                <span>{t("sidebar.delete")}</span>
                                            </span>
                                        </button>

                                        {isGuestMode ? (
                                            <button
                                                type="button"
                                                disabled
                                                className={`${menuItemBase} ${menuItemDisabled}`}
                                                title={t("sidebar.loginRequired")}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Lock className={menuIconClass} />
                                                    <span>{t("sidebar.lock")}</span>
                                                </span>
                                                <Crown className={crownClass} />
                                            </button>
                                        ) : conv.isLocked ? (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setOpenMenuId(null);
                                                    if (onUnlock) onUnlock(conv.id);
                                                }}
                                                className={`${menuItemBase} ${menuItemEnabled}`}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Unlock className={menuIconClass} />
                                                    <span>{t("sidebar.unlock")}</span>
                                                </span>
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setOpenMenuId(null);
                                                    setLockTarget(conv);
                                                    setLockPassword("");
                                                    setLockError("");
                                                }}
                                                className={`${menuItemBase} ${menuItemEnabled}`}
                                            >
                                                <span className="flex items-center gap-2">
                                                    <Lock className={menuIconClass} />
                                                    <span>{t("sidebar.lock")}</span>
                                                </span>
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="max-h-[32dvh] shrink-0 overflow-y-auto overscroll-contain border-t border-zinc-200 bg-zinc-100/40 p-3 flex flex-col gap-2 dark:border-zinc-800 dark:bg-zinc-900/50 md:max-h-none md:overflow-visible">
                <div className="rounded-2xl border border-zinc-200 bg-white p-3 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                    <div className="flex items-center justify-between gap-2">
                        <span className="font-bold text-zinc-500 dark:text-zinc-400">{t("sidebar.currentPlan")}</span>
                        <span className={`rounded-full px-2 py-0.5 font-black ${displayedPlan === "Guest" || displayedPlan === null ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" : displayedPlan === "Free" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : displayedPlan === "Pro" ? "bg-blue-500/10 text-blue-600 dark:text-blue-300" : "bg-purple-500/10 text-purple-600 dark:text-purple-300"}`}>
                            {displayedPlan ? t(`modelTiers.${displayedPlan.toLowerCase()}`) : t("auth.loading")}
                        </span>
                    </div>
                    {planDescriptionKey && (
                        <p className="mt-2 hidden leading-5 text-zinc-500 dark:text-zinc-400 md:block">
                            {t(planDescriptionKey)}
                        </p>
                    )}
                    {(displayedUsage.limit > 0 || isDailyUnlimited) && (
                        <div className="mt-3">
                            <div className="mb-1 flex items-center justify-between font-semibold text-zinc-500 dark:text-zinc-400">
                                <span>{t("sidebar.todayUsage")}</span>
                                <span>{isDailyUnlimited ? t("usage.unlimited") : `${displayedRemaining} ${t("sidebar.remaining")}`}</span>
                            </div>
                            {!isDailyUnlimited && (
                                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                                    <div
                                        className={`h-full transition-all duration-500 ${displayedUsage.used >= displayedUsage.limit ? "bg-red-500" : "bg-blue-500"}`}
                                        style={{ width: displayedUsageWidth }}
                                    />
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <FeedbackButton currentModelId={currentModelId} />
                <div className="rounded-2xl border border-zinc-200 bg-white p-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                    <AuthButton />
                </div>
            </div>
        </aside>
        {showPrivateNotice && (
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                role="presentation"
                onMouseDown={(event) => {
                    if (event.target === event.currentTarget) {
                        closePrivateNotice(true);
                    }
                }}
            >
                <div
                    ref={privateNoticeDialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="private-mode-notice-title"
                    className="w-full max-w-lg rounded-lg border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
                >
                    <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
                        <div className="flex min-w-0 items-center gap-3">
                            <ShieldCheck className="h-5 w-5 shrink-0 text-purple-500" />
                            <div>
                                <h2
                                    id="private-mode-notice-title"
                                    className="text-base font-semibold text-zinc-900 dark:text-zinc-100"
                                >
                                    {t("sidebar.privateNoticeTitle")}
                                </h2>
                                <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                                    {t("sidebar.privateNoticeIntro")}
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => closePrivateNotice(true)}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                            aria-label={t("auth.cancel")}
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    <div className="space-y-4 px-5 py-4 text-sm text-zinc-700 dark:text-zinc-300">
                        <div className="flex gap-3">
                            <Database className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                            <p className="leading-6">{t("sidebar.privateNoticeNoSave")}</p>
                        </div>
                        <div className="flex gap-3">
                            <Send className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
                            <p className="leading-6">{t("sidebar.privateNoticeProvider")}</p>
                        </div>
                        <div className="flex gap-3">
                            <CloudUpload className="mt-0.5 h-4 w-4 shrink-0 text-cyan-500" />
                            <p className="leading-6">{t("sidebar.privateNoticeAttachment")}</p>
                        </div>
                        <div className="flex gap-3 rounded-md bg-amber-50 px-3 py-2.5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <p className="text-xs leading-5">{t("sidebar.privateNoticeCaution")}</p>
                        </div>
                        <Link
                            href="/privacy"
                            className="inline-flex text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                            {t("sidebar.privateNoticePolicy")}
                        </Link>
                    </div>

                    <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                        <button
                            type="button"
                            onClick={() => closePrivateNotice(true)}
                            className="rounded-md px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                            {t("auth.cancel")}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                closePrivateNotice(false);
                                onTogglePrivateMode();
                            }}
                            className="rounded-md bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-500"
                        >
                            {t("sidebar.privateNoticeContinue")}
                        </button>
                    </div>
                </div>
            </div>
        )}
        {renameTarget && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        const nextTitle = renameValue.trim();
                        if (!nextTitle) return;
                        onRename(renameTarget.id, nextTitle);
                        setRenameTarget(null);
                    }}
                    className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
                >
                    <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                        {t("sidebar.rename")}
                    </h2>
                    <label className="mt-4 block text-xs font-semibold text-zinc-500">
                        {t("sidebar.chatTitle")}
                    </label>
                    <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        maxLength={80}
                        className="mt-2 h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-sm font-medium text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                    <div className="mt-5 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setRenameTarget(null)}
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
        {lockTarget && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                <form
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="conversation-lock-title"
                    onSubmit={(event) => {
                        event.preventDefault();
                        const password = lockPassword.trim();
                        if (password.length < 4 || password.length > 128) {
                            setLockError(t("sidebar.passwordLength"));
                            return;
                        }
                        if (onLock) onLock(lockTarget.id, password);
                        setLockTarget(null);
                    }}
                    className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
                >
                    <h2
                        id="conversation-lock-title"
                        className="text-base font-bold text-zinc-900 dark:text-zinc-100"
                    >
                        {t("sidebar.lock")}
                    </h2>
                    <p className="mt-2 text-sm text-zinc-500">{lockTarget.title}</p>
                    <label
                        htmlFor="conversation-lock-password"
                        className="mt-4 block text-xs font-semibold text-zinc-500"
                    >
                        {t("sidebar.password")}
                    </label>
                    <input
                        id="conversation-lock-password"
                        autoFocus
                        type="password"
                        value={lockPassword}
                        onChange={(event) => {
                            setLockPassword(event.target.value);
                            setLockError("");
                        }}
                        className="mt-2 h-11 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-sm font-medium text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
                    />
                    {lockError && <p className="mt-2 text-xs font-medium text-red-500">{lockError}</p>}
                    <div className="mt-5 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setLockTarget(null)}
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
