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
    Brain,
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
import { canUseModelWithPlan } from "@/lib/models";
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
    consumePendingAccountSettingsRequest,
    readAccountSettingsOpenRequest,
} from "@/lib/accountSettingsEvents";
import { SettingsEntryRow } from "@/components/settings/SettingsEntryRow";
import {
    isSettingsSectionId,
    parseSettingsDeepLink,
    settingsSectionElementId,
    stripSettingsDeepLink,
    type SettingsSectionId,
} from "@/lib/settingsNavigation";
import { listImportableGuestConversations } from "@/lib/guestImport";
import { openGuestImportModal } from "@/lib/guestImportModalEvents";
import { useModalDialog } from "@/components/useModalDialog";
import { discardResponseBody } from "@/lib/discardResponseBody";

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
    // Data-tab entry point for external conversation import. Hidden until the
    // capacity endpoint answers 200: that endpoint is the authoritative
    // session + rollout-flag probe, so a disabled flag closes this entry
    // fail-closed exactly when it closes the API (policy §15).
    const [externalImportEntry, setExternalImportEntry] = useState<
        | { kind: "hidden" }
        | { kind: "ready"; conversations: number; bytes: number }
    >({ kind: "hidden" });
    // Status line for the memory row. Unlike the import entry this is never a
    // visibility probe -- memory review is always reachable (policy §15) -- so
    // an unavailable API only costs the row its status, never the row.
    const [memoryEntryStatus, setMemoryEntryStatus] = useState<
        { masterEnabled: boolean; candidates: number } | null
    >(null);
    // Settings-list row a detail page asked to return to, kept until the row
    // it names has actually rendered: the import row only appears once the
    // capacity probe answers, which is several frames after the tab paints.
    const [pendingSettingsSection, setPendingSettingsSection] =
        useState<SettingsSectionId | null>(null);
    const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
    const settingsDialogRef = useRef<HTMLDivElement | null>(null);
    const deleteAccountButtonRef = useRef<HTMLButtonElement | null>(null);
    const deleteAccountDialogRef = useRef<HTMLDivElement | null>(null);
    const addEmailButtonRef = useRef<HTMLButtonElement | null>(null);
    const addEmailDialogRef = useRef<HTMLDivElement | null>(null);
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
    // The new-conversation default combination, lead first. The representative
    // model is always defaultModelIds[0]; the server keeps the two in sync.
    const [defaultModelIds, setDefaultModelIds] = useState<string[]>([
        APP_DEFAULTS.defaultModelId,
    ]);
    // True while GET reported a stored/effective drift the user has not
    // confirmed away by re-saving (docs/ui-contracts/account-model-settings.md).
    const [modelDriftNotice, setModelDriftNotice] = useState(false);
    const [highCostAcknowledged, setHighCostAcknowledged] = useState(false);
    // The last server-confirmed combination, mirrored in state so render-time
    // derivations (the high-cost consent gate) never read a ref during render.
    const [savedModelIds, setSavedModelIds] = useState<string[]>([
        APP_DEFAULTS.defaultModelId,
    ]);
    // What the server last confirmed -- the dirty-field baseline, so a
    // theme-only save never re-sends (and never re-persists) model fields.
    const savedSettingsRef = useRef<{
        theme: ThemePreference;
        language: Language;
        timeZone: string;
        modelIds: string[];
    } | null>(null);
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
    const accountTimeZone =
        accountUsage?.entitlement?.timeZone || accountUsage?.timeZone || timeZone;
    const formatResetLabel = (value: string | null | undefined) =>
        value
            ? new Intl.DateTimeFormat(globalLang, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: accountTimeZone,
            }).format(new Date(value))
            : null;
    const dailyCreditsResetLabel = formatResetLabel(
        accountUsage?.entitlement?.dailyResetsAt ||
            accountUsage?.balances.dailyResetsAt
    );
    // An account with no daily credit limit is still bounded by its monthly
    // plan credits, so the reset it is told about has to be the one that
    // actually applies rather than nothing at all.
    const planCreditsResetLabel = formatResetLabel(
        accountUsage?.entitlement?.planResetsAt ||
            accountUsage?.balances.planResetsAt
    );
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
        (
            tab: "account" | "preferences" | "data" | "plan",
            section: string | null = null
        ) => {
            setIsAccountMenuOpen(false);
            setActiveSettingsTab(tab);
            setPendingSettingsSection(
                isSettingsSectionId(section) ? section : null
            );
            setIsModalOpen(true);
        },
        []
    );

    // Lets the collapsed sidebar rail's compact account button (which has no
    // room for the full settings modal) open this same modal remotely.
    useEffect(() => {
        const handleOpenAccountSettings = (event: Event) => {
            const request = readAccountSettingsOpenRequest(
                (event as CustomEvent<unknown>).detail
            );
            // Served here, so the copy kept for a not-yet-mounted modal must
            // not be replayed by the next mount.
            consumePendingAccountSettingsRequest();
            openSettingsTab(request.tab, request.section);
        };
        window.addEventListener(ACCOUNT_SETTINGS_OPEN_EVENT, handleOpenAccountSettings);
        return () =>
            window.removeEventListener(ACCOUNT_SETTINGS_OPEN_EVENT, handleOpenAccountSettings);
    }, [openSettingsTab]);

    // Two ways in that this modal cannot receive as an event, because it was
    // not mounted when the request was made:
    //
    //   * a request raised while the sidebar was collapsed or the mobile
    //     drawer closed -- mounting this modal is what those shells do *in
    //     response*, so the event is always one step ahead of the listener;
    //   * "Back to settings" on a detail page, which is a full navigation and
    //     arrives as a deep link in the URL (lib/settingsNavigation.ts). It
    //     has to work on a cold, directly-opened URL too, so the parameters
    //     are the request -- no history, no prior in-page state.
    //
    // The deep link is then dropped from the address bar with replaceState:
    // the request has been served, and rewriting the current entry (rather
    // than pushing one) leaves the visitor's own Back button where it was.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const pending = consumePendingAccountSettingsRequest();
        if (pending) {
            queueMicrotask(() => openSettingsTab(pending.tab, pending.section));
            return;
        }
        const deepLink = parseSettingsDeepLink(window.location.search);
        if (!deepLink) return;
        window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${stripSettingsDeepLink(window.location.search)}${window.location.hash}`
        );
        queueMicrotask(() => openSettingsTab(deepLink.tab, deepLink.section));
    }, [openSettingsTab]);

    // Scroll and focus restoration for the row the visitor came from. The
    // dialog moves focus to its first control on the frame after it opens, so
    // this waits a further frame rather than racing it, and keeps the request
    // pending until the row exists.
    useEffect(() => {
        if (!isModalOpen || !pendingSettingsSection) return;
        let secondFrame = 0;
        const firstFrame = requestAnimationFrame(() => {
            secondFrame = requestAnimationFrame(() => {
                const row = document.getElementById(
                    settingsSectionElementId(pendingSettingsSection)
                );
                if (!row) return;
                row.scrollIntoView({ block: "center" });
                row.focus({ preventScroll: true });
                setPendingSettingsSection(null);
            });
        });
        return () => {
            cancelAnimationFrame(firstFrame);
            cancelAnimationFrame(secondFrame);
        };
    }, [
        isModalOpen,
        pendingSettingsSection,
        activeSettingsTab,
        externalImportEntry,
    ]);

    const fetchLoginMethods = useCallback(async () => {
        try {
            const response = await fetch("/api/user/login-methods");
            if (!response.ok) {
                await discardResponseBody(response);
                return;
            }
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

    useEffect(() => {
        if (!isModalOpen || activeSettingsTab !== "data" || !session?.user) {
            return;
        }
        let cancelled = false;
        fetch("/api/imports/external/capacity", { cache: "no-store" })
            .then(async (response) => {
                if (cancelled || !response.ok) {
                    await discardResponseBody(response);
                    return;
                }
                const capacity = (await response.json()) as {
                    usage?: {
                        externalConversations?: number;
                        normalizedTextBytes?: number;
                    };
                } | null;
                if (cancelled) return;
                setExternalImportEntry({
                    kind: "ready",
                    conversations: capacity?.usage?.externalConversations ?? 0,
                    bytes: capacity?.usage?.normalizedTextBytes ?? 0,
                });
            })
            .catch(() => {
                // Unreachable API reads as unavailable: the entry stays hidden.
            });
        return () => {
            cancelled = true;
        };
    }, [isModalOpen, activeSettingsTab, session?.user]);

    // Status line for the memory row. Both endpoints stay reachable with the
    // rollout flag off (policy §15), so a failure here is a network fact and
    // not a feature probe: the row renders either way, just without a status.
    useEffect(() => {
        if (!isModalOpen || activeSettingsTab !== "data" || !session?.user) {
            return;
        }
        let cancelled = false;
        Promise.all([
            fetch("/api/memories/settings", { cache: "no-store" }),
            fetch("/api/memories?status=candidate&limit=1", {
                cache: "no-store",
            }),
        ])
            .then(async ([settingsResponse, candidateResponse]) => {
                // Both bodies, on every path out of here. `Promise.all` means
                // one refusal used to strand the other response's body unread
                // as well, and a cancelled effect stranded both -- the request
                // then stays in flight for the life of the page (see
                // lib/apiCacheControlPolicy.ts).
                if (cancelled || !settingsResponse.ok || !candidateResponse.ok) {
                    await discardResponseBody(settingsResponse);
                    await discardResponseBody(candidateResponse);
                    return;
                }
                const settings = (await settingsResponse.json()) as {
                    masterEnabled?: boolean;
                } | null;
                const candidates = (await candidateResponse.json()) as {
                    total?: number;
                } | null;
                if (cancelled) return;
                setMemoryEntryStatus({
                    masterEnabled: settings?.masterEnabled !== false,
                    candidates:
                        typeof candidates?.total === "number"
                            ? candidates.total
                            : 0,
                });
            })
            .catch(() => {
                // Unreachable API: the row keeps its name and description.
            });
        return () => {
            cancelled = true;
        };
    }, [isModalOpen, activeSettingsTab, session?.user]);

    // "Used in new chats · 3 awaiting review" -- the state first, then the
    // thing that needs doing, and only when there is one.
    const memoryEntryStatusText = memoryEntryStatus
        ? [
              memoryEntryStatus.masterEnabled
                  ? t("memoryReview.dataTabStatusOn")
                  : t("memoryReview.dataTabStatusOff"),
              ...(memoryEntryStatus.candidates > 0
                  ? [
                        formatCopy("memoryReview.dataTabStatusPending", {
                            count: String(memoryEntryStatus.candidates),
                        }),
                    ]
                  : []),
          ].join(" · ")
        : null;

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
        // Not a page navigation: the route answers with a 302 to the identity
        // provider, so the OAuth handshake needs a real document load. A
        // router push would keep the user on this page.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/api/user/login-methods/oauth/start?provider=${provider}`;
    }, []);

    const handleRemoveLoginMethod = async (method: "google" | "azure-ad" | "email") => {
        if (isRemovingLoginMethod) return;
        if (!canRemoveLoginMethod) {
            dispatchAppToast(t("auth.removeLoginMethodBlocked"), "error");
            return;
        }
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
            await discardResponseBody(response);
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

    useModalDialog({
        open: isModalOpen,
        onClose: closeSettingsModal,
        dialogRef: settingsDialogRef,
        panelRef: settingsDialogRef,
    });
    useModalDialog({
        open: isModalOpen && isDeleteAccountModalOpen,
        onClose: closeDeleteAccountModal,
        dialogRef: deleteAccountDialogRef,
        panelRef: deleteAccountDialogRef,
        returnFocusRef: deleteAccountButtonRef,
    });
    useModalDialog({
        open: isModalOpen && isAddEmailModalOpen,
        onClose: closeAddEmailModal,
        dialogRef: addEmailDialogRef,
        panelRef: addEmailDialogRef,
        returnFocusRef: addEmailButtonRef,
    });

    const handleRequestAddEmailCode = async () => {
        if (isSendingAddEmailCode) return;
        setIsSendingAddEmailCode(true);
        try {
            const response = await fetch("/api/user/login-methods/email/request", {
                method: "POST",
            });
            await discardResponseBody(response);
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

    useEffect(() => {
        if (isModalOpen && session) {
            fetch("/api/user/settings")
                .then((res) => res.json())
                .then((data) => {
                    if (!data.error) {
                        const nextTheme = isThemePreference(data.theme)
                            ? data.theme
                            : APP_DEFAULTS.defaultTheme;
                        const nextLanguage = data.language || globalLang;
                        const nextTimeZone = data.timeZone || "UTC";
                        const combination = Array.isArray(data.newConversationModelIds)
                            ? (data.newConversationModelIds as unknown[]).filter(
                                  (modelId): modelId is string =>
                                      typeof modelId === "string"
                              )
                            : [];
                        const nextModelIds =
                            combination.length > 0
                                ? combination
                                : [data.defaultModel || APP_DEFAULTS.defaultModelId];
                        setTheme(nextTheme);
                        setLanguage(nextLanguage);
                        setDefaultModelIds(nextModelIds);
                        setModelDriftNotice(Boolean(data.modelSelectionNotice));
                        setHighCostAcknowledged(false);
                        setTimeZone(nextTimeZone);
                        setSavedModelIds(nextModelIds);
                        savedSettingsRef.current = {
                            theme: nextTheme,
                            language: nextLanguage,
                            timeZone: nextTimeZone,
                            modelIds: nextModelIds,
                        };
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
                .then((res) =>
        res.ok ? res.json() : discardResponseBody(res).then(() => null)
      )
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

    // Derived combination facts for the editor and the save gate.
    //
    // Plan access is judged conservatively: while the usage (and therefore the
    // plan) is still loading, locked-looking is the safe default -- a model
    // must never look selectable for a moment and then be refused. The server
    // still enforces the same rule with a 400 on save.
    const settingsPlan = accountUsage?.plan ?? "Free";
    const isPlanLockedModel = (model: { minimumPlan: "Guest" | "Free" | "Pro" }) =>
        !canUseModelWithPlan(settingsPlan, model);
    const hasPlanLockedModels = ENABLED_MODELS.some(isPlanLockedModel);
    const combinationTotalCredits = defaultModelIds.reduce((total, modelId) => {
        const model = ENABLED_MODELS.find((candidate) => candidate.id === modelId);
        return model ? total + getModelUsageProfile(model).credits : total;
    }, 0);
    // Higher-cost models the user is ADDING (present now, absent from the last
    // server-confirmed combination) need explicit recurring-cost consent.
    const newlyAddedHighCostModelIds = defaultModelIds.filter((modelId) => {
        if (savedModelIds.includes(modelId)) return false;
        const model = ENABLED_MODELS.find((candidate) => candidate.id === modelId);
        return model ? getModelUsageProfile(model).category !== "Standard" : false;
    });

    const replaceCombinationModel = (index: number, nextModelId: string) => {
        const nextModel = ENABLED_MODELS.find(
            (candidate) => candidate.id === nextModelId
        );
        if (!nextModel || isPlanLockedModel(nextModel)) return;
        setDefaultModelIds((current) => {
            if (current.includes(nextModelId) && current[index] !== nextModelId) {
                return current;
            }
            const next = [...current];
            next[index] = nextModelId;
            return next;
        });
    };
    const makeCombinationLead = (index: number) => {
        setDefaultModelIds((current) =>
            index <= 0 || index >= current.length
                ? current
                : [current[index], ...current.filter((_, i) => i !== index)]
        );
    };
    const removeCombinationModel = (index: number) => {
        setDefaultModelIds((current) =>
            current.length <= 1 ? current : current.filter((_, i) => i !== index)
        );
    };
    const addCombinationModel = () => {
        setDefaultModelIds((current) => {
            if (current.length >= 3) return current;
            const candidate = ENABLED_MODELS.find(
                (model) =>
                    !current.includes(model.id) && !isPlanLockedModel(model)
            );
            return candidate ? [...current, candidate.id] : current;
        });
    };

    const handleSaveSettings = async () => {
        if (newlyAddedHighCostModelIds.length > 0 && !highCostAcknowledged) {
            dispatchAppToast(
                t("auth.newConversationModelsHighCostRequired"),
                "error"
            );
            return;
        }
        // Dirty fields only: an unchanged combination is never re-sent, so a
        // theme-only save cannot silently persist an effective replacement the
        // user did not agree to.
        const saved = savedSettingsRef.current;
        const modelsDirty =
            !saved ||
            JSON.stringify(saved.modelIds) !== JSON.stringify(defaultModelIds);
        const payload: Record<string, unknown> = {};
        if (!saved || saved.theme !== theme) payload.theme = theme;
        if (!saved || saved.language !== language) payload.language = language;
        if (!saved || saved.timeZone !== timeZone) payload.timeZone = timeZone;
        if (modelsDirty) payload.newConversationModelIds = defaultModelIds;
        if (Object.keys(payload).length === 0) {
            closeSettingsModal();
            dispatchAppToast(t("auth.saveMessage"), "success");
            return;
        }
        try {
            const res = await fetch("/api/user/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
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
                // Apply the canonical persisted combination, not the request.
                const canonicalRaw = data?.settings?.newConversationModelIds;
                const canonical = Array.isArray(canonicalRaw)
                    ? (canonicalRaw as unknown[]).filter(
                          (modelId): modelId is string =>
                              typeof modelId === "string"
                      )
                    : [];
                const canonicalLead =
                    (typeof data?.settings?.defaultModel === "string" &&
                        data.settings.defaultModel) ||
                    canonical[0] ||
                    defaultModelIds[0] ||
                    APP_DEFAULTS.defaultModelId;
                const canonicalModelIds =
                    canonical.length > 0 ? canonical : [canonicalLead];
                setDefaultModelIds(canonicalModelIds);
                if (modelsDirty) setModelDriftNotice(false);
                setHighCostAcknowledged(false);
                setSavedModelIds(canonicalModelIds);
                savedSettingsRef.current = {
                    theme,
                    language,
                    timeZone: data?.settings?.timeZone || timeZone,
                    modelIds: canonicalModelIds,
                };
                closeSettingsModal();
                dispatchAppToast(t("auth.saveMessage"), "success");

                setGlobalLang(language);

                storeAndApplyThemePreference(theme);

                notifyUserSettingsUpdated({
                    defaultModel: canonicalLead,
                    newConversationModelIds: canonicalModelIds,
                    theme,
                });
                notifyUserUsageChanged();
            } else if (
                data?.code === "NEW_CONVERSATION_MODELS_INVALID" ||
                data?.code === "DEFAULT_MODEL_LEAD_MISMATCH"
            ) {
                dispatchAppToast(
                    t("auth.newConversationModelsInvalid"),
                    "error"
                );
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
            window.location.href = chatCallbackUrl;
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
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-accent-account-700 text-sm font-bold text-white ring-1 ring-accent-account-400/50 dark:bg-accent-account-700 dark:ring-accent-account-400/40">
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
            <span className="block truncate text-xs font-bold text-zinc-800 dark:text-zinc-100">
              {session.user.name || session.user.email || "Tomverse"}
            </span>
            <span className="block truncate text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">
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
              className="inline-flex h-8 shrink-0 items-center rounded-lg bg-blue-600 px-2 text-xs font-bold text-white transition hover:bg-blue-500"
            >
              {t("upgrade.upgradeShort")}
            </UpgradeCtaLink>
          ) : (
            <span className={`shrink-0 rounded-lg px-2 py-1 text-xs font-bold ${accountPlan === "Max" ? "bg-accent-plan-max-500/10 text-accent-plan-max-600 dark:text-accent-plan-max-300" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"}`}>
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
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-account-700 text-sm font-bold text-white">
                  {(session.user.name?.[0] || session.user.email?.[0] || "T").toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    {session.user.name || session.user.email || "Tomverse"}
                  </span>
                  {session.user.name && session.user.email ? (
                    <span className="block truncate text-[11px] text-zinc-400">{session.user.email}</span>
                  ) : null}
                </span>
                <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs font-bold text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
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
                      <span className="block text-[11px] font-bold text-blue-700 dark:text-blue-300">
                        {t("auth.dailyCreditsRemaining")}
                      </span>
                      {(hasDailyCreditGuardrail
                        ? dailyCreditsResetLabel
                        : planCreditsResetLabel) ? (
                        <span
                          data-testid="account-credits-reset"
                          className="text-right text-[11px] leading-4 text-blue-500 dark:text-blue-400"
                        >
                          {formatCopy("auth.dailyCreditsResetAt", {
                            time: (hasDailyCreditGuardrail
                              ? dailyCreditsResetLabel
                              : planCreditsResetLabel)!,
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
                  <div
                    className="rounded-xl bg-zinc-100 p-2.5 dark:bg-zinc-900"
                    data-testid="account-plan-credits"
                  >
                    <span className="block text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
                      {t("auth.planCreditsRemaining")}
                    </span>
                    <strong className="mt-1 block text-sm text-zinc-900 dark:text-zinc-100">
                      {accountUsage.balances.planRemainingCredits.toLocaleString(globalLang)}
                    </strong>
                  </div>
                  <div className="rounded-xl bg-status-success-50 p-2.5 dark:bg-status-success-950/30">
                    <span className="block text-[11px] font-bold text-status-success-700 dark:text-status-success-300">
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
                    className="flex min-h-11 w-full items-center gap-2 rounded-xl bg-blue-600 px-3 text-sm font-bold text-white transition hover:bg-blue-500"
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
                    <CreditCard className="h-4 w-4 text-accent-plan-max-500" />
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
                <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
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
                                    <h2 id="user-settings-title" className="text-base font-bold">{t("auth.userSettings")}</h2>
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
                                                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-status-success-500" />
                                                <div>
                                                    <h3 className="text-sm font-bold">{t("auth.securityStatus")}</h3>
                                                    <p className="mt-1 text-sm leading-6 text-zinc-500">{t("auth.securityStatusDescription")}</p>
                                                </div>
                                            </div>
                                        </section>
                                        <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                            <h3 className="text-sm font-bold">{t("auth.manageLoginMethods")}</h3>
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
                                                              <>
                                                                <button
                                                                    ref={addEmailButtonRef}
                                                                    type="button"
                                                                    onClick={() => handleRemoveLoginMethod(method.type === "email" ? "email" : method.provider)}
                                                                    disabled={isRemovingLoginMethod}
                                                                    aria-disabled={!canRemoveThis || isRemovingLoginMethod}
                                                                    aria-describedby={!canRemoveThis ? `remove-login-method-blocked-${key}` : undefined}
                                                                    className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-bold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-950/40 ${!canRemoveThis ? "cursor-not-allowed opacity-40" : ""}`}
                                                                >
                                                                    {armedRemoveMethod === (method.type === "email" ? "email" : method.provider)
                                                                        ? t("auth.confirmRemoveLoginMethodButton")
                                                                        : t("auth.removeLoginMethod")}
                                                                </button>
                                                                {!canRemoveThis && (
                                                                    <span id={`remove-login-method-blocked-${key}`} className="sr-only">
                                                                        {t("auth.removeLoginMethodBlocked")}
                                                                    </span>
                                                                )}
                                                              </>
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
                                            <h3 className="text-sm font-bold text-red-700 dark:text-red-300">{t("auth.dangerZone")}</h3>
                                            <p className="mt-1 text-sm leading-6 text-red-700/80 dark:text-red-200/80">{t("auth.accountDangerZoneDescription")}</p>
                                            <button
                                                ref={deleteAccountButtonRef}
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

                                        <div
                                            data-testid="settings-new-conversation-models"
                                            className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/60"
                                        >
                                            <div className="flex items-center gap-3">
                                                <Bot className="h-4 w-4 shrink-0 text-zinc-500" />
                                                <span className="block text-xs font-semibold text-zinc-500">
                                                    {t("auth.newConversationModelsTitle")}
                                                </span>
                                            </div>
                                            {modelDriftNotice && (
                                                <p
                                                    data-testid="settings-model-drift-notice"
                                                    className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                                                >
                                                    {t("auth.newConversationModelsDrift")}
                                                </p>
                                            )}
                                            <div className="mt-2 space-y-2">
                                                {defaultModelIds.map((modelId, index) => (
                                                    <div
                                                        key={modelId}
                                                        data-testid="settings-combination-row"
                                                        className="flex items-center gap-2"
                                                    >
                                                        <select
                                                            aria-label={t("auth.defaultModel")}
                                                            value={modelId}
                                                            onChange={(e) =>
                                                                replaceCombinationModel(index, e.target.value)
                                                            }
                                                            className="w-full min-w-0 flex-1 cursor-pointer bg-transparent text-sm font-semibold text-zinc-900 outline-none dark:text-zinc-100"
                                                        >
                                                            {ENABLED_MODELS.filter(
                                                                (model) =>
                                                                    model.id === modelId ||
                                                                    !defaultModelIds.includes(model.id)
                                                            ).map((model) => {
                                                                const usageProfile = getModelUsageProfile(model);
                                                                const planLocked = isPlanLockedModel(model);
                                                                return (
                                                                    <option
                                                                        className="bg-white text-zinc-900"
                                                                        key={model.id}
                                                                        value={model.id}
                                                                        disabled={planLocked}
                                                                    >
                                                                        {model.icon} {model.name} · {t(`modelUsageClasses.${usageProfile.category.toLowerCase()}`)} · {usageProfile.credits}
                                                                        {planLocked
                                                                            ? ` · 🔒 ${formatCopy("auth.newConversationModelsPlanLocked", { plan: model.minimumPlan })}`
                                                                            : ""}
                                                                    </option>
                                                                );
                                                            })}
                                                        </select>
                                                        {index === 0 ? (
                                                            <span
                                                                data-testid="settings-lead-model-badge"
                                                                className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-bold text-blue-700 dark:bg-blue-950/40 dark:text-blue-200"
                                                            >
                                                                {t("auth.newConversationModelsLead")}
                                                            </span>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                onClick={() => makeCombinationLead(index)}
                                                                className="shrink-0 rounded-lg border border-zinc-200 px-2 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                                                            >
                                                                {t("auth.newConversationModelsMakeLead")}
                                                            </button>
                                                        )}
                                                        {defaultModelIds.length > 1 && (
                                                            <button
                                                                type="button"
                                                                aria-label={t("auth.newConversationModelsRemove")}
                                                                onClick={() => removeCombinationModel(index)}
                                                                className="shrink-0 rounded-lg p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-900 dark:hover:text-zinc-300"
                                                            >
                                                                <X className="h-4 w-4" />
                                                            </button>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                            {defaultModelIds.length < 3 && (
                                                <button
                                                    type="button"
                                                    data-testid="settings-combination-add"
                                                    onClick={addCombinationModel}
                                                    className="mt-2 w-full rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                                                >
                                                    {t("auth.newConversationModelsAdd")}
                                                </button>
                                            )}
                                            <p
                                                data-testid="settings-combination-total"
                                                className="mt-2 text-xs font-bold text-zinc-500"
                                            >
                                                {formatCopy("auth.newConversationModelsTotal", {
                                                    credits: String(combinationTotalCredits),
                                                })}
                                            </p>
                                            {defaultModelIds.length === 1 && (
                                                <p className="mt-1 text-xs leading-5 text-zinc-500">
                                                    {t("auth.newConversationModelsSingleHint")}
                                                </p>
                                            )}
                                            {hasPlanLockedModels && settingsPlan === "Free" && (
                                                <p className="mt-1 text-xs leading-5 text-zinc-500">
                                                    {t("auth.newConversationModelsPlanLockedHint")}{" "}
                                                    <UpgradeCtaLink
                                                        targetPlan="Pro"
                                                        currentPlan={settingsPlan}
                                                        trigger="account"
                                                        ctaLocation="settings_new_conversation_models"
                                                        testId="settings-combination-upgrade"
                                                        className="font-semibold text-blue-600 hover:underline dark:text-blue-300"
                                                    >
                                                        {t("auth.newConversationModelsPlanLockedCta")}
                                                    </UpgradeCtaLink>
                                                </p>
                                            )}
                                            {newlyAddedHighCostModelIds.length > 0 && (
                                                <label className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5 dark:bg-amber-950/30">
                                                    <input
                                                        type="checkbox"
                                                        data-testid="settings-high-cost-consent"
                                                        checked={highCostAcknowledged}
                                                        onChange={(e) =>
                                                            setHighCostAcknowledged(e.target.checked)
                                                        }
                                                        className="mt-0.5"
                                                    />
                                                    <span className="text-xs leading-5 text-amber-800 dark:text-amber-200">
                                                        {t("auth.newConversationModelsHighCostConsent")}
                                                    </span>
                                                </label>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                closeSettingsModal();
                                                requestAnimationFrame(() => openModelFinder());
                                            }}
                                            className="flex w-full items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-3 text-sm font-bold text-blue-700 transition hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-200 dark:hover:bg-blue-950/40"
                                        >
                                            <Bot className="h-4 w-4" />
                                            {t("modelFinder.findAgain")}
                                        </button>
                                    </div>
                                )}

                                {activeSettingsTab === "data" && (
                                    <div className="space-y-4">
                                        {/*
                                          One group, two rows -- not two
                                          full-width cards. Import and memory
                                          stay separate features with separate
                                          detail pages and separate state, but
                                          on the settings list they are
                                          siblings, and stacking a card each
                                          made them read as two unrelated
                                          headline destinations on a tab that
                                          has five other things on it.
                                        */}
                                        <section
                                            className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
                                            data-testid="settings-data-personalization"
                                        >
                                            <h3 className="text-sm font-bold">{t("settingsNav.dataAndPersonalization")}</h3>
                                            <p className="mt-1 text-sm leading-6 text-zinc-500">{t("settingsNav.dataAndPersonalizationDescription")}</p>
                                            <div className="mt-3">
                                                {externalImportEntry.kind === "ready" && (
                                                    <SettingsEntryRow
                                                        section="external-import"
                                                        href="/settings/imports"
                                                        icon={Database}
                                                        title={t("externalImport.dataTabTitle")}
                                                        description={t("externalImport.dataTabDescription")}
                                                        status={
                                                            externalImportEntry.conversations > 0
                                                                ? formatCopy("externalImport.dataTabUsage", {
                                                                      conversations: String(externalImportEntry.conversations),
                                                                      storage: `${(externalImportEntry.bytes / (1024 * 1024)).toFixed(1)} MB`,
                                                                  })
                                                                : t("externalImport.dataTabUsageEmpty")
                                                        }
                                                        actionLabel={t("externalImport.dataTabOpen")}
                                                        onNavigate={closeSettingsModal}
                                                        testId="external-import-entry"
                                                        linkTestId="external-import-entry-link"
                                                    />
                                                )}
                                                <SettingsEntryRow
                                                    section="memory"
                                                    href="/settings/memory"
                                                    icon={Brain}
                                                    title={t("memoryReview.dataTabTitle")}
                                                    description={t("memoryReview.dataTabDescription")}
                                                    status={memoryEntryStatusText}
                                                    actionLabel={t("memoryReview.dataTabOpen")}
                                                    onNavigate={closeSettingsModal}
                                                    testId="memory-entry"
                                                    linkTestId="memory-entry-link"
                                                />
                                            </div>
                                        </section>
                                        {listImportableGuestConversations().length > 0 && (
                                            <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                                <h3 className="text-sm font-bold">{t("auth.guestImportSectionTitle")}</h3>
                                                <p className="mt-1 text-sm leading-6 text-zinc-500">{t("auth.guestImportSectionDisclaimer")}</p>
                                                <button
                                                    type="button"
                                                    onClick={() => openGuestImportModal()}
                                                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-3 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                                >
                                                    <Database className="h-4 w-4" />
                                                    {t("auth.guestImportSectionTitle")}
                                                </button>
                                            </section>
                                        )}
                                        <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/60">
                                            <h3 className="text-sm font-bold">{t("auth.dataExportTitle")}</h3>
                                            <p className="mt-1 text-sm leading-6 text-zinc-500">{t("auth.dataExportDescription")}</p>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    // Not a page navigation: the route answers with a
                                                    // file download, so the browser saves the response
                                                    // and this page stays mounted.
                                                    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
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
                                            <h3 className="text-sm font-bold">{t("auth.dataRetentionTitle")}</h3>
                                            <p className="mt-1 text-sm leading-6 text-zinc-500">{t("auth.dataRetentionDescription")}</p>
                                            <p className="mt-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-200">
                                                {t("auth.attachmentRetentionNotice")}
                                            </p>
                                        </section>
                                        <section className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-950/70 dark:bg-red-950/20">
                                            <h3 className="text-sm font-bold text-red-700 dark:text-red-300">{t("auth.dangerZone")}</h3>
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
                                                    <h3 className="mt-1 text-lg font-bold text-zinc-900 dark:text-zinc-100">
                                                        {accountPlan ? t(`auth.${accountPlan.toLowerCase()}Plan`) : t("auth.loading")}
                                                    </h3>
                                                </div>
                                                <span className={`rounded-full px-3 py-1 text-xs font-bold text-white ${accountPlan === "Free" ? "bg-status-success-600" : accountPlan === "Pro" ? "bg-blue-600" : accountPlan === "Max" ? "bg-accent-plan-max-600" : "bg-zinc-600"}`}>
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
                                                    <h3 className="text-sm font-bold text-blue-800 dark:text-blue-200">
                                                        {t("auth.cancelPlanTitle")}
                                                    </h3>
                                                    <p className="mt-1 text-sm leading-6 text-blue-800/80 dark:text-blue-100/80">
                                                        {formatCopy("auth.cancelPlanDescription", {
                                                            date: planPeriodEndLabel || t("auth.cancelPlanFallbackDate"),
                                                        })}
                                                    </p>
                                                    <button
                                                        type="button"
                                                        onClick={handleCancelSubscription}
                                                        disabled={isCancellingSubscription || subscriptionCancelAtPeriodEnd}
                                                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-blue-300 bg-white px-3 py-3 text-sm font-bold text-blue-700 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-100 dark:hover:bg-blue-950/70"
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
                                                    <h3 className="text-sm font-bold text-amber-800 dark:text-amber-200">
                                                        {t("auth.refundRequestTitle")}
                                                    </h3>
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
                                                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-amber-300 bg-white px-3 py-3 text-sm font-bold text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-950/70"
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
                                                <div className="rounded-2xl border border-status-success-200 bg-status-success-50 p-4 dark:border-status-success-900/50 dark:bg-status-success-950/20">
                                                    <p className="text-xs font-bold uppercase tracking-wide text-status-success-600 dark:text-status-success-300">
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
                                            <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{t("auth.planPolicyTitle")}</h3>
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
                                                className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-3 text-sm font-bold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
                                            >
                                                <CreditCard className="h-4 w-4" />
                                                {accountPlan === "Pro" ? (globalLang === "ko" ? "Max로 업그레이드" : "Upgrade to Max") : t("billing.joinProWaitlist")}
                                            </UpgradeInterestButton>}
                                            <CreditPackPurchaseButton
                                                trigger="account"
                                                ctaLocation="account_settings_billing"
                                                returnTo={`/chat?lang=${encodeURIComponent(globalLang)}`}
                                                className="flex w-full items-center justify-center gap-2 rounded-xl border border-accent-plan-max-300 bg-accent-plan-max-50 px-3 py-3 text-sm font-bold text-accent-plan-max-700 transition-colors hover:bg-accent-plan-max-100 disabled:cursor-not-allowed disabled:opacity-70 dark:border-accent-plan-max-900/60 dark:bg-accent-plan-max-950/30 dark:text-accent-plan-max-200 dark:hover:bg-accent-plan-max-950/50"
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
                                        className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
                                            mobileUpgradePlan === "Max"
                                                ? "bg-accent-plan-max-600 hover:bg-accent-plan-max-500"
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
                    className="fixed inset-0 z-[140] flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center sm:p-4"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) closeDeleteAccountModal();
                    }}
                >
                    <div
                        ref={deleteAccountDialogRef}
                        data-testid="delete-account-dialog"
                        className="max-h-full w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-red-300 bg-white p-5 shadow-2xl dark:border-red-900/70 dark:bg-zinc-900"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="delete-account-modal-title"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <h2 id="delete-account-modal-title" className="text-sm font-bold text-red-700 dark:text-red-200">
                                {t("auth.deleteAccountImmediateTitle")}
                            </h2>
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
                                className="flex items-center justify-center gap-2 rounded-xl border border-red-300 bg-red-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800"
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
                    className="fixed inset-0 z-[140] flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center sm:p-4"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) closeAddEmailModal();
                    }}
                >
                    <div
                        ref={addEmailDialogRef}
                        data-testid="add-email-dialog"
                        className="max-h-full w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="add-email-modal-title"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <h2 id="add-email-modal-title" className="text-sm font-bold">
                                {t("auth.addLoginMethod")}
                            </h2>
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
                                        className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
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
      {/*
        SHORT-VIEWPORT-001: wrapping, not overflowing. At 200% text scaling the
        analytics button's own label is wider than the whole sidebar drawer, and
        as a `shrink-0` item on a nowrap row it pushed 168px of itself outside
        the panel. It now takes a second row instead, and can shrink from there.
      */}
      {/*
        REAUDIT-P1-02. Both controls on this row were 40px tall (measured
        170.42x40 and 98.97x40 at 320x568), a few pixels under the 44px touch
        floor the rest of the drawer already holds. `min-h-11` raises the hit
        area itself -- the label keeps its size and the row keeps its density,
        so nothing is hidden or demoted to buy the height.
      */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => {
            trackProductEvent("cta_start_click", 0, {
              cta_location: "account_login",
            });
            void signIn(undefined, { callbackUrl: chatCallbackUrl });
          }}
          className="flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-blue-950/20 transition-all hover:bg-blue-500"
        >
          {t("auth.login")}
        </button>
        {showAnalyticsCookieButton && (
          <button
            type="button"
            data-testid="guest-analytics-cookie-settings"
            onClick={() => openAnalyticsPreferences()}
            className="flex min-h-11 min-w-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-100 px-3 py-2.5 text-xs font-bold text-zinc-600 transition-colors hover:bg-zinc-200 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {t("auth.analyticsCookieSettings")}
          </button>
        )}
      </div>
    </div>
  );
}
