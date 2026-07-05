"use client";

import { Conversation } from "./types";

type ChatSidebarProps = {
  userEmail: string; // 💡 상위에서 전달받는 유저 이메일
  conversations: Conversation[];
  currentChatId: string | null;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
};

export function ChatSidebar({
  userEmail,
  conversations,
  currentChatId,
  onNewChat,
  onSelectConversation,
  onRename,
  onDelete,
}: ChatSidebarProps) {
  return (
    <aside className="w-64 shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col h-full select-none">
      
      {/* 💡 1. 상단 시스템 이름 배너 복구 */}
      <div className="p-4 border-b border-zinc-800 flex items-center gap-2">
        <span className="text-xl">🌌</span>
        <h1 className="text-md font-bold tracking-wider text-zinc-100 bg-gradient-to-r from-zinc-100 to-zinc-400 bg-clip-text text-transparent">
          Tomverse AI
        </h1>
      </div>

      {/* 새 대화 시작 버튼 */}
      <div className="p-3 border-b border-zinc-800/40">
        <button
          onClick={onNewChat}
          className="w-full cursor-pointer flex items-center justify-center gap-2 rounded-xl bg-zinc-800/50 border border-zinc-700/50 px-4 py-2 text-xs font-medium text-zinc-300 transition-all hover:bg-zinc-700/60 hover:text-white"
        >
          <span className="text-sm">+</span> 새 대화 시작하기
        </button>
      </div>

      {/* 2. 대화방 목록 영역 (중간 스크롤 영역) */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
        {conversations.map((conv) => {
          const isActive = currentChatId === conv.id;
          const isPrivate = conv.id === "private-chat";

          return (
            <div
              key={conv.id}
              onClick={() => onSelectConversation(conv.id)}
              className={`group flex items-center justify-between rounded-xl px-3 py-2 text-xs cursor-pointer transition-all border ${
                isPrivate
                  ? isActive
                    ? "bg-purple-900/30 border-purple-700/60 text-purple-200 font-semibold shadow-inner"
                    : "bg-purple-950/15 border-purple-900/20 text-purple-400/80 hover:bg-purple-900/20 hover:text-purple-300"
                  : isActive
                    ? "bg-zinc-800 border-zinc-700/80 text-zinc-100 font-medium"
                    : "bg-transparent border-transparent text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="shrink-0 text-zinc-500 text-[10px]">
                  {isPrivate ? "🔒" : "💬"}
                </span>
                <span className="truncate">{conv.title}</span>
              </div>

              {!isPrivate && (
                <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity shrink-0 ml-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const t = prompt("새 대화방 이름:", conv.title);
                      if (t) onRename(conv.id, t);
                    }}
                    className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700"
                    title="이름 수정"
                  >
                    ✏️
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(conv.id);
                    }}
                    className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-700"
                    title="대화 삭제"
                  >
                    🗑️
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 💡 3. 하단 사용자 정보 및 설정 관리 영역 복구 */}
      <div className="p-4 border-t border-zinc-800 bg-zinc-900/50 flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[9px] text-zinc-500 font-bold tracking-wider uppercase">
              Signed in as
            </span>
            <span className="text-xs text-zinc-300 truncate font-medium" title={userEmail}>
              {userEmail}
            </span>
          </div>
          
          {/* 추후 설정 모달이나 관리 페이지 라우팅용 버튼 */}
          <button 
            onClick={() => alert("추후 사용자 설정 기능이 구현될 예정입니다.")}
            className="cursor-pointer p-2 rounded-xl text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors shrink-0"
            title="사용자 설정"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>
      </div>

    </aside>
  );
}