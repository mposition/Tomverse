// components/auth/AuthButton.tsx
"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useState, useEffect } from "react";
import { ENABLED_MODELS } from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";
import { APP_DEFAULTS } from "@/lib/appDefaults";

export function AuthButton() {
  // 💡 현재 로그인 상태(session)를 가져옵니다.
  const { data: session, status } = useSession();
    const [isModalOpen, setIsModalOpen] = useState(false);

    const { t, lang: globalLang, setLang: setGlobalLang } = useLanguage();

    const [theme, setTheme] = useState<"dark" | "light">(APP_DEFAULTS.defaultTheme);
    const [language, setLanguage] = useState<"en" | "zh" | "ko">(APP_DEFAULTS.defaultLanguage);
    const [defaultModel, setDefaultModel] = useState<string>(APP_DEFAULTS.defaultModelId);

    // 모달이 열릴 때 DB에서 최신 설정을 받아옴
    useEffect(() => {
        if (isModalOpen && session) {
            fetch("/api/user/settings")
                .then((res) => res.json())
                .then((data) => {
                    if (!data.error) {
                        setTheme(data.theme || APP_DEFAULTS.defaultTheme);
                        setLanguage(data.language || globalLang);
                        setDefaultModel(data.defaultModel || APP_DEFAULTS.defaultModelId);
                    }
                });
        }
    }, [isModalOpen, session, globalLang]);

    // 확인 버튼을 눌렀을 때 실행될 저장 함수
    const handleSaveSettings = async () => {
        try {
            const res = await fetch("/api/user/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ theme, language, defaultModel }),
            });

            if (res.ok) {
                // 💡 중요: 새로고침(window.location.reload()) 대신 모달만 닫고 
                // 렌더링에 필요한 스타일이나 전역 상태만 바꾸어 500 파싱 에러를 완벽 차단합니다.
                setIsModalOpen(false);
                alert(t("auth.saveMessage"));

                setGlobalLang(language as any);

                if (theme === "light") {
                    document.documentElement.classList.remove("dark");
                } else {
                    document.documentElement.classList.add("dark");
                }

                setDefaultModel(defaultModel);
            } else {
                alert(t("auth.failedMessage"));
            }
        } catch (e) {
            console.error(e);
        }
    };

  if (status === "loading") {
      return <div className="text-sm text-zinc-400">{ t("auth.loading") }</div>;
  }

// 1️⃣ 로그인 세션이 있는 경우 (Signed as 이메일 표시)
  if (session && session.user) {
    return (
      <div className="flex flex-col gap-2 w-full p-3 rounded-xl bg-zinc-900 border border-zinc-800">
        <div className="flex items-center gap-2.5 min-w-0">
          {session.user.image && (
            <img 
              src={session.user.image} 
              alt="Profile" 
              className="w-7 h-7 rounded-full border border-zinc-700 flex-shrink-0" 
            />
          )}
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Signed as</span>
            <span className="text-xs font-semibold text-zinc-200 truncate">
              {session.user.email}
            </span>
          </div>
        </div>
        <button
          onClick={() => signOut()}
          className="cursor-pointer w-full mt-1 py-1.5 text-xs font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 hover:text-zinc-200 rounded-lg transition-colors"
        >
                {t("auth.singedOut")}
        </button>
          {/* 추후 설정 모달이나 관리 페이지 라우팅용 버튼 */}
          <button 
                onClick={() => setIsModalOpen(true)}
                className=" w-full mt-1 py-1.5 text-xs font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 hover:text-zinc-200 rounded-lg transition-colors"
            >
          ⚙️ {t("auth.setting")}
            </button>		

            {/* 💡 신규 추가되는 안전한 클라이언트 사이드 설정 모달 */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="w-80 rounded-2xl bg-zinc-900 border border-zinc-800 p-5 text-zinc-100 shadow-xl">
                        <h3 className="text-sm font-bold mb-4">🔧 사용자 설정</h3>
                        {/* 테마 선택 */}
                        <div className="mb-3">
                            <label className="text-xs text-zinc-400 block mb-1">테마</label>
                            <select value={theme} onChange={(e) => setTheme(e.target.value as "dark" | "light")} className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-1.5 text-xs outline-none text-zinc-200">
                                <option value="dark">어두운 테마 (Dark)</option>
                                <option value="light">밝은 테마 (Light)</option>
                            </select>
                        </div>

                        {/* 언어 선택 */}
                        <div className="mb-4">
                            <label className="text-xs text-zinc-400 block mb-1">언어</label>
                            <select value={language} onChange={(e) => setLanguage(e.target.value as "en" | "zh" | "ko")} className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-1.5 text-xs outline-none text-zinc-200">
                                <option value="en">English</option>
                                <option value="zh">中文</option>
                                <option value="ko">한국어</option>
                            </select>
                        </div>

                        {/* 💡 AVAILABLE_MODELS 드롭다운 연동 추가 피처 */}
                        <div className="mb-4">
                            <label className="text-xs text-zinc-400 block mb-1">{t("sidebar.defaultModel")}</label>
                            <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded-lg p-1.5 text-xs outline-none text-zinc-200 cursor-pointer">
                                {ENABLED_MODELS.map((model) => (
                                    <option key={model.id} value={model.id}>
                                        {model.icon} {model.name} · {model.tier}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <button
                            type="button"
                            onClick={() => {
                                window.location.href = "/api/conversations/export-all";
                            }}
                            className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700"
                        >
                            {t("sidebar.downloadAllTxt")}
                        </button>

                        {/* 하단 제어 버튼 (서버 새로고침 없는 안전한 방식) */}
                        <div className="flex justify-end gap-2 mt-5">
                            <button onClick={() => setIsModalOpen(false)} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-xs font-medium transition-colors">
                                {t("auth.cancel")}
                            </button>
                            <button onClick={handleSaveSettings} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-medium transition-colors">
                                {t("auth.ok")}
                            </button>
                        </div>
                    </div>
                </div>
            )}
      </div>
    );
  }

  // 2️⃣ 로그인 세션이 없는 경우 (로그인/가입 버튼만 표시)
  return (
    <button
      onClick={() => signIn()} 
      className="cursor-pointer w-full px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-indigo-600 to-blue-600 rounded-xl hover:from-indigo-500 hover:to-blue-500 transition-all shadow-lg"
    >
      {t("auth.login")}
    </button>
  );
}
