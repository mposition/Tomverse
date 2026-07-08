"use client";

import { Conversation } from "./types";
import { AuthButton } from "@/components/auth/AuthButton";
import { useState, useEffect, useRef } from "react";
import { useLanguage } from "@/components/LanguageProvider"; // 💡 훅 임포트

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
}: ChatSidebarProps) {
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const { t, lang, setLang } = useLanguage(); // 💡 t 함수 꺼내기

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

    return (
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
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="1"></circle>
                                        <circle cx="12" cy="5" r="1"></circle>
                                        <circle cx="12" cy="19" r="1"></circle>
                                    </svg>
                                </button>

                                {/* 컨텍스트 팝업 메뉴 레이어 */}
                                {isMenuOpen && (
                                    <div className="absolute right-0 top-6 z-50 w-28 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-xl flex flex-col text-xs text-zinc-300 animate-fadeIn">
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
                                            className="cursor-pointer w-full text-left px-2 py-1.5 rounded hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
                                        >
                                            {t("sidebar.rename")}
                                        </button>

            {/* 대화 공유 버튼 */}
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    if (!isGuestMode) { // 게스트가 아닐 때만 작동
                        onShare(conv.id, conv.title);
                        setOpenMenuId(null);
                    }
                }}
                disabled={isGuestMode}
                className={`flex items-center justify-between w-full text-left px-3 py-2 text-sm rounded transition-colors ${
                    isGuestMode 
                        ? "cursor-not-allowed text-zinc-600 bg-zinc-900/50" // 잠금 상태 스타일
                        : "cursor-pointer text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100" // 정상 상태 스타일
                }`}
                title={isGuestMode ? "로그인 후 이용할 수 있습니다." : ""}
            >
                <div className="flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                    <span>공유하기</span>
                </div>
                {/* 💡 게스트 모드일 때만 예쁜 황금색 왕관 아이콘 표시 */}
                {isGuestMode && (<span>👑</span>)}
            </button>

            {/* TXT 다운로드 버튼 */}
<button
                onClick={(e) => {
                    e.stopPropagation();
                    if (!isGuestMode) { // 게스트가 아닐 때만 작동
                        onDownload(conv.id, conv.title);
                        setOpenMenuId(null);
                    }
                }}
                disabled={isGuestMode}
                className={`flex items-center justify-between w-full text-left px-3 py-2 text-sm rounded transition-colors ${
                    isGuestMode 
                        ? "cursor-not-allowed text-zinc-600 bg-zinc-900/50"
                        : "cursor-pointer text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                }`}
                title={isGuestMode ? "로그인 후 이용할 수 있습니다." : ""}
            >
                <div className="flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    <span>다운로드 (.txt)</span>
                </div>
                {/* 💡 게스트 모드일 때만 예쁜 황금색 왕관 아이콘 표시 */}
                {isGuestMode && (<span>👑</span>)}
            </button>
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setOpenMenuId(null);
                                                onDelete(conv.id); 
                                            }}
                                            className="cursor-pointer w-full text-left px-2 py-1.5 rounded hover:bg-zinc-800 text-red-400 hover:text-red-300 transition-colors"
                                        >
                                            {t("sidebar.delete")}
                                        </button>

                                        {/* 💡 잠금 기능 권한 분기 세팅 */}
                                        {isGuestMode ? (
                                            <button
                                                type="button"
                                                disabled
                                                className="w-full text-left px-2 py-1.5 rounded opacity-50 cursor-not-allowed text-zinc-600 flex items-center justify-between font-medium"
                                            >
                                                <span>{t("sidebar.lock")}</span>
                                                <span>👑</span>
                                            </button>
                                        ) : conv.isLocked ? ( 
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setOpenMenuId(null);
                                                    if (onUnlock) onUnlock(conv.id); 
                                                }}
                                                    className="cursor-pointer w-full text-left px-2 py-1.5 rounded hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
                                            >
                                                    {t("sidebar.unlock")}
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setOpenMenuId(null);
                                                    const pwd = prompt(t("sidebar.enterPassword"));
                                                    if (pwd && pwd.trim()) {
                                                        if (onLock) onLock(conv.id, pwd.trim());
                                                    }
                                                }}
                                                        className="cursor-pointer w-full text-left px-2 py-1.5 rounded hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
                                            >
                                                        {t("sidebar.lock")}
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
    );
}