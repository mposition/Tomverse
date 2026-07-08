"use client";

import { useEffect, useRef, useState } from "react";
import { AVAILABLE_MODELS } from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";

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
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const { t, lang, setLang } = useLanguage(); // 💡 t 함수 꺼내기

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
  const isDisabled = disabled || isSending || isGuestLimitReached;
  
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
      // isDisabled로 검사하도록 변경
      if (!isDisabled) {
        onSubmit();
      }
    }
  };

  return (
      <div className="shrink-0 border-t border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950 md:px-8 transition-colors">
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
            className="cursor-pointer ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200 text-zinc-700 hover:bg-zinc-300 hover:text-zinc-900 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-white transition"
          >
            +
          </button>

          {/* 모델 선택 팝업 메뉴 레이어 */}
          {isMenuOpen && (
                      <div className="absolute bottom-12 left-0 z-50 flex max-h-[calc(100dvh-8rem)] w-[min(20rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white p-2 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
                          <div className="mb-2 px-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400">{t("chat.modelSelect")}</div>
                          <div className="min-h-0 space-y-1 overflow-y-auto overscroll-contain pr-1">
                              {AVAILABLE_MODELS.map((model) => {
                  const isSelected = selectedModels.includes(model.id);
                  return (
                    <button
                      key={model.id}
                      onClick={() => onToggleModel(model.id)}
                          className="cursor-pointer flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                      <span className="flex items-center gap-2">
                        <span>{model.icon}</span>
                              <span className="flex min-w-0 flex-col items-start">
                                  <span className={isSelected ? "text-zinc-900 dark:text-white font-medium" : "text-zinc-500 dark:text-zinc-400"}>
                                      {model.name}
                                  </span>
                                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                                      {model.provider}
                                  </span>
                              </span>
                              <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${model.tier === "Free"
                                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                                      : model.tier === "Pro"
                                          ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                                          : "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                                  }`}>
                                  {model.tier}
                              </span>
                          </span>
                      {/* 토글 스위치 디자인 */}
                      <div className={`h-4 w-8 rounded-full p-0.5 transition-colors ${isSelected ? "bg-blue-500" : "bg-zinc-300 dark:bg-zinc-700"}`}>
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
          placeholder={placeholderText}
          disabled={isDisabled}
          rows={1}
                  className="max-h-[160px] min-h-[48px] flex-1 resize-none overflow-y-auto rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-blue-500 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-500"
              />

        {isSending ? (
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-2xl bg-red-600 px-5 py-3 text-sm font-medium text-white hover:bg-red-500"
          >
            {t("chat.cancel")}
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={isDisabled || !value.trim()}
            className="cursor-pointer rounded-2xl bg-blue-600 px-5 py-3 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("chat.send")}
          </button>
        )}
		
      </div>
    </div>
  );
}
