// components/auth/AuthButton.tsx
"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useCallback, useState, useEffect, useRef } from "react";
import { ENABLED_MODELS } from "@/components/chat/types";
import {
    Bot,
    Check,
    CreditCard,
    Database,
    Download,
    LifeBuoy,
    Languages,
    LogOut,
    Palette,
    ShieldCheck,
    Settings,
    Trash2,
    UserRound,
    X,
} from "lucide-react";
import {
    useLanguage,
    type Language,
} from "@/components/LanguageProvider";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { dispatchAppToast } from "@/lib/appToast";
import { notifyUserSettingsUpdated } from "@/lib/userSettingsEvents";
import { useUserUsage } from "@/components/chat/useUserUsage";
import { UpgradeInterestButton } from "@/components/marketing/UpgradeInterestButton";

export function AuthButton() {
  const { data: session, status } = useSession();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [activeSettingsTab, setActiveSettingsTab] = useState<"account" | "preferences" | "data" | "plan">("account");
    const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
    const settingsDialogRef = useRef<HTMLDivElement | null>(null);

    const { t, lang: globalLang, setLang: setGlobalLang } = useLanguage();

    const [theme, setTheme] = useState<"dark" | "light">(APP_DEFAULTS.defaultTheme);
    const [language, setLanguage] = useState<Language>(APP_DEFAULTS.defaultLanguage);
    const [defaultModel, setDefaultModel] = useState<string>(APP_DEFAULTS.defaultModelId);
    const [isDeletingChats, setIsDeletingChats] = useState(false);
    const [isDeleteAllArmed, setIsDeleteAllArmed] = useState(false);
    const [isRequestingDeletion, setIsRequestingDeletion] = useState(false);
    const [accountDeletionRequestedAt, setAccountDeletionRequestedAt] = useState<string | null>(() => {
        if (typeof window === "undefined") return null;
        return localStorage.getItem("tomverse_account_deletion_requested_at");
    });
    const accountUsage = useUserUsage(Boolean(session?.user));
    const accountPlan = accountUsage?.plan || null;

    const closeSettingsModal = useCallback(() => {
        setIsModalOpen(false);
        requestAnimationFrame(() => settingsButtonRef.current?.focus());
    }, []);

    const getSettingsFocusableElements = useCallback(() => {
        const dialog = settingsDialogRef.current;
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

    useEffect(() => {
        if (!isModalOpen) return;

        const animationFrame = requestAnimationFrame(() => {
            getSettingsFocusableElements()[0]?.focus();
        });

        return () => cancelAnimationFrame(animationFrame);
    }, [getSettingsFocusableElements, isModalOpen]);

    useEffect(() => {
        if (!isModalOpen) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeSettingsModal();
                return;
            }

            if (event.key !== "Tab") return;

            const focusableElements = getSettingsFocusableElements();
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
    }, [closeSettingsModal, getSettingsFocusableElements, isModalOpen]);

    const handleSaveSettings = async () => {
        try {
            const res = await fetch("/api/user/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ theme, language, defaultModel }),
            });

            if (res.ok) {
                closeSettingsModal();
                dispatchAppToast(t("auth.saveMessage"), "success");

                setGlobalLang(language);

                if (theme === "light") {
                    document.documentElement.classList.remove("dark");
                } else {
                    document.documentElement.classList.add("dark");
                }

                notifyUserSettingsUpdated({ defaultModel });
            } else {
                dispatchAppToast(t("auth.failedMessage"), "error");
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleDeleteAllConversations = async () => {
        if (isDeletingChats) return;
        if (!isDeleteAllArmed) {
            setIsDeleteAllArmed(true);
            dispatchAppToast(t("auth.deleteAllChatsConfirm"), "info");
            return;
        }
        setIsDeletingChats(true);
        try {
            const response = await fetch("/api/conversations", { method: "DELETE" });
            if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
            dispatchAppToast(t("auth.deleteAllChatsSuccess"), "success");
            window.location.href = "/chat";
        } catch {
            dispatchAppToast(t("auth.deleteAllChatsFailed"), "error");
        } finally {
            setIsDeletingChats(false);
            setIsDeleteAllArmed(false);
        }
    };

    const handleRequestAccountDeletion = async () => {
        if (isRequestingDeletion) return;
        setIsRequestingDeletion(true);
        try {
            const response = await fetch("/api/feedback", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    type: "other",
                    message: t("auth.accountDeletionRequestMessage"),
                    path: window.location.pathname,
                    userAgent: navigator.userAgent,
                }),
            });
            if (!response.ok) throw new Error(`Request failed: ${response.status}`);
            const requestedAt = new Date().toISOString();
            localStorage.setItem("tomverse_account_deletion_requested_at", requestedAt);
            setAccountDeletionRequestedAt(requestedAt);
            dispatchAppToast(t("auth.accountDeletionRequested"), "success");
        } catch {
            dispatchAppToast(t("feedback.failed"), "error");
        } finally {
            setIsRequestingDeletion(false);
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
      <div className="relative flex w-full flex-col gap-3 rounded-3xl border border-zinc-200 bg-white p-3 shadow-sm ring-1 ring-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:ring-zinc-900">
        <span className={`absolute right-3 top-3 rounded-full px-2.5 py-1 text-xs font-black ${accountPlan === "Free" || !accountPlan ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : accountPlan === "Pro" ? "bg-blue-500/10 text-blue-600 dark:text-blue-300" : "bg-purple-500/10 text-purple-600 dark:text-purple-300"}`}>
          {accountPlan ? t(`modelTiers.${accountPlan.toLowerCase()}`) : t("auth.loading")}
        </span>
        <div className="flex min-w-0 items-center gap-3 pr-12">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-teal-600 text-lg font-black text-white ring-1 ring-teal-400/50 dark:bg-teal-700 dark:ring-teal-400/40">
            {session.user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.user.image}
                alt={t("auth.profileImage")}
                className="h-full w-full object-cover"
              />
            ) : (
              (session.user.email?.[0] || "T").toUpperCase()
            )}
          </span>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400">{t("auth.signedAs")}</span>
            <span className="truncate text-sm font-black text-zinc-800 dark:text-zinc-100">
              {session.user.email}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
            <button
                ref={settingsButtonRef}
                type="button"
                onClick={() => setIsModalOpen(true)}
                className="flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 text-xs font-black text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
                <Settings className="h-3.5 w-3.5" />
                {t("auth.setting")}
            </button>
            <button
                type="button"
                onClick={() => signOut()}
                className="flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 text-xs font-black text-zinc-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-red-950/30 dark:hover:text-red-300"
            >
                <LogOut className="h-3.5 w-3.5" />
                {t("auth.singedOut")}
            </button>
        </div>

            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
                    <div
                        ref={settingsDialogRef}
                        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="user-settings-title"
                    >
                        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
                            <div className="flex min-w-0 items-center gap-3">
                                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500">
                                    <Settings className="h-5 w-5" />
                                </span>
                                <div>
                                    <h3 id="user-settings-title" className="text-base font-bold">{t("auth.userSettings")}</h3>
                                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                                        {session.user.email}
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={closeSettingsModal}
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"
                                aria-label={t("auth.cancel")}
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[13rem_1fr]">
                            <nav className="flex gap-2 overflow-x-auto border-b border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/50 md:flex-col md:overflow-visible md:border-b-0 md:border-r">
                                {[
                                    { id: "account", label: t("auth.accountTab"), icon: UserRound },
                                    { id: "preferences", label: t("auth.preferencesTab"), icon: Palette },
                                    { id: "data", label: t("auth.dataTab"), icon: Database },
                                    { id: "plan", label: t("auth.planTab"), icon: CreditCard },
                                ].map((item) => {
                                    const Icon = item.icon;
                                    const isActive = activeSettingsTab === item.id;
                                    return (
                                        <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => setActiveSettingsTab(item.id as typeof activeSettingsTab)}
                                            aria-pressed={isActive}
                                            className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold transition-colors ${
                                                isActive
                                                    ? "bg-white text-blue-600 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-blue-400 dark:ring-zinc-800"
                                                    : "text-zinc-500 hover:bg-white hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                                            }`}
                                        >
                                            <Icon className="h-4 w-4" />
                                            {item.label}
                                        </button>
                                    );
                                })}
                            </nav>

                            <div className="min-h-0 overflow-y-auto px-5 py-5">
                                {activeSettingsTab === "account" && (
                                    <div className="space-y-4">
                                        <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                            <div className="flex items-center gap-3">
                                                <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700">
                                                    {session.user.image ? (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img
                                                            src={session.user.image}
                                                            alt={t("auth.profileImage")}
                                                            className="h-full w-full object-cover"
                                                        />
                                                    ) : (
                                                        <UserRound className="h-5 w-5" />
                                                    )}
                                                </span>
                                                <div className="min-w-0">
                                                    <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">{t("auth.signedAs")}</p>
                                                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{session.user.email}</p>
                                                </div>
                                            </div>
                                        </section>
                                        <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                            <div className="flex items-start gap-3">
                                                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                                                <div>
                                                    <h4 className="text-sm font-bold">{t("auth.securityStatus")}</h4>
                                                    <p className="mt-1 text-sm leading-6 text-zinc-500">{t("auth.securityStatusDescription")}</p>
                                                </div>
                                            </div>
                                        </section>
                                    </div>
                                )}

                                {activeSettingsTab === "preferences" && (
                                    <div className="space-y-3">
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
                                                    onChange={(e) => setLanguage(e.target.value as Language)}
                                                    className="mt-1 w-full cursor-pointer bg-transparent text-sm font-semibold text-zinc-900 outline-none dark:text-zinc-100"
                                                >
                                                    <option className="bg-white text-zinc-900" value="en">{t("auth.languageEnglish")}</option>
                                                    <option className="bg-white text-zinc-900" value="zh">{t("auth.languageChinese")}</option>
                                                    <option className="bg-white text-zinc-900" value="ko">{t("auth.languageKorean")}</option>
                                                    <option className="bg-white text-zinc-900" value="fr">{t("auth.languageFrench")}</option>
                                                    <option className="bg-white text-zinc-900" value="de">{t("auth.languageGerman")}</option>
                                                    <option className="bg-white text-zinc-900" value="es">{t("auth.languageSpanish")}</option>
                                                    <option className="bg-white text-zinc-900" value="pt">{t("auth.languagePortuguese")}</option>
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
                                                            {model.icon} {model.name} · {t(`modelTiers.${model.tier.toLowerCase()}`)}
                                                        </option>
                                                    ))}
                                                </select>
                                            </span>
                                        </label>
                                    </div>
                                )}

                                {activeSettingsTab === "data" && (
                                    <div className="space-y-4">
                                        <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                            <h4 className="text-sm font-bold">{t("auth.dataExportTitle")}</h4>
                                            <p className="mt-1 text-sm leading-6 text-zinc-500">{t("auth.dataExportDescription")}</p>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    window.location.href = "/api/conversations/export-all";
                                                }}
                                                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                            >
                                                <Download className="h-4 w-4" />
                                                {t("auth.downloadAllTxt")}
                                            </button>
                                        </section>
                                        <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                            <h4 className="text-sm font-bold">{t("auth.dataRetentionTitle")}</h4>
                                            <p className="mt-1 text-sm leading-6 text-zinc-500">{t("auth.dataRetentionDescription")}</p>
                                            <p className="mt-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-200">
                                                {t("auth.attachmentRetentionNotice")}
                                            </p>
                                        </section>
                                        <section className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-950/70 dark:bg-red-950/20">
                                            <h4 className="text-sm font-bold text-red-700 dark:text-red-300">{t("auth.dangerZone")}</h4>
                                            <p className="mt-1 text-sm leading-6 text-red-700/80 dark:text-red-200/80">{t("auth.dangerZoneDescription")}</p>
                                            <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                                <button
                                                    type="button"
                                                    onClick={handleDeleteAllConversations}
                                                    disabled={isDeletingChats}
                                                    className="flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-3 py-3 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/70"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                    {isDeletingChats
                                                        ? t("auth.deleting")
                                                        : isDeleteAllArmed
                                                            ? t("auth.confirmDeleteAllChats")
                                                            : t("auth.deleteAllChats")}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleRequestAccountDeletion}
                                                    disabled={isRequestingDeletion}
                                                    className="flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                                >
                                                    <LifeBuoy className="h-4 w-4" />
                                                    {isRequestingDeletion ? t("feedback.sending") : t("auth.requestAccountDeletion")}
                                                </button>
                                            </div>
                                            {accountDeletionRequestedAt && (
                                                <p className="mt-3 rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
                                                    {t("auth.accountDeletionPending")} {new Date(accountDeletionRequestedAt).toLocaleDateString()}
                                                </p>
                                            )}
                                        </section>
                                    </div>
                                )}

                                {activeSettingsTab === "plan" && (
                                    <div className="space-y-4">
                                        <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900/60 dark:bg-blue-950/20">
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <p className="text-xs font-bold uppercase tracking-wide text-blue-500">{t("auth.currentPlan")}</p>
                                                    <h4 className="mt-1 text-lg font-bold text-zinc-900 dark:text-zinc-100">
                                                        {accountPlan ? t(`auth.${accountPlan.toLowerCase()}Plan`) : t("auth.loading")}
                                                    </h4>
                                                </div>
                                                <span className={`rounded-full px-3 py-1 text-xs font-bold text-white ${accountPlan === "Free" ? "bg-emerald-600" : accountPlan === "Pro" ? "bg-blue-600" : accountPlan === "Max" ? "bg-purple-600" : "bg-zinc-600"}`}>
                                                    {accountPlan ? t(`modelTiers.${accountPlan.toLowerCase()}`) : t("auth.loading")}
                                                </span>
                                            </div>
                                            <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                                                {accountPlan ? t(`sidebar.${accountPlan.toLowerCase()}PlanDescription`) : t("auth.loading")}
                                            </p>
                                        </section>
                                        {accountUsage && (
                                            <section className="grid gap-3 sm:grid-cols-2">
                                                <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                                    <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">{t("usage.todayMessages")}</p>
                                                    <p className="mt-2 text-lg font-black text-zinc-900 dark:text-zinc-100">
                                                        {accountUsage.limits.messagesDay <= 0
                                                            ? t("usage.unlimited")
                                                            : `${accountUsage.usage.messagesDay}/${accountUsage.limits.messagesDay}`}
                                                    </p>
                                                </div>
                                                <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                                    <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">{t("usage.monthMessages")}</p>
                                                    <p className="mt-2 text-lg font-black text-zinc-900 dark:text-zinc-100">
                                                        {accountUsage.usage.messagesMonth}/{accountUsage.limits.messagesMonth}
                                                    </p>
                                                </div>
                                            </section>
                                        )}
                                        <section className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm leading-6 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/60">
                                            <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{t("auth.planPolicyTitle")}</h4>
                                            <ul className="mt-2 list-disc space-y-1 pl-5">
                                                <li>{t("auth.planPolicyGuest")}</li>
                                                <li>{t("auth.planPolicyFree")}</li>
                                                <li>{t("auth.planPolicyPro")}</li>
                                                <li>{t("auth.planPolicyMax")}</li>
                                            </ul>
                                        </section>
                                        <div className="grid gap-2 sm:grid-cols-2">
                                            <UpgradeInterestButton
                                                plan="Pro"
                                                className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-3 text-sm font-black text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
                                            >
                                                <CreditCard className="h-4 w-4" />
                                                {t("billing.joinProWaitlist")}
                                            </UpgradeInterestButton>
                                            <UpgradeInterestButton
                                                plan="Max"
                                                className="flex w-full items-center justify-center gap-2 rounded-xl border border-purple-300 bg-purple-50 px-3 py-3 text-sm font-black text-purple-700 transition-colors hover:bg-purple-100 disabled:cursor-not-allowed disabled:opacity-70 dark:border-purple-900/60 dark:bg-purple-950/30 dark:text-purple-200 dark:hover:bg-purple-950/50"
                                            >
                                                <CreditCard className="h-4 w-4" />
                                                {t("billing.joinMaxWaitlist")}
                                            </UpgradeInterestButton>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                            <button
                                type="button"
                                onClick={closeSettingsModal}
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
    <div className="flex w-full flex-col gap-2">
      <label className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-300">
        <Languages className="h-4 w-4 shrink-0 text-zinc-400" />
        <span className="sr-only">{t("auth.language")}</span>
        <select
          value={globalLang}
          onChange={(event) => setGlobalLang(event.target.value as Language)}
          className="min-w-0 flex-1 cursor-pointer bg-transparent text-xs font-semibold outline-none"
        >
          <option className="bg-white text-zinc-900" value="en">
            {t("auth.languageEnglish")}
          </option>
          <option className="bg-white text-zinc-900" value="zh">
            {t("auth.languageChinese")}
          </option>
          <option className="bg-white text-zinc-900" value="ko">
            {t("auth.languageKorean")}
          </option>
          <option className="bg-white text-zinc-900" value="fr">
            {t("auth.languageFrench")}
          </option>
          <option className="bg-white text-zinc-900" value="de">
            {t("auth.languageGerman")}
          </option>
          <option className="bg-white text-zinc-900" value="es">
            {t("auth.languageSpanish")}
          </option>
          <option className="bg-white text-zinc-900" value="pt">
            {t("auth.languagePortuguese")}
          </option>
        </select>
      </label>
      <button
        onClick={() => signIn(undefined, { callbackUrl: "/chat" })}
        className="cursor-pointer w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-blue-950/20 transition-all hover:bg-blue-500"
      >
        {t("auth.login")}
      </button>
    </div>
  );
}
