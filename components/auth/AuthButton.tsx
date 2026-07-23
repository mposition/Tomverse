// components/auth/AuthButton.tsx
"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import {
    getModelUsageProfile,
} from "@/components/chat/types";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import {
    Bot,
    BarChart3,
    Check,
    ChevronDown,
    Clock3,
    CreditCard,
    Crown,
    Database,
    Download,
    KeyRound,
    LifeBuoy,
    Languages,
    LogOut,
    Mail,
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
import { localeLaunchPolicy } from "@/lib/localeLaunchPolicy";
import { dispatchAppToast } from "@/lib/appToast";
import { notifyUserSettingsUpdated } from "@/lib/userSettingsEvents";
import {
    notifyUserUsageChanged,
    useUserUsage,
} from "@/components/chat/useUserUsage";
import {
    getAnalyticsAttributionSnapshot,
    trackProductEvent,
} from "@/lib/productAnalyticsClient";
import { UpgradeInterestButton } from "@/components/marketing/UpgradeInterestButton";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";
import { openModelFinder } from "@/lib/modelFinderEvents";
import { CreditPackPurchaseButton } from "@/components/billing/CreditPackPurchaseButton";
import { UpgradeCtaLink } from "@/components/billing/UpgradeCtaLink";
import {
    isThemePreference,
    storeAndApplyThemePreference,
    type ThemePreference,
} from "@/lib/theme";
import { openAnalyticsPreferences } from "@/lib/analyticsPreferencesEvents";
import {
    ACCOUNT_SETTINGS_OPEN_EVENT,
    type AccountSettingsTab,
} from "@/lib/accountSettingsEvents";

type LoginMethod =
    | { type: "oauth"; provider: "google" | "azure-ad"; linked: boolean }
    | { type: "email"; address: string; enabled: boolean };

export function AuthButton({
    showAnalyticsCookieButton = false,
}: {
    // Guests have no account menu to reach analytics preferences from, so
    // the mobile shell (which drops the floating settings button to
    // declutter the screen) passes this to put an inline substitute right
    // next to the guest login button instead of removing the path entirely.
    showAnalyticsCookieButton?: boolean;
} = {}) {
    const { enabledModels: ENABLED_MODELS } = useModelCatalog();
  const { data: session, status } = useSession();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
    const [activeSettingsTab, setActiveSettingsTab] = useState<"account" | "preferences" | "data" | "plan">("account");
    const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
    const settingsDialogRef = useRef<HTMLDivElement | null>(null);
    const accountMenuRef = useRef<HTMLDivElement | null>(null);
    const accountMenuButtonRef = useRef<HTMLButtonElement | null>(null);

    const { t, lang: globalLang, setLang: setGlobalLang } = useLanguage();
    const chatCallbackUrl = withChatLanguage("/chat", globalLang);
    const formatCopy = (key: string, values: Record<string, string>) =>
        Object.entries(values).reduce(
            (text, [name, value]) => text.replaceAll(`{${name}}`, value),
            t(key)
        );

    const [theme, setTheme] = useState<ThemePreference>(APP_DEFAULTS.defaultTheme);
    const [language, setLanguage] = useState<Language>(APP_DEFAULTS.defaultLanguage);
    const [defaultModel, setDefaultModel] = useState<string>(APP_DEFAULTS.defaultModelId);
    const [timeZone, setTimeZone] = useState("UTC");
    const [timeZoneChangeAllowedAt, setTimeZoneChangeAllowedAt] = useState<string | null>(null);
    const [timeZoneChangeLocked, setTimeZoneChangeLocked] = useState(false);
    const [isDeletingChats, setIsDeletingChats] = useState(false);
    const [isDeleteAllArmed, setIsDeleteAllArmed] = useState(false);
    const [isRequestingDeletion, setIsRequestingDeletion] = useState(false);
    const [isAccountDeleteArmed, setIsAccountDeleteArmed] = useState(false);
    const [accountDeletionConsent, setAccountDeletionConsent] = useState(false);
    const [accountDeletionConfirmation, setAccountDeletionConfirmation] = useState("");
    const [isDeleteAccountModalOpen, setIsDeleteAccountModalOpen] = useState(false);
    const [loginMethods, setLoginMethods] = useState<LoginMethod[]>([]);
    const [canRemoveLoginMethod, setCanRemoveLoginMethod] = useState(false);
    const [armedRemoveMethod, setArmedRemoveMethod] = useState<string | null>(null);
    const [isRemovingLoginMethod, setIsRemovingLoginMethod] = useState(false);
    const [isAddEmailModalOpen, setIsAddEmailModalOpen] = useState(false);
    const [addEmailCodeSent, setAddEmailCodeSent] = useState(false);
    const [addEmailCode, setAddEmailCode] = useState("");
    const [isSendingAddEmailCode, setIsSendingAddEmailCode] = useState(false);
    const [isVerifyingAddEmailCode, setIsVerifyingAddEmailCode] = useState(false);
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
    const dailyCreditsLimit = accountUsage?.limits.creditsDay || 0;
    const hasDailyCreditGuardrail = dailyCreditsLimit > 0;
    const dailyCreditsRemaining = hasDailyCreditGuardrail
        ? accountUsage?.balances.dailyRemainingCredits ?? Math.max(
            0,
            dailyCreditsLimit - (accountUsage?.usage.creditsDay || 0)
        )
        : null;
    const dailyCreditsResetLabel = accountUsage?.balances.dailyResetsAt
        ? new Intl.DateTimeFormat(globalLang, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: accountUsage?.timeZone || timeZone,
        }).format(new Date(accountUsage.balances.dailyResetsAt))
        : null;
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
        accountPlan === "Free" ? "Pro" : accountPlan === "Pro" ? "Max" : null;
    const timeZoneOptions = useMemo(() => {
        const intl = Intl as typeof Intl & {
            supportedValuesOf?: (key: "timeZone") => string[];
        };
        const supported = intl.supportedValuesOf?.("timeZone") || [];
        return Array.from(new Set(["UTC", timeZone, ...supported])).sort((a, b) =>
            a.localeCompare(b)
        );
    }, [timeZone]);
    const timeZoneChangeAllowedLabel = timeZoneChangeAllowedAt
        ? new Intl.DateTimeFormat(globalLang, {
              year: "numeric",
              month: "short",
              day: "numeric",
              timeZone,
          }).format(new Date(timeZoneChangeAllowedAt))
        : null;

    useEffect(() => {
        queueMicrotask(() => {
            setSubscriptionCancelAtPeriodEnd(Boolean(accountUsage?.subscription?.cancelAtPeriodEnd));
        });
    }, [accountUsage?.subscription?.cancelAtPeriodEnd]);

    const closeSettingsModal = useCallback(() => {
        setIsModalOpen(false);
        requestAnimationFrame(() => accountMenuButtonRef.current?.focus());
    }, []);

    const closeDeleteAccountModal = useCallback(() => {
        setIsDeleteAccountModalOpen(false);
        setIsAccountDeleteArmed(false);
        setAccountDeletionConsent(false);
        setAccountDeletionConfirmation("");
    }, []);

    const openSettingsTab = useCallback(
        (tab: "account" | "preferences" | "data" | "plan") => {
            setIsAccountMenuOpen(false);
            setActiveSettingsTab(tab);
            setIsModalOpen(true);
        },
        []
    );

    // Lets the collapsed sidebar rail's compact account button (which has no
    // room for the full settings modal) open this same modal remotely.
    useEffect(() => {
        const handleOpenAccountSettings = (event: Event) => {
            const tab = (event as CustomEvent<AccountSettingsTab>).detail || "account";
            openSettingsTab(tab);
        };
        window.addEventListener(ACCOUNT_SETTINGS_OPEN_EVENT, handleOpenAccountSettings);
        return () =>
            window.removeEventListener(ACCOUNT_SETTINGS_OPEN_EVENT, handleOpenAccountSettings);
    }, [openSettingsTab]);

    const fetchLoginMethods = useCallback(async () => {
        try {
            const response = await fetch("/api/user/login-methods");
            if (!response.ok) return;
            const data = await response.json();
            setLoginMethods(Array.isArray(data.methods) ? data.methods : []);
            setCanRemoveLoginMethod(Boolean(data.canRemove));
        } catch (error) {
            console.error("Failed to load login methods:", error);
        }
    }, []);

    useEffect(() => {
        if (isModalOpen && activeSettingsTab === "account" && session?.user) {
            queueMicrotask(() => {
                void fetchLoginMethods();
            });
        }
    }, [isModalOpen, activeSettingsTab, session?.user, fetchLoginMethods]);

    // Picks up the redirect from /api/user/login-methods/oauth/callback (the
    // custom OAuth-provider-linking flow) and surfaces a toast, since that
    // flow can't show one directly from a server redirect.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const params = new URLSearchParams(window.location.search);
        const linked = params.get("loginMethodLinked");
        const linkError = params.get("loginMethodLinkError");
        if (!linked && !linkError) return;

        if (linked) {
            dispatchAppToast(t("auth.loginMethodLinkedSuccess"), "success");
        } else if (linkError === "ALREADY_LINKED_ELSEWHERE") {
            dispatchAppToast(t("auth.loginMethodAlreadyLinkedElsewhere"), "error");
        } else {
            dispatchAppToast(t("auth.loginMethodLinkFailed"), "error");
        }
        params.delete("loginMethodLinked");
        params.delete("loginMethodLinkError");
        const nextSearch = params.toString();
        window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`
        );
        queueMicrotask(() => {
            setIsAccountMenuOpen(false);
            setActiveSettingsTab("account");
            setIsModalOpen(true);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleAddOAuthLoginMethod = useCallback((provider: "google" | "azure-ad") => {
        window.location.href = `/api/user/login-methods/oauth/start?provider=${provider}`;
    }, []);

    const handleRemoveLoginMethod = async (method: "google" | "azure-ad" | "email") => {
        if (isRemovingLoginMethod) return;
        if (armedRemoveMethod !== method) {
            setArmedRemoveMethod(method);
            dispatchAppToast(t("auth.confirmRemoveLoginMethod"), "info");
            return;
        }
        setIsRemovingLoginMethod(true);
        try {
            const response = await fetch("/api/user/login-methods", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ method }),
            });
            if (!response.ok) {
                if (response.status === 428) {
                    dispatchAppToast(t("auth.deleteAccountReauthRequired"), "error");
                    await signOut({
                        callbackUrl: `/auth/signin?callbackUrl=${encodeURIComponent(chatCallbackUrl)}`,
                    });
                    return;
                }
                if (response.status === 409) {
                    dispatchAppToast(t("auth.removeLoginMethodBlocked"), "error");
                    return;
                }
                if (response.status === 401) {
                    // A previous removal (this tab or another) already
                    // invalidated every session for this account, so this
                    // request never even reached the remove logic -- there's
                    // no live session left to keep working with.
                    dispatchAppToast(t("auth.removeLoginMethodSignedOut"), "info");
                    await signOut({
                        callbackUrl: `/auth/signin?callbackUrl=${encodeURIComponent(chatCallbackUrl)}`,
                    });
                    return;
                }
                throw new Error(`Remove failed: ${response.status}`);
            }
            // A successful removal (whether this request performed it or a
            // concurrent one beat it to it) just invalidated every session
            // for this account, including this browser's own. Sign out
            // immediately instead of making another authenticated call
            // (e.g. fetchLoginMethods) that would now 401 and look like the
            // removal itself failed.
            dispatchAppToast(t("auth.removeLoginMethodSuccess"), "success");
            await signOut({
                callbackUrl: `/auth/signin?callbackUrl=${encodeURIComponent(chatCallbackUrl)}`,
            });
        } catch {
            dispatchAppToast(t("auth.removeLoginMethodFailed"), "error");
        } finally {
            setIsRemovingLoginMethod(false);
            setArmedRemoveMethod(null);
        }
    };

    const closeAddEmailModal = useCallback(() => {
        setIsAddEmailModalOpen(false);
        setAddEmailCodeSent(false);
        setAddEmailCode("");
    }, []);

    const handleRequestAddEmailCode = async () => {
        if (isSendingAddEmailCode) return;
        setIsSendingAddEmailCode(true);
        try {
            const response = await fetch("/api/user/login-methods/email/request", {
                method: "POST",
            });
            if (!response.ok) throw new Error(`Request failed: ${response.status}`);
            setAddEmailCodeSent(true);
            dispatchAppToast(t("auth.emailLoginCodeSentTitle"), "info");
        } catch {
            dispatchAppToast(t("auth.emailLoginRequestFailed"), "error");
        } finally {
            setIsSendingAddEmailCode(false);
        }
    };

    const handleVerifyAddEmailCode = async () => {
        if (isVerifyingAddEmailCode || addEmailCode.trim().length !== 6) return;
        setIsVerifyingAddEmailCode(true);
        try {
            const response = await fetch("/api/user/login-methods/email/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: addEmailCode.trim() }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.ok) {
                dispatchAppToast(
                    data?.code === "EMAIL_CODE_LOCKED"
                        ? t("auth.emailLoginLocked")
                        : t("auth.emailLoginInvalidCode"),
                    "error"
                );
                return;
            }
            dispatchAppToast(t("auth.addEmailLoginSuccess"), "success");
            closeAddEmailModal();
            await fetchLoginMethods();
        } catch {
            dispatchAppToast(t("auth.emailLoginInvalidCode"), "error");
        } finally {
            setIsVerifyingAddEmailCode(false);
        }
    };

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
                        setTheme(
                            isThemePreference(data.theme)
                                ? data.theme
                                : APP_DEFAULTS.defaultTheme
                        );
                        setLanguage(data.language || globalLang);
                        setDefaultModel(data.defaultModel || APP_DEFAULTS.defaultModelId);
                        setTimeZone(data.timeZone || "UTC");
                        const allowedAt = data.timeZoneChangeAllowedAt || null;
                        setTimeZoneChangeAllowedAt(allowedAt);
                        setTimeZoneChangeLocked(
                            Boolean(
                                allowedAt &&
                                Date.parse(allowedAt) > new Date().getTime()
                            )
                        );
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
                if (isDeleteAccountModalOpen) {
                    closeDeleteAccountModal();
                } else {
                    closeSettingsModal();
                }
                return;
            }

            if (event.key !== "Tab" || isDeleteAccountModalOpen) return;

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
    }, [closeDeleteAccountModal, closeSettingsModal, getSettingsFocusableElements, isModalOpen, isDeleteAccountModalOpen]);

    useEffect(() => {
        if (!isAccountMenuOpen) return;

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node;
            if (
                !accountMenuRef.current?.contains(target) &&
                !accountMenuButtonRef.current?.contains(target)
            ) {
                setIsAccountMenuOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setIsAccountMenuOpen(false);
            accountMenuButtonRef.current?.focus();
        };

        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [isAccountMenuOpen]);

    const handleSaveSettings = async () => {
        try {
            const res = await fetch("/api/user/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ theme, language, defaultModel, timeZone }),
            });

            const data = await res.json().catch(() => null);

            if (res.ok) {
                setTimeZone(data?.settings?.timeZone || timeZone);
                setTimeZoneChangeAllowedAt(
                    data?.settings?.timeZoneChangeAllowedAt || null
                );
                setTimeZoneChangeLocked(
                    Boolean(
                        data?.settings?.timeZoneChangeAllowedAt &&
                        Date.parse(data.settings.timeZoneChangeAllowedAt) >
                            new Date().getTime()
                    )
                );
                closeSettingsModal();
                dispatchAppToast(t("auth.saveMessage"), "success");

                setGlobalLang(language);

                storeAndApplyThemePreference(theme);

                notifyUserSettingsUpdated({ defaultModel, theme });
                notifyUserUsageChanged();
            } else if (
                data?.code === "TIME_ZONE_CHANGE_COOLDOWN" &&
                typeof data.retryAt === "string"
            ) {
                const retryLabel = new Intl.DateTimeFormat(globalLang, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    timeZone,
                }).format(new Date(data.retryAt));
                setTimeZoneChangeAllowedAt(data.retryAt);
                setTimeZoneChangeLocked(true);
                dispatchAppToast(
                    formatCopy("auth.timeZoneChangeLocked", { date: retryLabel }),
                    "error"
                );
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
            const data = (await response.json().catch(() => null)) as
                | { code?: string; error?: string; scheduledFor?: string }
                | null;
            if (!response.ok) {
                if (response.status === 428 && data?.code === "ACCOUNT_REAUTHENTICATION_REQUIRED") {
                    dispatchAppToast(t("auth.deleteAccountReauthRequired"), "error");
                    await signOut({
                        callbackUrl: `/auth/signin?callbackUrl=${encodeURIComponent(chatCallbackUrl)}`,
                    });
                    return;
                }
                throw new Error(data?.error || `Delete failed: ${response.status}`);
            }
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
        if (accountDeletionConfirmation !== "DELETE MY ACCOUNT") {
            dispatchAppToast(t("auth.deleteAccountConfirmationRequired"), "error");
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
                body: JSON.stringify({
                    confirm: true,
                    confirmationText: accountDeletionConfirmation,
                }),
            });
            const data = (await response.json().catch(() => null)) as
                | { code?: string; error?: string }
                | null;
            if (!response.ok) {
                if (response.status === 428 && data?.code === "ACCOUNT_REAUTHENTICATION_REQUIRED") {
                    dispatchAppToast(t("auth.deleteAccountReauthRequired"), "error");
                    await signOut({
                        callbackUrl: `/auth/signin?callbackUrl=${encodeURIComponent(chatCallbackUrl)}`,
                    });
                    return;
                }
                throw new Error(data?.error || `Delete failed: ${response.status}`);
            }
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
      <div className="relative w-full" data-testid="account-card-compact">
        <div className="flex min-h-12 items-center gap-1.5 rounded-2xl border border-zinc-200 bg-white p-1.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <button
            ref={accountMenuButtonRef}
            type="button"
            data-testid="account-menu-trigger"
            aria-expanded={isAccountMenuOpen}
            aria-controls="account-quick-menu"
            onClick={() => setIsAccountMenuOpen((current) => !current)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 py-1 text-left transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-900"
          >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-teal-600 text-sm font-black text-white ring-1 ring-teal-400/50 dark:bg-teal-700 dark:ring-teal-400/40">
            {session.user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.user.image}
                alt={t("auth.profileImage")}
                className="h-full w-full object-cover"
              />
            ) : (
              (session.user.name?.[0] || session.user.email?.[0] || "T").toUpperCase()
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-black text-zinc-800 dark:text-zinc-100">
              {session.user.name || session.user.email || "Tomverse"}
            </span>
            <span className="block truncate text-[10px] font-semibold text-zinc-400">
              {accountPlan ? t(`modelTiers.${accountPlan.toLowerCase()}`) : t("auth.loading")}
              {accountUsage
                ? ` · ${formatCopy("auth.planCreditsCompact", {
                    count: accountUsage.balances.planRemainingCredits.toLocaleString(globalLang),
                  })}`
                : ""}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${isAccountMenuOpen ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
          </button>
          {mobileUpgradePlan && accountUsage ? (
            <UpgradeCtaLink
              targetPlan={mobileUpgradePlan}
              currentPlan={accountUsage.plan}
              trigger="account"
              ctaLocation="account_plan_badge"
              planCreditsRemaining={accountUsage.balances.planRemainingCredits}
              addonCreditsRemaining={accountUsage.balances.purchasedRemainingCredits}
              testId="account-plan-upgrade-badge"
              className="inline-flex h-8 shrink-0 items-center rounded-lg bg-blue-600 px-2 text-[10px] font-black text-white transition hover:bg-blue-500"
            >
              {t("upgrade.upgradeShort")}
            </UpgradeCtaLink>
          ) : (
            <span className={`shrink-0 rounded-lg px-2 py-1 text-[10px] font-black ${accountPlan === "Max" ? "bg-purple-500/10 text-purple-600 dark:text-purple-300" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"}`}>
              {accountPlan ? t(`modelTiers.${accountPlan.toLowerCase()}`) : t("auth.loading")}
            </span>
          )}
        </div>

        {isAccountMenuOpen ? (
          <>
            <button
              type="button"
              data-testid="account-menu-backdrop"
              aria-label={t("auth.closeAccountMenu")}
              onClick={() => setIsAccountMenuOpen(false)}
              className="fixed inset-0 z-[85] bg-black/45 backdrop-blur-[1px] md:hidden"
            />
            <div
              ref={accountMenuRef}
              id="account-quick-menu"
              data-testid="account-menu"
              role="dialog"
              aria-label={t("auth.accountMenu")}
              className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[90] max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-3 shadow-2xl overscroll-contain dark:border-zinc-700 dark:bg-zinc-950 md:absolute md:inset-x-0 md:bottom-[calc(100%+0.5rem)]"
            >
              <div className="flex min-w-0 items-center gap-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal-600 text-sm font-black text-white">
                  {(session.user.name?.[0] || session.user.email?.[0] || "T").toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-black text-zinc-900 dark:text-zinc-100">
                    {session.user.name || session.user.email || "Tomverse"}
                  </span>
                  {session.user.name && session.user.email ? (
                    <span className="block truncate text-[11px] text-zinc-400">{session.user.email}</span>
                  ) : null}
                </span>
                <span className="rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-black text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                  {accountPlan ? t(`modelTiers.${accountPlan.toLowerCase()}`) : t("auth.loading")}
                </span>
              </div>

              {accountUsage ? (
                <div className="my-3 grid grid-cols-2 gap-2">
                  <div
                    className="col-span-2 rounded-xl bg-blue-50 p-2.5 dark:bg-blue-950/30"
                    data-testid="account-daily-credits"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="block text-[10px] font-bold text-blue-700 dark:text-blue-300">
                        {t("auth.dailyCreditsRemaining")}
                      </span>
                      {hasDailyCreditGuardrail && dailyCreditsResetLabel ? (
                        <span className="text-right text-[9px] leading-4 text-blue-500 dark:text-blue-400">
                          {formatCopy("auth.dailyCreditsResetAt", {
                            time: dailyCreditsResetLabel,
                          })}
                        </span>
                      ) : null}
                    </div>
                    <strong className="mt-1 block text-sm text-zinc-900 dark:text-zinc-100">
                      {hasDailyCreditGuardrail && dailyCreditsRemaining !== null
                        ? `${dailyCreditsRemaining.toLocaleString(globalLang)} / ${dailyCreditsLimit.toLocaleString(globalLang)}`
                        : t("auth.dailyCreditsUnlimitedStandard")}
                    </strong>
                  </div>
                  <div className="rounded-xl bg-zinc-100 p-2.5 dark:bg-zinc-900">
                    <span className="block text-[10px] font-bold text-zinc-500 dark:text-zinc-400">
                      {t("auth.planCreditsRemaining")}
                    </span>
                    <strong className="mt-1 block text-sm text-zinc-900 dark:text-zinc-100">
                      {accountUsage.balances.planRemainingCredits.toLocaleString(globalLang)}
                    </strong>
                  </div>
                  <div className="rounded-xl bg-emerald-50 p-2.5 dark:bg-emerald-950/30">
                    <span className="block text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                      {t("auth.purchasedCreditsRemaining")}
                    </span>
                    <strong className="mt-1 block text-sm text-zinc-900 dark:text-zinc-100">
                      {accountUsage.balances.purchasedRemainingCredits.toLocaleString(globalLang)}
                    </strong>
                  </div>
                </div>
              ) : null}

              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => openSettingsTab("plan")}
                  className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  <CreditCard className="h-4 w-4 text-blue-500" />
                  {t("auth.usageAndPlan")}
                </button>
                <button
                  ref={settingsButtonRef}
                  type="button"
                  data-testid="account-settings"
                  onClick={() => openSettingsTab("account")}
                  className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  <Settings className="h-4 w-4 text-zinc-500" />
                  {t("auth.setting")}
                </button>
                <button
                  type="button"
                  data-testid="account-analytics-settings"
                  onClick={() => {
                    setIsAccountMenuOpen(false);
                    openAnalyticsPreferences();
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
                >
                  <BarChart3 className="h-4 w-4 text-blue-500" />
                  {t("auth.analyticsSettings")}
                </button>
                {mobileUpgradePlan && accountUsage ? (
                  <UpgradeCtaLink
                    targetPlan={mobileUpgradePlan}
                    currentPlan={accountUsage.plan}
                    trigger="account"
                    ctaLocation="account_card_plan"
                    planCreditsRemaining={accountUsage.balances.planRemainingCredits}
                    addonCreditsRemaining={accountUsage.balances.purchasedRemainingCredits}
                    testId="account-plan-view"
                    onClick={() => setIsAccountMenuOpen(false)}
                    className="flex min-h-11 w-full items-center gap-2 rounded-xl bg-blue-600 px-3 text-sm font-black text-white transition hover:bg-blue-500"
                  >
                    <Crown className="h-4 w-4" />
                    {mobileUpgradePlan === "Pro"
                      ? t("upgrade.viewProPlan")
                      : t("upgrade.viewMaxPlan")}
                  </UpgradeCtaLink>
                ) : accountPlan === "Max" ? (
                  <button
                    type="button"
                    data-testid="account-plan-view"
                    onClick={() => openSettingsTab("plan")}
                    className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-900"
                  >
                    <CreditCard className="h-4 w-4 text-purple-500" />
                    {t("upgrade.viewCurrentPlan")}
                  </button>
                ) : null}
                <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                <button
                  type="button"
                  onClick={() => {
                    setIsAccountMenuOpen(false);
                    void signOut();
                  }}
                  className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-600 transition hover:bg-red-50 hover:text-red-600 dark:text-zinc-300 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                >
                  <LogOut className="h-4 w-4" />
                  {t("auth.singedOut")}
                </button>
              </div>
            </div>
          </>
        ) : null}

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
                                        <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                            <h4 className="text-sm font-bold">{t("auth.manageLoginMethods")}</h4>
                                            <p className="mt-1 text-sm leading-6 text-zinc-500">{t("auth.manageLoginMethodsDescription")}</p>
                                            <div className="mt-3 space-y-2">
                                                {loginMethods.map((method) => {
                                                    const key = method.type === "email" ? "email" : method.provider;
                                                    const label =
                                                        method.type === "email"
                                                            ? t("auth.loginMethodEmail")
                                                            : method.provider === "google"
                                                                ? t("auth.google")
                                                                : t("auth.microsoft");
                                                    const isEnabled = method.type === "email" ? method.enabled : method.linked;
                                                    const Icon = method.type === "email" ? Mail : KeyRound;
                                                    const canRemoveThis = isEnabled && canRemoveLoginMethod;
                                                    return (
                                                        <div
                                                            key={key}
                                                            className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/60"
                                                        >
                                                            <div className="flex min-w-0 items-center gap-2.5">
                                                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700">
                                                                    <Icon className="h-4 w-4" />
                                                                </span>
                                                                <div className="min-w-0">
                                                                    <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{label}</p>
                                                                    {method.type === "email" && (
                                                                        <p className="truncate text-xs text-zinc-500">{method.address}</p>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            {isEnabled ? (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleRemoveLoginMethod(method.type === "email" ? "email" : method.provider)}
                                                                    disabled={isRemovingLoginMethod || !canRemoveThis}
                                                                    title={!canRemoveThis ? t("auth.removeLoginMethodBlocked") : ""}
                                                                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-bold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-950/40"
                                                                >
                                                                    {armedRemoveMethod === (method.type === "email" ? "email" : method.provider)
                                                                        ? t("auth.confirmRemoveLoginMethodButton")
                                                                        : t("auth.removeLoginMethod")}
                                                                </button>
                                                            ) : method.type === "email" ? (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setIsAddEmailModalOpen(true)}
                                                                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-bold text-blue-600 transition-colors hover:bg-blue-50 dark:hover:bg-blue-950/40"
                                                                >
                                                                    {t("auth.addLoginMethod")}
                                                                </button>
                                                            ) : (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleAddOAuthLoginMethod(method.provider)}
                                                                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-bold text-blue-600 transition-colors hover:bg-blue-50 dark:hover:bg-blue-950/40"
                                                                >
                                                                    {t("auth.addLoginMethod")}
                                                                </button>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                        <section className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-950/70 dark:bg-red-950/20">
                                            <h4 className="text-sm font-bold text-red-700 dark:text-red-300">{t("auth.dangerZone")}</h4>
                                            <p className="mt-1 text-sm leading-6 text-red-700/80 dark:text-red-200/80">{t("auth.accountDangerZoneDescription")}</p>
                                            <button
                                                type="button"
                                                onClick={() => setIsDeleteAccountModalOpen(true)}
                                                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-red-300 bg-white px-3 py-3 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/70"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                                {t("auth.deleteAccount")}
                                            </button>
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
                                                    onChange={(e) => setTheme(e.target.value as ThemePreference)}
                                                    className="mt-1 w-full cursor-pointer bg-transparent text-sm font-semibold text-zinc-900 outline-none dark:text-zinc-100"
                                                >
                                                    <option className="bg-white text-zinc-900" value="dark">{t("auth.darkTheme")}</option>
                                                    <option className="bg-white text-zinc-900" value="light">{t("auth.lightTheme")}</option>
                                                    <option className="bg-white text-zinc-900" value="system">{t("auth.systemTheme")}</option>
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

                                        <label className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/60">
                                            <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-xs font-semibold text-zinc-500">{t("auth.timeZone")}</span>
                                                <select
                                                    value={timeZone}
                                                    onChange={(e) => setTimeZone(e.target.value)}
                                                    disabled={timeZoneChangeLocked}
                                                    className="mt-1 w-full cursor-pointer bg-transparent text-sm font-semibold text-zinc-900 outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:text-zinc-100"
                                                >
                                                    {timeZoneOptions.map((zone) => (
                                                        <option className="bg-white text-zinc-900" key={zone} value={zone}>
                                                            {zone}
                                                        </option>
                                                    ))}
                                                </select>
                                                <span className="mt-1 block text-xs leading-5 text-zinc-500">
                                                    {timeZoneChangeLocked && timeZoneChangeAllowedLabel
                                                        ? formatCopy("auth.timeZoneChangeLocked", {
                                                              date: timeZoneChangeAllowedLabel,
                                                          })
                                                        : t("auth.timeZoneDescription")}
                                                </span>
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
                                        <button
                                            type="button"
                                            onClick={() => {
                                                closeSettingsModal();
                                                requestAnimationFrame(() => openModelFinder());
                                            }}
                                            className="flex w-full items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm font-black text-blue-700 transition hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-200 dark:hover:bg-blue-950/40"
                                        >
                                            <Bot className="h-4 w-4" />
                                            {t("modelFinder.findAgain")}
                                        </button>
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
                                            <button
                                                type="button"
                                                onClick={handleDeleteAllConversations}
                                                disabled={isDeletingChats}
                                                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-3 py-3 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/70"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                                {isDeletingChats
                                                    ? t("auth.deleting")
                                                    : isDeleteAllArmed
                                                        ? t("auth.confirmDeleteAllChats")
                                                        : t("auth.deleteAllChats")}
                                            </button>
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
                                            <section className="grid gap-3 sm:grid-cols-3">
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
                                                    <p className="mt-1 text-xs text-zinc-400">
                                                        {t("auth.planCreditsRemaining")}: {accountUsage.balances.planRemainingCredits.toLocaleString(globalLang)}
                                                    </p>
                                                </div>
                                                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/20">
                                                    <p className="text-xs font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">
                                                        {t("auth.purchasedCreditsRemaining")}
                                                    </p>
                                                    <p className="mt-2 text-lg font-black text-zinc-900 dark:text-zinc-100">
                                                        {accountUsage.balances.purchasedRemainingCredits.toLocaleString(globalLang)}
                                                    </p>
                                                    <p className="mt-1 text-xs text-zinc-400">
                                                        {accountUsage.balances.purchasedEarliestExpiry
                                                            ? `${globalLang === "ko" ? "만료" : "Expires"} ${new Date(accountUsage.balances.purchasedEarliestExpiry).toLocaleDateString(globalLang)}`
                                                            : globalLang === "ko" ? "구매 내역 없음" : "No purchases"}
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
                                            {accountPlan !== "Max" && <UpgradeInterestButton
                                                plan={accountPlan === "Pro" ? "Max" : "Pro"}
                                                trigger="account"
                                                className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-3 text-sm font-black text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
                                            >
                                                <CreditCard className="h-4 w-4" />
                                                {accountPlan === "Pro" ? (globalLang === "ko" ? "Max로 업그레이드" : "Upgrade to Max") : t("billing.joinProWaitlist")}
                                            </UpgradeInterestButton>}
                                            <CreditPackPurchaseButton
                                                trigger="account"
                                                className="flex w-full items-center justify-center gap-2 rounded-xl border border-purple-300 bg-purple-50 px-3 py-3 text-sm font-black text-purple-700 transition-colors hover:bg-purple-100 disabled:cursor-not-allowed disabled:opacity-70 dark:border-purple-900/60 dark:bg-purple-950/30 dark:text-purple-200 dark:hover:bg-purple-950/50"
                                            >
                                                <CreditCard className="h-4 w-4" />
                                                {globalLang === "ko" ? "추가 크레딧 구매" : "Buy additional credits"}
                                            </CreditPackPurchaseButton>
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
                                        trigger="account"
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

            {isModalOpen && isDeleteAccountModalOpen && (
                <div
                    className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) closeDeleteAccountModal();
                    }}
                >
                    <div
                        className="w-full max-w-md rounded-2xl border border-red-300 bg-white p-5 shadow-2xl dark:border-red-900/70 dark:bg-zinc-900"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="delete-account-modal-title"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <h3 id="delete-account-modal-title" className="text-sm font-black text-red-700 dark:text-red-200">
                                {t("auth.deleteAccountImmediateTitle")}
                            </h3>
                            <button
                                type="button"
                                onClick={closeDeleteAccountModal}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"
                                aria-label={t("auth.cancel")}
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-red-700/80 dark:text-red-100/80">
                            {t("auth.deleteAccountImmediateDescription")}
                        </p>
                        <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
                            <input
                                type="checkbox"
                                checked={accountDeletionConsent}
                                onChange={(event) => {
                                    setAccountDeletionConsent(event.target.checked);
                                    setIsAccountDeleteArmed(false);
                                }}
                                className="mt-0.5 h-4 w-4 cursor-pointer accent-red-600"
                            />
                            <span>{t("auth.deleteAccountConsent")}</span>
                        </label>
                        <label className="mt-3 block text-xs font-bold text-red-800 dark:text-red-100">
                            {t("auth.deleteAccountConfirmationPrompt")}
                            <input
                                value={accountDeletionConfirmation}
                                onChange={(event) => {
                                    setAccountDeletionConfirmation(event.target.value);
                                    setIsAccountDeleteArmed(false);
                                }}
                                autoComplete="off"
                                spellCheck={false}
                                className="mt-2 h-10 w-full rounded-lg border border-red-300 bg-white px-3 font-mono text-sm text-zinc-950 outline-none focus:border-red-500 focus:ring-4 focus:ring-red-500/10 dark:border-red-900 dark:bg-zinc-950 dark:text-white"
                                placeholder="DELETE MY ACCOUNT"
                            />
                        </label>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={closeDeleteAccountModal}
                                className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            >
                                {t("auth.cancel")}
                            </button>
                            <button
                                type="button"
                                onClick={handleDeleteAccount}
                                disabled={isRequestingDeletion || !accountDeletionConsent || accountDeletionConfirmation !== "DELETE MY ACCOUNT"}
                                className="flex items-center justify-center gap-2 rounded-xl border border-red-300 bg-red-600 px-4 py-2 text-sm font-black text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800"
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
                </div>
            )}

            {isModalOpen && isAddEmailModalOpen && (
                <div
                    className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) closeAddEmailModal();
                    }}
                >
                    <div
                        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="add-email-modal-title"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <h3 id="add-email-modal-title" className="text-sm font-black">
                                {t("auth.addLoginMethod")}
                            </h3>
                            <button
                                type="button"
                                onClick={closeAddEmailModal}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white"
                                aria-label={t("auth.cancel")}
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        {!addEmailCodeSent ? (
                            <>
                                <p className="mt-2 text-sm leading-6 text-zinc-500">
                                    {formatCopy("auth.emailLoginCodeSentBody", { email: session.user.email || "" })}
                                </p>
                                <button
                                    type="button"
                                    onClick={handleRequestAddEmailCode}
                                    disabled={isSendingAddEmailCode}
                                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-3 text-sm font-bold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {t("auth.emailLoginButton")}
                                </button>
                            </>
                        ) : (
                            <>
                                <p className="mt-2 text-sm leading-6 text-zinc-500">
                                    {formatCopy("auth.emailLoginCodeSentBody", { email: session.user.email || "" })}
                                </p>
                                <label className="mt-3 block text-xs font-bold text-zinc-600 dark:text-zinc-300">
                                    {t("auth.emailLoginCodeInputLabel")}
                                    <input
                                        value={addEmailCode}
                                        onChange={(event) => setAddEmailCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                                        autoComplete="off"
                                        inputMode="numeric"
                                        spellCheck={false}
                                        className="mt-2 h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 font-mono text-lg tracking-widest text-zinc-950 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
                                        placeholder="000000"
                                    />
                                </label>
                                <div className="mt-4 flex justify-end gap-2">
                                    <button
                                        type="button"
                                        onClick={closeAddEmailModal}
                                        className="rounded-lg px-4 py-2 text-sm font-semibold text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                    >
                                        {t("auth.cancel")}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleVerifyAddEmailCode}
                                        disabled={isVerifyingAddEmailCode || addEmailCode.trim().length !== 6}
                                        className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {t("auth.emailLoginVerifyButton")}
                                    </button>
                                </div>
                            </>
                        )}
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
          {(["en", "ko", "zh", "fr", "de", "es", "pt"] as Language[]).map(
            (language) => (
              <option
                key={language}
                className="bg-white text-zinc-900"
                value={language}
              >
                {localeLaunchPolicy[language].selectorLabel}
              </option>
            )
          )}
        </select>
      </label>
      <div className="flex gap-2">
        <button
          onClick={() => {
            trackProductEvent("cta_start_click", 0, {
              cta_location: "account_login",
            });
            void signIn(undefined, { callbackUrl: chatCallbackUrl });
          }}
          className="cursor-pointer flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-blue-950/20 transition-all hover:bg-blue-500"
        >
          {t("auth.login")}
        </button>
        {showAnalyticsCookieButton && (
          <button
            type="button"
            data-testid="guest-analytics-cookie-settings"
            onClick={() => openAnalyticsPreferences()}
            className="shrink-0 rounded-xl border border-zinc-200 bg-zinc-100 px-3 py-2.5 text-xs font-bold text-zinc-600 transition-colors hover:bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {t("auth.analyticsCookieSettings")}
          </button>
        )}
      </div>
    </div>
  );
}
