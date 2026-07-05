"use client";

import { useState, useRef, useEffect } from "react";
import { Conversation } from "@/components/chat/types";

type ChatSidebarProps = {
  userEmail?: string;
  conversations: Conversation[]; // 💡 부모로부터 실시간 리스트를 주입받음
  currentChatId: string | null;  // 💡 현재 선택된 방 ID
  onSelectConversation?: (id: string) => void;
  onNewChat?: () => void;
  onRename?: (id: string, newTitle: string) => void;
  onDelete?: (id: string) => void;
};

export function ChatSidebar({
  userEmail = "guest@example.com",
  conversations,
  currentChatId,
  onSelectConversation,
  onNewChat,
  onRename,
  onDelete,  
}: ChatSidebarProps) {
  // 어떤 대화방의 메뉴(점 3개)가 열려있는지 추적
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  
  // 현재 이름 수정을 진행 중인 대화방 ID와 텍스트
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  // 메뉴 바깥을 클릭하면 닫히게 만들기 위한 Ref
  const menuRef = useRef<HTMLDivElement>(null);

  // 화면 바깥 클릭 감지 (메뉴 닫기)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 이름 수정 모드 켜기
  const startEditing = (conv: Conversation) => {
    setEditingId(conv.id);
    setEditTitle(conv.title);
    setOpenMenuId(null); // 메뉴는 닫기
  };

  // 이름 수정 완료 제출
  const submitEdit = async (id: string) => {
    if (editingId !== id || !editTitle.trim()) {
      setEditingId(null);
      return;
    }

    setEditingId(null);

    if (onRename) {
      await onRename(id, editTitle.trim());
    } 
  };
	
  return (
    <aside className="hidden w-72 border-r border-zinc-800 bg-zinc-950 p-4 md:flex md:flex-col">
      <div className="mb-6">
        <h1 className="text-xl font-bold">AI Chat Hub</h1>
        <p className="mt-1 text-sm text-zinc-400">
          여러 AI 모델을 비교하는 채팅 앱
        </p>
      </div>

      <button
        onClick={onNewChat}
        className="cursor-pointer rounded-xl border border-zinc-700 px-4 py-3 text-left text-sm font-medium transition hover:bg-zinc-900"
      >
        + 새 채팅
      </button>

      <div className="mt-6 flex-1 space-y-2 overflow-y-auto">
        <p className="px-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          최근 대화
        </p>

        {conversations.length === 0 ? (
          <p className="px-2 text-sm text-zinc-500">대화 기록이 없습니다.</p>
        ) : (
			conversations.map((conv) => (
            <div key={conv.id} className="relative group flex items-center">
              {/* 💡 수정 모드일 때는 input창을 보여줌 */}
              {editingId === conv.id ? (
                <input
                  autoFocus
                  className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white outline-none border border-zinc-600 focus:border-zinc-400"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitEdit(conv.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onBlur={() => submitEdit(conv.id)}
                />
              ) : (
                <button
                  onClick={() => onSelectConversation?.(conv.id)}
                  className={`cursor-pointer flex-1 truncate rounded-lg px-3 py-2 text-left text-sm transition ${
                    currentChatId === conv.id
                      ? "bg-zinc-800 text-white font-medium"
                      : "text-zinc-300 hover:bg-zinc-900"
                  }`}
                >
                  {conv.title}
                </button>
              )}

              {/* 💡 마우스를 올렸을 때만 보이는 옵션(점 3개) 버튼 */}
              {editingId !== conv.id && (
                <button
                  onClick={() => setOpenMenuId(openMenuId === conv.id ? null : conv.id)}
                  className="cursor-pointer absolute right-2 opacity-0 group-hover:opacity-100 p-1 text-zinc-400 hover:text-white transition-opacity"
                >
                  ⋮
                </button>
              )}

              {/* 💡 컨텍스트 메뉴 팝업 */}
              {openMenuId === conv.id && (
                <div 
                  ref={menuRef}
                  className="absolute right-8 top-8 z-50 w-28 rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-lg"
                >
                  <button
                    onClick={() => startEditing(conv)}
                    className="w-full px-4 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700 hover:text-white"
                  >
                    이름 바꾸기
                  </button>
                  <button
                    onClick={() => {
                      onDelete?.(conv.id);
                      setOpenMenuId(null);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-zinc-700 hover:text-red-300"
                  >
                    삭제
                  </button>
                </div>
              )}
            </div>
          ))
        )}
		</div>

      <div className="border-t border-zinc-800 pt-4 text-sm text-zinc-400">
        {userEmail}
      </div>
    </aside>
  );
}