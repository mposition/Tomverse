"use client";

import { Conversation } from "./types";
import { getModel } from "@/components/chat/types";
import { AuthButton } from "@/components/auth/AuthButton";
import { useCallback, useState, useEffect, useRef } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import Link from "next/link";
import { AlertTriangle, CloudUpload, Crown, Database, Download, Link2Off, Lock, MessageSquare, MoreVertical, Pencil, Search, Send, Share2, ShieldCheck, Sparkles, Trash2, Unlock, X } from "lucide-react";

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
}: ChatSidebarProps) {
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [showPrivateNotice, setShowPrivateNotice] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [lockTarget, setLockTarget] = useState<Conversation | null>(null);
    const [lockPassword, setLockPassword] = useState("");
    const [lockError, setLockError] = useState("");
    const privateModeButtonRef = useRef<HTMLButtonElement | null>(null);
    const privateNoticeDialogRef = useRef<HTMLDivElement | null>(null);
    const { t } = useLanguage();
    const menuItemBase =
        "flex w-full items-center justify-between whitespace-nowrap rounded px-3 py-2 text-sm transition-colors";

    const menuItemEnabled =
        "cursor-pointer text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100";

    const menuItemDisabled =
        "cursor-not-allowed bg-zinc-900/50 text-zinc-600";

    const menuIconClass = "h-3.5 w-3.5 shrink-0";
    const crownClass = "h-3.5 w-3.5 shrink-0 text-amber-400";
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const filteredConversations = normalizedSearch
        ? conversations.filter((conversation) =>
            conversation.title.toLowerCase().includes(normalizedSearch)
        )
        : conversations;

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
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
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
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenMenuId(openMenuId === conv.id ? null : conv.id);
                                    }}
                                    className="cursor-pointer p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                                    title={t("chat.moreActions")}
                                >
                                    <MoreVertical className="h-4 w-4" />
                                </button>

                                {isMenuOpen && (
                                    <div className="absolute right-0 top-6 z-50 w-56 rounded-lg border border-zinc-800 bg-zinc-900 p-1.5 shadow-xl flex flex-col text-xs text-zinc-300 animate-fadeIn">
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

            <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-100/40 dark:bg-zinc-900/50 flex flex-col gap-2 shrink-0">
                {isGuestMode && guestMessageCount !== undefined && maxGuestMessages !== undefined && (
                    <div className="px-1">
                        <div className="flex justify-between items-center mb-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            <span className="font-medium">{t("sidebar.guestLimit")}</span>
                            <span className="font-bold text-zinc-700 dark:text-zinc-300">
                                {guestMessageCount} <span className="opacity-50">/ {maxGuestMessages}</span>
                            </span>
                        </div>
                        <div className="h-1.5 w-full bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                            <div
                                className={`h-full transition-all duration-500 ease-out ${guestMessageCount >= maxGuestMessages ? 'bg-red-500' : 'bg-blue-500'
                                    }`}
                                style={{ width: `${Math.min((guestMessageCount / maxGuestMessages) * 100, 100)}%` }}
                            />
                        </div>
                        {guestMessageCount >= maxGuestMessages && (
                            <p className="text-[10px] text-red-500 mt-1.5 text-center font-medium animate-pulse">
                                {t("sidebar.exceedDailyLimit")}
                            </p>
                        )}
                    </div>
                )}
                <div className="flex items-center justify-between gap-2">
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
                    <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                        {t("sidebar.lock")}
                    </h2>
                    <p className="mt-2 text-sm text-zinc-500">{lockTarget.title}</p>
                    <label className="mt-4 block text-xs font-semibold text-zinc-500">
                        {t("sidebar.password")}
                    </label>
                    <input
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
