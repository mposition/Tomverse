"use client";

import { useEffect, useRef, useState } from "react";
import { AiModel, AVAILABLE_MODELS } from "@/components/chat/types";

type ChatInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  disabled?: boolean;
  isSending?: boolean;
  focusToken?: number;
  selectedModels: string[];
  onToggleModel: (modelId: string) => void;
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
  onToggleModel,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 팝업 메뉴 열림/닫힘 상태
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

// 화면 바깥 클릭 시 팝업 닫기
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !isSending) {
        onSubmit();
      }
    }
  };

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-4 py-4 md:px-8">
      <div className="mx-auto flex max-w-3xl items-end gap-3">
		{/* 💡 모델 선택 UI 영역 */}
        <div className="relative flex items-center gap-1 pl-2 mb-1" ref={menuRef}>
          {/* 선택된 모델 아이콘 표시 */}
          {selectedModels.map((id) => {
            const model = AVAILABLE_MODELS.find((m) => m.id === id);
            return model ? (
              <div key={id} className="text-xl" title={model.name}>
                {model.icon}
              </div>
            ) : null;
          })}
          
          {/* + 버튼 */}
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="cursor-pointer ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition"
          >
            +
          </button>

          {/* 모델 선택 팝업 메뉴 */}
          {isMenuOpen && (
            <div className="absolute bottom-12 left-0 z-50 w-64 rounded-xl border border-zinc-700 bg-zinc-900 p-2 shadow-2xl">
              <div className="mb-2 px-2 text-xs font-semibold text-zinc-400">모델 선택</div>
              <div className="space-y-1">
                {AVAILABLE_MODELS.map((model) => {
                  const isSelected = selectedModels.includes(model.id);
                  return (
                    <button
                      key={model.id}
                      onClick={() => onToggleModel(model.id)}
                      className="cursor-pointer flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition hover:bg-zinc-800"
                    >
                      <span className="flex items-center gap-2">
                        <span>{model.icon}</span>
                        <span className={isSelected ? "text-white" : "text-zinc-400"}>
                          {model.name}
                        </span>
                      </span>
                      {/* 토글 스위치 디자인 */}
                      <div className={`h-4 w-8 rounded-full p-0.5 transition-colors ${isSelected ? "bg-blue-500" : "bg-zinc-700"}`}>
                        <div className={`h-3 w-3 rounded-full bg-white transition-transform ${isSelected ? "translate-x-4" : "translate-x-0"}`} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

		{/* 💡 텍스트 입력 영역 */}	  
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="메시지를 입력하세요..."
          disabled={disabled || isSending}
          rows={1}
          className="max-h-[160px] min-h-[48px] flex-1 resize-none overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-500 disabled:opacity-50"
        />

        {isSending ? (
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-2xl bg-red-600 px-5 py-3 text-sm font-medium text-white hover:bg-red-500"
          >
            취소
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
            className="cursor-pointer rounded-2xl bg-blue-600 px-5 py-3 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            전송
          </button>
        )}
		
      </div>
    </div>
  );
}
