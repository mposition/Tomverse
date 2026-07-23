"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signIn, signOut, useSession } from "next-auth/react";
import {
    CreditCard,
    Crown,
    LogOut,
    Palette,
    Settings,
    UserRound,
    CircleHelp,
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { UserUsageResponse } from "@/components/chat/useUserUsage";
import { openAccountSettings } from "@/lib/accountSettingsEvents";
import { helpCentreHref } from "@/lib/localizedHelpHref";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { UpgradeCtaLink } from "@/components/billing/UpgradeCtaLink";

// Dedicated compact account entry point for the collapsed sidebar rail.
// The full account card + settings modal (components/auth/AuthButton.tsx)
// only renders in the expanded sidebar; reaching it from the collapsed
// rail required expanding the whole sidebar first. This renders just an
// avatar trigger plus a lightweight popover, and reuses AuthButton's own
// settings modal (via openAccountSettings) rather than duplicating it.
export function SidebarAccountRailButton({
    accountUsage = null,
}: {
    accountUsage?: UserUsageResponse | null;
}) {
    const { data: session } = useSession();
    const { t, lang } = useLanguage();
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        const closeOnOutsideClick = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsOpen(false);
                triggerRef.current?.focus();
            }
        };
        document.addEventListener("pointerdown", closeOnOutsideClick);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOnOutsideClick);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [isOpen]);

    const chatCallbackUrl = withChatLanguage("/chat", lang);
    const user = session?.user;
    const plan = accountUsage?.plan || null;
    const upgradeTargetPlan = plan === "Free" ? "Pro" : plan === "Pro" ? "Max" : null;

    return (
        <div ref={containerRef} className="group/account relative inline-flex">
            <button
                ref={triggerRef}
                type="button"
                data-testid="sidebar-rail-account-trigger"
                aria-label={t(user ? "sidebar.accountTooltip" : "sidebar.accountTooltipGuest")}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                onClick={() => setIsOpen((current) => !current)}
                className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-teal-600 text-sm font-black text-white ring-1 ring-teal-400/50 transition hover:ring-2 hover:ring-teal-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-teal-700 dark:ring-teal-400/40"
            >
                {user ? (
                    user.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={user.image} alt="" className="h-full w-full object-cover" />
                    ) : (
                        (user.name?.[0] || user.email?.[0] || "T").toUpperCase()
                    )
                ) : (
                    <UserRound className="h-5 w-5" aria-hidden="true" />
                )}
            </button>
            {!isOpen ? (
                <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-0 left-full z-50 ml-2 hidden w-max max-w-56 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-bold text-zinc-700 shadow-xl group-hover/account:block group-focus-within/account:block dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                >
                    {t(user ? "sidebar.accountTooltip" : "sidebar.accountTooltipGuest")}
                </span>
            ) : null}
            {isOpen ? (
                <div
                    role="menu"
                    aria-label={t(user ? "auth.accountMenu" : "sidebar.accountTooltipGuest")}
                    className="absolute bottom-0 left-full z-[75] ml-2 w-64 rounded-2xl border border-zinc-200 bg-white p-2 text-left shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
                >
                    {user ? (
                        <>
                            <div className="flex min-w-0 items-center gap-2 border-b border-zinc-200 p-2 pb-3 dark:border-zinc-800">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-teal-600 text-sm font-black text-white">
                                    {user.image ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={user.image} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                        (user.name?.[0] || user.email?.[0] || "T").toUpperCase()
                                    )}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-black text-zinc-900 dark:text-zinc-100">
                                        {user.name || user.email || "Tomverse"}
                                    </span>
                                    {user.name && user.email ? (
                                        <span className="block truncate text-[11px] text-zinc-400">{user.email}</span>
                                    ) : null}
                                </span>
                                {plan ? (
                                    <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-black text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                                        {t(`modelTiers.${plan.toLowerCase()}`)}
                                    </span>
                                ) : null}
                            </div>
                            <div className="mt-1 space-y-1">
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        setIsOpen(false);
                                        openAccountSettings("plan");
                                    }}
                                    className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                >
                                    <CreditCard className="h-4 w-4 text-blue-500" aria-hidden="true" />
                                    {t("auth.usageAndPlan")}
                                </button>
                                {upgradeTargetPlan && accountUsage ? (
                                    <UpgradeCtaLink
                                        targetPlan={upgradeTargetPlan}
                                        currentPlan={accountUsage.plan}
                                        trigger="account"
                                        ctaLocation="sidebar_rail_account_menu"
                                        planCreditsRemaining={accountUsage.balances.planRemainingCredits}
                                        addonCreditsRemaining={accountUsage.balances.purchasedRemainingCredits}
                                        testId="sidebar-rail-upgrade-cta"
                                        onClick={() => setIsOpen(false)}
                                        className="flex min-h-11 w-full items-center gap-2 rounded-xl bg-blue-600 px-3 text-sm font-black text-white transition hover:bg-blue-500"
                                    >
                                        <Crown className="h-4 w-4" aria-hidden="true" />
                                        {upgradeTargetPlan === "Pro" ? t("upgrade.viewProPlan") : t("upgrade.viewMaxPlan")}
                                    </UpgradeCtaLink>
                                ) : null}
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        setIsOpen(false);
                                        openAccountSettings("account");
                                    }}
                                    className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                >
                                    <Settings className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                                    {t("auth.setting")}
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        setIsOpen(false);
                                        openAccountSettings("preferences");
                                    }}
                                    className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                >
                                    <Palette className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                                    {t("sidebar.languageAndDisplay")}
                                </button>
                                <Link
                                    href={helpCentreHref(lang)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    prefetch={false}
                                    role="menuitem"
                                    onClick={() => setIsOpen(false)}
                                    className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                >
                                    <CircleHelp className="h-4 w-4 text-blue-500" aria-hidden="true" />
                                    {t("sidebar.helpAndGuides")}
                                </Link>
                                <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        setIsOpen(false);
                                        void signOut();
                                    }}
                                    className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-sm font-bold text-zinc-600 transition hover:bg-red-50 hover:text-red-600 dark:text-zinc-300 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                                >
                                    <LogOut className="h-4 w-4" aria-hidden="true" />
                                    {t("auth.singedOut")}
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className="p-1">
                            <p className="px-2 text-sm font-black text-zinc-900 dark:text-zinc-100">
                                {t("sidebar.guestMenuTitle")}
                            </p>
                            <p className="mt-1 px-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                                {t("sidebar.guestMenuDescription")}
                            </p>
                            <button
                                type="button"
                                onClick={() => {
                                    setIsOpen(false);
                                    trackProductEvent("cta_start_click", 0, {
                                        cta_location: "sidebar_rail_account_menu",
                                    });
                                    void signIn(undefined, { callbackUrl: chatCallbackUrl });
                                }}
                                className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 text-sm font-black text-white transition hover:bg-blue-500"
                            >
                                {t("sidebar.guestMenuCreateAccount")}
                            </button>
                            <div className="mt-1 space-y-1">
                                <Link
                                    href={`/pricing?lang=${encodeURIComponent(lang)}`}
                                    onClick={() => setIsOpen(false)}
                                    className="flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                >
                                    <CreditCard className="h-4 w-4 text-blue-500" aria-hidden="true" />
                                    {t("sidebar.guestMenuViewPlans")}
                                </Link>
                                <Link
                                    href={helpCentreHref(lang)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    prefetch={false}
                                    onClick={() => setIsOpen(false)}
                                    className="flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-sm font-bold text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                                >
                                    <CircleHelp className="h-4 w-4 text-blue-500" aria-hidden="true" />
                                    {t("sidebar.helpAndGuides")}
                                </Link>
                            </div>
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
}
