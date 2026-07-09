"use client";

import { Conversation } from "./types";
import { AuthButton } from "@/components/auth/AuthButton";
import { useState, useEffect, useRef } from "react";
import { useLanguage } from "@/components/LanguageProvider"; // 💡 훅 임포트
import Link from "next/link";
import { AlertTriangle, CloudUpload, Crown, Database, Download, Lock, MoreVertical, Pencil, Send, Share2, ShieldCheck, Trash2, Unlock, X } from "lucide-react";

type ChatSidebarProps = {
    userEmail: string;
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
    onDownload: (id: string, title: string) => void;    
    isPrivateMode?: boolean;
    onTogglePrivateMode: () => void;
};

export function ChatSidebar({
    userEmail,
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
    onDownload,    
    isPrivateMode = false,
    onTogglePrivateMode,
}: ChatSidebarProps) {
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [showPrivateNotice, setShowPrivateNotice] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const { t, lang, setLang } = useLanguage(); // 💡 t 함수 꺼내기
    const menuItemBase =
        "flex w-full items-center justify-between whitespace-nowrap rounded px-3 py-2 text-sm transition-colors";

    const menuItemEnabled =
        "cursor-pointer text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100";

    const menuItemDisabled =
        "cursor-not-allowed bg-zinc-900/50 text-zinc-600";

    const menuIconClass = "h-3.5 w-3.5 shrink-0";
    const crownClass = "h-3.5 w-3.5 shrink-0 text-amber-400";

    // 메뉴 바깥 클릭 시 컨텍스트 메뉴가 자동으로 닫히도록 관리
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
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setShowPrivateNotice(false);
        };
        document.addEventListener("keydown", handleEscape);
        return () => document.removeEventListener("keydown", handleEscape);
    }, [showPrivateNotice]);

    return (
        <>
        <aside className="w-64 shrink-0 bg-zinc-50 border-r border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800 flex flex-col h-full select-none">

            {/* 💡 1. 상단 시스템 이름 배너 복구 */}
            <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
                <span className="text-xl">🌌</span>
                <h1 className="text-md font-bold tracking-wider text-zinc-800 dark:text-zinc-100">
                    Tomverse AI
                </h1>
            </div>

            {/* 새 대화 시작 버튼 */}
            <div className="p-3 border-b border-zinc-200/60 dark:border-zinc-800/40">
                <button
                    onClick={onNewChat}
                    className="w-full cursor-pointer flex items-center justify-center gap-2 rounded-xl bg-white border border-zinc-200 dark:bg-zinc-800/50 dark:border-zinc-700/50 px-4 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-300 transition-all hover:bg-zinc-100 dark:hover:bg-zinc-700/60 hover:text-zinc-900 dark:hover:text-white"
                >
                    <span className="text-sm">+</span> {t("sidebar.newChat")}
                </button>

                <button
                    onClick={() => {
                        if (isPrivateMode) {
                            onTogglePrivateMode();
                        } else {
                            setShowPrivateNotice(true);
                        }
                    }}
                    disabled={isGuestMode}
                    className={`mt-2 w-full flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-xs font-semibold transition-all ${isGuestMode
                            ? "cursor-not-allowed opacity-50 border-zinc-200 bg-white text-zinc-400 dark:border-zinc-700/50 dark:bg-zinc-800/50 dark:text-zinc-500"
                            : isPrivateMode
                                ? "cursor-pointer border-purple-700/70 bg-purple-950/40 text-purple-200 hover:bg-purple-900/50"
                                : "cursor-pointer border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700/50 dark:bg-zinc-800/50 dark:text-zinc-300 dark:hover:bg-zinc-700/60 dark:hover:text-white"
                        }`}
                    title={isGuestMode ? t("sidebar.loginRequired") : ""}
                >
                    {isPrivateMode ? t("sidebar.privateModeStop") : t("sidebar.privateModeStart")}
                    {isGuestMode && <span>👑</span>}
                </button>
            </div>

            {/* 2. 대화방 목록 영역 (중간 스크롤 영역) */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
                {conversations.map((conv) => {
                    const isActive = currentChatId === conv.id;
                    const isPrivate = conv.id === "private-chat";
                    const isMenuOpen = openMenuId === conv.id;

                    return (
                        <div
                            key={conv.id}
                            onClick={() => onSelectConversation(conv.id)}
                            className={`relative group flex items-center justify-between rounded-xl px-3 py-2 text-xs cursor-pointer transition-all border ${isMenuOpen ? "z-20" : "z-10"} ${isPrivate
                                    ? isActive
                                    ? "bg-purple-100 border-purple-300 text-purple-700 font-semibold dark:bg-purple-900/30 dark:border-purple-700/60 dark:text-purple-200"
                                    : "bg-purple-50/50 border-purple-100 text-purple-500 hover:bg-purple-100 dark:bg-purple-950/15 dark:border-purple-900/20 dark:text-purple-400/80 dark:hover:bg-purple-900/20 dark:hover:text-purple-300"
                                : isActive
                                    ? "bg-zinc-200 border-zinc-300 text-zinc-900 font-semibold dark:bg-zinc-800 dark:border-zinc-700/80 dark:text-zinc-100"
                                    : "bg-transparent border-transparent text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/40 dark:hover:text-zinc-200"
                                }`}
                            title={isGuestMode ? "로그인 후 이용할 수 있습니다." : ""}
                        >
                            <div className="cursor-pointer flex items-center gap-2 min-w-0 flex-1 pr-6">
                                <span className="shrink-0 text-zinc-500 text-[10px]">
                                    {isPrivate || conv.isLocked ? "🔒" : "💬"}
                                </span>
                                <span className="truncate">{conv.title}</span>
                            </div>

                            {/* 💡 세 개의 점(⋮) 컨텍스트 메뉴 버튼 */}
                            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center context-menu-wrapper">
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenMenuId(openMenuId === conv.id ? null : conv.id);
                                    }}
                                    className="cursor-pointer p-1 text-zinc-500 hover:text-zinc-200 transition-colors"
                                    title="메뉴"
                                >
                                    <MoreVertical className="h-4 w-4" />
                                </button>

                                {/* 컨텍스트 팝업 메뉴 레이어 */}
                                {isMenuOpen && (
                                    <div className="absolute right-0 top-6 z-50 w-48 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-xl flex flex-col text-xs text-zinc-300 animate-fadeIn">
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setOpenMenuId(null);
                                                const newTitle = prompt(t("sidebar.newChatRoom"), conv.title);
                                                if (newTitle && newTitle.trim()) {
                                                    onRename(conv.id, newTitle.trim());
                                                }
                                            }}
                                            className={`${menuItemBase} ${menuItemEnabled}`}
                                        >
                                            <span className="flex items-center gap-2">
                                                <Pencil className={menuIconClass} />
                                                <span>{t("sidebar.rename")}</span>
                                            </span>
                                        </button>

            {/* 대화 공유 버튼 */}
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
                                                <span>{t("sidebar.share")}</span>
                                            </span>
                                            {isGuestMode && <Crown className={crownClass} />}
                                        </button>

            {/* TXT 다운로드 버튼 */}
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

                                        {/* 💡 잠금 기능 권한 분기 세팅 */}
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
                                                    const pwd = prompt(t("sidebar.enterPassword"));
                                                    if (
                                                        pwd &&
                                                        (pwd.trim().length < 4 ||
                                                            pwd.trim().length > 128)
                                                    ) {
                                                        alert(t("sidebar.passwordLength"));
                                                        return;
                                                    }
                                                    if (pwd && pwd.trim()) {
                                                        if (onLock) onLock(conv.id, pwd.trim());
                                                    }
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
                        </div> // 💡 누락되었던 가장 바깥쪽의 닫는 div 태그 추가 완료!
                    );
                })}
            </div>

            {/* 💡 3. 하단 사용자 정보 및 설정 관리 영역 복구 */}
            <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-100/40 dark:bg-zinc-900/50 flex flex-col gap-2 shrink-0">
                {/* 💡 게스트 모드일 때만 렌더링되는 일일 사용량 게이지 */}
                {isGuestMode && guestMessageCount !== undefined && maxGuestMessages !== undefined && (
                    <div className="px-1">
                        <div className="flex justify-between items-center mb-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            <span className="font-medium">{t("sidebar.guestLimit")}</span>
                            <span className="font-bold text-zinc-700 dark:text-zinc-300">
                                {guestMessageCount} <span className="opacity-50">/ {maxGuestMessages}</span>
                            </span>
                        </div>
                        {/* 프로그레스 바 배경 */}
                        <div className="h-1.5 w-full bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                            {/* 실제 채워지는 게이지 */}
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
                        setShowPrivateNotice(false);
                    }
                }}
            >
                <div
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
                            onClick={() => setShowPrivateNotice(false)}
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
                            onClick={() => setShowPrivateNotice(false)}
                            className="rounded-md px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                            {t("auth.cancel")}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setShowPrivateNotice(false);
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
        </>
    );
}
