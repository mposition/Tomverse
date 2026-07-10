// components/auth/AuthButton.tsx
"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useState, useEffect } from "react";
import { ENABLED_MODELS } from "@/components/chat/types";
import {
    Bot,
    Check,
    Download,
    Languages,
    LogOut,
    Palette,
    Settings,
    UserRound,
    X,
} from "lucide-react";
import {
    useLanguage,
    type Language,
} from "@/components/LanguageProvider";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { notifyUserSettingsUpdated } from "@/lib/userSettingsEvents";

export function AuthButton() {
  const { data: session, status } = useSession();
    const [isModalOpen, setIsModalOpen] = useState(false);

    const { t, lang: globalLang, setLang: setGlobalLang } = useLanguage();

    const [theme, setTheme] = useState<"dark" | "light">(APP_DEFAULTS.defaultTheme);
    const [language, setLanguage] = useState<Language>(APP_DEFAULTS.defaultLanguage);
    const [defaultModel, setDefaultModel] = useState<string>(APP_DEFAULTS.defaultModelId);

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

    const handleSaveSettings = async () => {
        try {
            const res = await fetch("/api/user/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ theme, language, defaultModel }),
            });

            if (res.ok) {
                setIsModalOpen(false);
                alert(t("auth.saveMessage"));

                setGlobalLang(language);

                if (theme === "light") {
                    document.documentElement.classList.remove("dark");
                } else {
                    document.documentElement.classList.add("dark");
                }

                notifyUserSettingsUpdated({ defaultModel });
            } else {
                alert(t("auth.failedMessage"));
            }
        } catch (e) {
            console.error(e);
        }
    };

  if (status === "loading") {
      return (
          <div className="w-full rounded-xl border border-zinc-200 bg-white p-3 text-sm text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
              {t("auth.loading")}
          </div>
      );
  }

  if (session && session.user) {
    return (
      <div className="flex w-full flex-col gap-2 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700">
            {session.user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.user.image}
                alt={t("auth.profileImage")}
                className="h-full w-full object-cover"
              />
            ) : (
              <UserRound className="h-4 w-4" />
            )}
          </span>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{t("auth.signedAs")}</span>
            <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100">
              {session.user.email}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1">
            <button
                type="button"
                onClick={() => setIsModalOpen(true)}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 text-xs font-semibold text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
                <Settings className="h-3.5 w-3.5" />
                {t("auth.setting")}
            </button>
            <button
                type="button"
                onClick={() => signOut()}
                className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 text-xs font-semibold text-zinc-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:border-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
            >
                <LogOut className="h-3.5 w-3.5" />
                {t("auth.singedOut")}
            </button>
        </div>

            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
                        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
                            <div className="flex min-w-0 items-center gap-3">
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500">
                                    <Settings className="h-5 w-5" />
                                </span>
                                <div>
                                    <h3 className="text-base font-bold">{t("auth.userSettings")}</h3>
                                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                        {session.user.email}
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsModalOpen(false)}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"
                                aria-label={t("auth.cancel")}
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="space-y-3 px-5 py-5">
                            <label className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/60">
                                <Palette className="h-4 w-4 shrink-0 text-zinc-500" />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-xs font-semibold text-zinc-500">{t("auth.theme")}</span>
                                    <select
                                        value={theme}
                                        onChange={(e) => setTheme(e.target.value as "dark" | "light")}
                                        className="mt-1 w-full cursor-pointer bg-transparent text-sm font-semibold text-zinc-900 outline-none dark:text-zinc-100"
                                    >
                                        <option className="bg-white text-zinc-900" value="dark">{t("auth.darkTheme")}</option>
                                        <option className="bg-white text-zinc-900" value="light">{t("auth.lightTheme")}</option>
                                    </select>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/60">
                                <Languages className="h-4 w-4 shrink-0 text-zinc-500" />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-xs font-semibold text-zinc-500">{t("auth.language")}</span>
                                    <select
                                        value={language}
                                        onChange={(e) => setLanguage(e.target.value as "en" | "zh" | "ko")}
                                        className="mt-1 w-full cursor-pointer bg-transparent text-sm font-semibold text-zinc-900 outline-none dark:text-zinc-100"
                                    >
                                        <option className="bg-white text-zinc-900" value="en">{t("auth.languageEnglish")}</option>
                                        <option className="bg-white text-zinc-900" value="zh">{t("auth.languageChinese")}</option>
                                        <option className="bg-white text-zinc-900" value="ko">{t("auth.languageKorean")}</option>
                                    </select>
                                </span>
                            </label>

                            <label className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/60">
                                <Bot className="h-4 w-4 shrink-0 text-zinc-500" />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-xs font-semibold text-zinc-500">{t("auth.defaultModel")}</span>
                                    <select
                                        value={defaultModel}
                                        onChange={(e) => setDefaultModel(e.target.value)}
                                        className="mt-1 w-full cursor-pointer bg-transparent text-sm font-semibold text-zinc-900 outline-none dark:text-zinc-100"
                                    >
                                        {ENABLED_MODELS.map((model) => (
                                            <option className="bg-white text-zinc-900" key={model.id} value={model.id}>
                                                {model.icon} {model.name} Â· {model.tier}
                                            </option>
                                        ))}
                                    </select>
                                </span>
                            </label>

                            <button
                                type="button"
                                onClick={() => {
                                    window.location.href = "/api/conversations/export-all";
                                }}
                                className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-200 dark:hover:bg-zinc-800"
                            >
                                <Download className="h-4 w-4" />
                                {t("auth.downloadAllTxt")}
                            </button>
                        </div>

                        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                            <button
                                type="button"
                                onClick={() => setIsModalOpen(false)}
                                className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            >
                                {t("auth.cancel")}
                            </button>
                            <button
                                type="button"
                                onClick={handleSaveSettings}
                                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
                            >
                                <Check className="h-4 w-4" />
                                {t("auth.ok")}
                            </button>
                        </div>
                    </div>
                </div>
            )}
      </div>
    );
  }

  return (
    <button
      onClick={() => signIn()} 
      className="cursor-pointer w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-blue-950/20 transition-all hover:bg-blue-500"
    >
      {t("auth.login")}
    </button>
  );
}
