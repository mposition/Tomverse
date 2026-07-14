// components/auth/AuthButton.tsx
"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useCallback, useState, useEffect, useRef } from "react";
import {
    ENABLED_MODELS,
    getModelUsageProfile,
} from "@/components/chat/types";
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
import {
    getAnalyticsAttributionSnapshot,
    trackProductEvent,
} from "@/lib/productAnalyticsClient";
import { UpgradeInterestButton } from "@/components/marketing/UpgradeInterestButton";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";

export function AuthButton() {
  const { data: session, status } = useSession();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [activeSettingsTab, setActiveSettingsTab] = useState<"account" | "preferences" | "data" | "plan">("account");
    const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
    const settingsDialogRef = useRef<HTMLDivElement | null>(null);

    const { t, lang: globalLang, setLang: setGlobalLang } = useLanguage();
    const chatCallbackUrl = withChatLanguage("/chat", globalLang);
    const formatCopy = (key: string, values: Record<string, string>) =>
        Object.entries(values).reduce(
            (text, [name, value]) => text.replaceAll(`{${name}}`, value),
            t(key)
        );

    const [theme, setTheme] = useState<"dark" | "light">(APP_DEFAULTS.defaultTheme);
    const [language, setLanguage] = useState<Language>(APP_DEFAULTS.defaultLanguage);
    const [defaultModel, setDefaultModel] = useState<string>(APP_DEFAULTS.defaultModelId);
    const [isDeletingChats, setIsDeletingChats] = useState(false);
    const [isDeleteAllArmed, setIsDeleteAllArmed] = useState(false);
    const [isRequestingDeletion, setIsRequestingDeletion] = useState(false);
    const [isAccountDeleteArmed, setIsAccountDeleteArmed] = useState(false);
    const [accountDeletionConsent, setAccountDeletionConsent] = useState(false);
    const [isRequestingRefund, setIsRequestingRefund] = useState(false);
    const [isCancellingSubscription, setIsCancellingSubscription] = useState(false);
    const [subscriptionCancelAtPeriodEnd, setSubscriptionCancelAtPeriodEnd] = useState(false);
    const [refundReason, setRefundReason] = useState("");
    const [refundRequestedAt, setRefundRequestedAt] = useState<string | null>(() => {
        if (typeof window === "undefined") return null;
        return localStorage.getItem("tomverse_refund_requested_at");
    });
    const accountUsage = useUserUsage(Boolean(session?.user));
    const accountPlan = accountUsage?.plan || null;
    const planPeriodEnd = accountUsage?.subscription?.currentPeriodEnd;
    const planPeriodEndLabel = planPeriodEnd
        ? new Intl.DateTimeFormat(globalLang, {
            year: "numeric",
            month: "short",
            day: "numeric",
        }).format(new Date(planPeriodEnd))
        : null;
    const billingIntervalLabel =
        accountUsage?.subscription?.billingInterval === "annual"
            ? t("billing.intervalAnnual")
            : accountUsage?.subscription?.billingInterval === "monthly"
                ? t("billing.intervalMonthly")
                : null;
    const mobileUpgradePlan =
        accountPlan === "Pro" ? "Max" : accountPlan === "Max" ? null : "Pro";

    useEffect(() => {
        queueMicrotask(() => {
            setSubscriptionCancelAtPeriodEnd(Boolean(accountUsage?.subscription?.cancelAtPeriodEnd));
        });
    }, [accountUsage?.subscription?.cancelAtPeriodEnd]);

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

            fetch("/api/billing/refund-request")
                .then((res) => (res.ok ? res.json() : null))
                .then(
                    (
                        data: {
                            pendingRequest?: {
                                requestedAt?: string;
                            } | null;
                        } | null
                    ) => {
                        const requestedAt = data?.pendingRequest?.requestedAt || null;
                        if (requestedAt) {
                            localStorage.setItem("tomverse_refund_requested_at", requestedAt);
                            setRefundRequestedAt(requestedAt);
                            return;
                        }
                        localStorage.removeItem("tomverse_refund_requested_at");
                        setRefundRequestedAt(null);
                    }
                )
                .catch(() => undefined);
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

    const handleDeleteAccount = async () => {
        if (isRequestingDeletion) return;
        if (!accountDeletionConsent) {
            dispatchAppToast(t("auth.deleteAccountConsentRequired"), "error");
            return;
        }
        if (!isAccountDeleteArmed) {
            setIsAccountDeleteArmed(true);
            dispatchAppToast(t("auth.deleteAccountSecondConfirm"), "info");
            return;
        }
        setIsRequestingDeletion(true);
        try {
            const response = await fetch("/api/user/account", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm: true }),
            });
            if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
            localStorage.removeItem("tomverse_refund_requested_at");
            dispatchAppToast(t("auth.deleteAccountSuccess"), "success");
            await signOut({ callbackUrl: chatCallbackUrl });
        } catch {
            dispatchAppToast(t("auth.deleteAccountFailed"), "error");
        } finally {
            setIsRequestingDeletion(false);
        }
    };

    const handleRequestRefund = async () => {
        if (isRequestingRefund) return;
        setIsRequestingRefund(true);
        try {
            const response = await fetch("/api/billing/refund-request", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason: refundReason }),
            });
            const data = (await response.json().catch(() => null)) as
                | { error?: string; requestedAt?: string }
                | null;
            if (!response.ok) {
                throw new Error(data?.error || "Refund request failed");
            }
            const requestedAt = data?.requestedAt || new Date().toISOString();
            localStorage.setItem("tomverse_refund_requested_at", requestedAt);
            setRefundRequestedAt(requestedAt);
            setRefundReason("");
            dispatchAppToast(t("auth.refundRequestSuccess"), "success");
        } catch (error) {
            dispatchAppToast(
                error instanceof Error ? error.message : t("auth.refundRequestFailed"),
                "error"
            );
        } finally {
            setIsRequestingRefund(false);
        }
    };

    const handleCancelSubscription = async () => {
        if (isCancellingSubscription || subscriptionCancelAtPeriodEnd) return;
        setIsCancellingSubscription(true);
        try {
            const response = await fetch("/api/billing/cancel-subscription", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    analytics: getAnalyticsAttributionSnapshot() || undefined,
                }),
            });
            const data = (await response.json().catch(() => null)) as
                | { error?: string; currentPeriodEnd?: string | null }
                | null;
            if (!response.ok) {
                throw new Error(data?.error || "Subscription cancellation failed");
            }
            setSubscriptionCancelAtPeriodEnd(true);
            dispatchAppToast(
                data?.currentPeriodEnd
                    ? formatCopy("auth.cancelPlanToastUntil", {
                        date: new Date(data.currentPeriodEnd).toLocaleDateString(globalLang),
                    })
                    : t("auth.cancelPlanToastPeriodEnd"),
                "success"
            );
        } catch (error) {
            dispatchAppToast(
                error instanceof Error ? error.message : t("auth.cancelPlanFailed"),
                "error"
            );
        } finally {
            setIsCancellingSubscription(false);
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
                            <nav className="grid grid-cols-2 gap-2 border-b border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/50 sm:grid-cols-4 md:flex md:flex-col md:overflow-visible md:border-b-0 md:border-r">
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
                                            className={`flex min-w-0 items-center justify-center gap-2 rounded-xl px-3 py-2 text-center text-sm font-semibold transition-colors md:justify-start md:text-left ${
                                                isActive
                                                    ? "bg-white text-blue-600 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-blue-400 dark:ring-zinc-800"
                                                    : "text-zinc-500 hover:bg-white hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
                                            }`}
                                        >
                                            <Icon className="h-4 w-4 shrink-0" />
                                            <span className="truncate">{item.label}</span>
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
                                                    {ENABLED_MODELS.map((model) => {
                                                        const usageProfile = getModelUsageProfile(model);
                                                        return (
                                                            <option className="bg-white text-zinc-900" key={model.id} value={model.id}>
                                                                {model.icon} {model.name} · {t(`modelUsageClasses.${usageProfile.category.toLowerCase()}`)} · {usageProfile.credits}
                                                            </option>
                                                        );
                                                    })}
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
                                                disabled={accountUsage?.limits.allowDownloads === false}
                                                title={accountUsage?.limits.allowDownloads === false ? t("modelStatusReasons.upgradeRequired") : ""}
                                                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
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
                                                <div className="rounded-xl border border-red-300 bg-white p-3 dark:border-red-900/70 dark:bg-red-950/30 sm:col-span-2">
                                                    <p className="text-sm font-black text-red-700 dark:text-red-200">
                                                        {t("auth.deleteAccountImmediateTitle")}
                                                    </p>
                                                    <p className="mt-1 text-xs leading-5 text-red-700/80 dark:text-red-100/80">
                                                        {t("auth.deleteAccountImmediateDescription")}
                                                    </p>
                                                    <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
                                                        <input
                                                            type="checkbox"
                                                            checked={accountDeletionConsent}
                                                            onChange={(event) => {
                                                                setAccountDeletionConsent(event.target.checked);
                                                                setIsAccountDeleteArmed(false);
                                                            }}
                                                            className="mt-0.5 h-4 w-4 cursor-pointer accent-red-600"
                                                        />
                                                        <span>
                                                            {t("auth.deleteAccountConsent")}
                                                        </span>
                                                    </label>
                                                    <button
                                                        type="button"
                                                        onClick={handleDeleteAccount}
                                                        disabled={isRequestingDeletion || !accountDeletionConsent}
                                                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-red-300 bg-red-600 px-3 py-3 text-sm font-black text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                        {isRequestingDeletion
                                                            ? t("auth.deletingAccount")
                                                            : isAccountDeleteArmed
                                                                ? t("auth.confirmPermanentDelete")
                                                                : t("auth.deleteAccount")}
                                                    </button>
                                                </div>
                                            </div>
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
                                            {(planPeriodEndLabel || billingIntervalLabel) && (
                                                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                                    {billingIntervalLabel && (
                                                        <div className="rounded-xl border border-blue-200 bg-white/70 px-3 py-2 text-xs font-semibold text-blue-700 dark:border-blue-900/60 dark:bg-zinc-950/50 dark:text-blue-200">
                                                            <span className="block text-[11px] uppercase tracking-wide opacity-70">
                                                                {t("auth.billingInterval")}
                                                            </span>
                                                            {billingIntervalLabel}
                                                        </div>
                                                    )}
                                                    {planPeriodEndLabel && (
                                                        <div className="rounded-xl border border-blue-200 bg-white/70 px-3 py-2 text-xs font-semibold text-blue-700 dark:border-blue-900/60 dark:bg-zinc-950/50 dark:text-blue-200">
                                                            <span className="block text-[11px] uppercase tracking-wide opacity-70">
                                                                {t("share.expires")}
                                                            </span>
                                                            {planPeriodEndLabel}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </section>
                                        {(accountPlan === "Pro" || accountPlan === "Max") && (
                                            <div className="grid gap-4 lg:grid-cols-2">
                                                <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900/60 dark:bg-blue-950/20">
                                                    <h4 className="text-sm font-bold text-blue-800 dark:text-blue-200">
                                                        {t("auth.cancelPlanTitle")}
                                                    </h4>
                                                    <p className="mt-1 text-sm leading-6 text-blue-800/80 dark:text-blue-100/80">
                                                        {formatCopy("auth.cancelPlanDescription", {
                                                            date: planPeriodEndLabel || t("auth.cancelPlanFallbackDate"),
                                                        })}
                                                    </p>
                                                    <button
                                                        type="button"
                                                        onClick={handleCancelSubscription}
                                                        disabled={isCancellingSubscription || subscriptionCancelAtPeriodEnd}
                                                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-blue-300 bg-white px-3 py-3 text-sm font-black text-blue-700 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100 dark:hover:bg-blue-950/70"
                                                    >
                                                        <CreditCard className="h-4 w-4" />
                                                        {subscriptionCancelAtPeriodEnd
                                                            ? t("auth.cancelPlanButtonScheduled")
                                                            : isCancellingSubscription
                                                                ? t("auth.cancelPlanProcessing")
                                                                : t("auth.cancelPlanButton")}
                                                    </button>
                                                    {subscriptionCancelAtPeriodEnd && (
                                                        <p className="mt-2 text-xs font-semibold text-blue-800 dark:text-blue-100">
                                                            {t("auth.cancelPlanNotice")}
                                                        </p>
                                                    )}
                                                </section>

                                                <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20">
                                                    <h4 className="text-sm font-bold text-amber-800 dark:text-amber-200">
                                                        {t("auth.refundRequestTitle")}
                                                    </h4>
                                                    <p className="mt-1 text-sm leading-6 text-amber-800/80 dark:text-amber-100/80">
                                                        {t("auth.refundRequestDescription")}
                                                    </p>
                                                    <textarea
                                                        value={refundReason}
                                                        onChange={(event) => setRefundReason(event.target.value)}
                                                        maxLength={1000}
                                                        rows={3}
                                                        placeholder={t("auth.refundReasonPlaceholder")}
                                                        className="mt-3 w-full resize-none rounded-xl border border-amber-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-amber-500 focus:ring-4 focus:ring-amber-500/10 dark:border-amber-900/60 dark:bg-zinc-950 dark:text-zinc-100"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={handleRequestRefund}
                                                        disabled={isRequestingRefund || Boolean(refundRequestedAt)}
                                                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-amber-300 bg-white px-3 py-3 text-sm font-black text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-950/70"
                                                    >
                                                        <LifeBuoy className="h-4 w-4" />
                                                        {refundRequestedAt
                                                            ? t("auth.refundRequested")
                                                            : isRequestingRefund
                                                                ? t("auth.refundRequesting")
                                                                : t("auth.requestRefund")}
                                                    </button>
                                                    {refundRequestedAt && (
                                                        <p className="mt-2 text-xs font-semibold text-amber-800 dark:text-amber-100">
                                                            {t("auth.refundRequestedAt")}: {new Date(refundRequestedAt).toLocaleDateString(globalLang)}
                                                        </p>
                                                    )}
                                                </section>
                                            </div>
                                        )}
                                        {accountUsage && (
                                            <section className="grid gap-3 sm:grid-cols-2">
                                                <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                                    <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">{t("usage.todayCredits")}</p>
                                                    <p className="mt-2 text-lg font-black text-zinc-900 dark:text-zinc-100">
                                                        {accountUsage.limits.creditsDay <= 0
                                                            ? t("usage.unlimited")
                                                            : `${accountUsage.usage.creditsDay}/${accountUsage.limits.creditsDay}`}
                                                    </p>
                                                </div>
                                                <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                                    <p className="text-xs font-bold uppercase tracking-wide text-zinc-400">{t("usage.monthCredits")}</p>
                                                    <p className="mt-2 text-lg font-black text-zinc-900 dark:text-zinc-100">
                                                        {accountUsage.usage.creditsMonth}/{accountUsage.limits.creditsMonth}
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

                        <div className="border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
                            {activeSettingsTab === "plan" && mobileUpgradePlan ? (
                                <div className="flex w-full flex-col gap-2 sm:hidden">
                                    <UpgradeInterestButton
                                        plan={mobileUpgradePlan}
                                        className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-black text-white transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
                                            mobileUpgradePlan === "Max"
                                                ? "bg-purple-600 hover:bg-purple-500"
                                                : "bg-blue-600 hover:bg-blue-500"
                                        }`}
                                    >
                                        <CreditCard className="h-4 w-4" />
                                        {mobileUpgradePlan === "Max"
                                            ? t("billing.joinMaxWaitlist")
                                            : t("billing.joinProWaitlist")}
                                    </UpgradeInterestButton>
                                    <button
                                        type="button"
                                        onClick={handleSaveSettings}
                                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
                                    >
                                        <Check className="h-4 w-4" />
                                        {t("auth.ok")}
                                    </button>
                                </div>
                            ) : null}
                            <div
                                className={`justify-end gap-2 ${
                                    activeSettingsTab === "plan" && mobileUpgradePlan
                                        ? "hidden sm:flex"
                                        : "flex"
                                }`}
                            >
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
        onClick={() => {
          trackProductEvent("cta_start_click", 0, {
            cta_location: "account_login",
          });
          void signIn(undefined, { callbackUrl: chatCallbackUrl });
        }}
        className="cursor-pointer w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-blue-950/20 transition-all hover:bg-blue-500"
      >
        {t("auth.login")}
      </button>
    </div>
  );
}
