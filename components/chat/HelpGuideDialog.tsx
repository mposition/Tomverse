"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { useHelpGuideEnabledFlagKeys } from "@/components/chat/HelpGuideAccess";
import { openAccountSettings } from "@/lib/accountSettingsEvents";
import { openFeedbackDialog } from "@/lib/feedbackDialogEvents";
import {
    answerHelpIntent,
    helpIntentCopyKey,
    type HelpGuideOffer,
    type HelpGuideViewer,
} from "@/lib/helpGuide";
import { HELP_INTENTS } from "@/lib/helpNavigationIntents";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";

/**
 * HELP-NAV-01 guided help. The user picks a task from the registered intents
 * and is shown where it is done. There is no text box: nothing the user types
 * is matched, and the guide reads nothing but session and flag state.
 *
 * Nothing here navigates the chat page, because the composer's unsent draft
 * lives in memory. Settings open in the in-page settings dialog, reading pages
 * and sign-in open in a new tab, and a report opens the page's own feedback
 * dialog for the user to write. See `lib/helpGuide.ts`.
 */
export function HelpGuideDialog({
    open,
    onClose,
    returnFocusRef,
}: {
    open: boolean;
    onClose: () => void;
    /**
     * Where focus goes when the guide closes. The menu item that opened it has
     * already unmounted by then, so without this focus would fall to the page.
     */
    returnFocusRef?: RefObject<HTMLElement | null>;
}) {
    const { t, lang } = useLanguage();
    const { status } = useSession();
    const enabledFlagKeys = useHelpGuideEnabledFlagKeys();
    const [intentId, setIntentId] = useState<string | null>(null);
    const [feedbackUnavailable, setFeedbackUnavailable] = useState(false);
    const titleId = useId();
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const headingRef = useRef<HTMLHeadingElement | null>(null);
    /** The intent button to return focus to when going back to the list. */
    const lastIntentRef = useRef<string | null>(null);

    const close = useCallback(() => {
        setIntentId(null);
        setFeedbackUnavailable(false);
        onClose();
    }, [onClose]);

    useModalDialog({ open, onClose: close, dialogRef, panelRef, returnFocusRef });

    const viewer: HelpGuideViewer = useMemo(
        () => ({ signedIn: status === "authenticated", enabledFlagKeys, lang }),
        [status, enabledFlagKeys, lang]
    );
    const answer = intentId ? answerHelpIntent(intentId, viewer) : null;

    // Moving between the list and one task replaces the panel's content, so
    // focus moves with it: to the task's heading, or back to the task the user
    // came from.
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => {
            if (intentId) {
                headingRef.current?.focus();
            } else if (lastIntentRef.current) {
                panelRef.current
                    ?.querySelector<HTMLElement>(`[data-help-intent="${lastIntentRef.current}"]`)
                    ?.focus();
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [intentId, open]);

    if (!open) return null;

    const act = (offer: HelpGuideOffer) => {
        if (offer.availability !== "open") return;
        const action = offer.action;
        if (action.type === "new-tab") return; // rendered as a link
        if (action.type === "open-settings") {
            close();
            openAccountSettings(action.tab, action.section);
            return;
        }
        if (openFeedbackDialog()) {
            close();
        } else {
            setFeedbackUnavailable(true);
        }
    };

    const signInHref = `/auth/signin?callbackUrl=${encodeURIComponent(
        withChatLanguage(typeof window === "undefined" ? "/chat" : window.location.pathname, lang)
    )}`;

    const rowClass =
        "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-bold text-zinc-800 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-100 dark:hover:bg-zinc-800";

    return (
        <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-testid="help-guide-dialog"
            className="fixed inset-0 z-[130] flex items-end justify-center bg-black/40 backdrop-blur-sm md:items-center"
        >
            <button
                type="button"
                className="absolute inset-0 h-full w-full cursor-default"
                onClick={close}
                aria-label={t("helpGuide.close")}
                tabIndex={-1}
            />
            <div
                ref={panelRef}
                className="relative z-10 flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-y-auto overscroll-contain rounded-t-3xl border border-zinc-200 bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-left shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 md:max-w-lg md:rounded-3xl md:pb-4"
            >
                <div className="flex items-start justify-between gap-2">
                    {answer ? (
                        <button
                            type="button"
                            data-testid="help-guide-back"
                            onClick={() => {
                                setFeedbackUnavailable(false);
                                setIntentId(null);
                            }}
                            className="inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-sm font-bold text-blue-700 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300 dark:hover:bg-blue-950/40"
                        >
                            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                            {t("helpGuide.back")}
                        </button>
                    ) : (
                        <h2 id={titleId} className="px-1 pt-2 text-base font-bold text-zinc-900 dark:text-zinc-50">
                            {t("helpGuide.title")}
                        </h2>
                    )}
                    <button
                        type="button"
                        data-testid="help-guide-close"
                        onClick={close}
                        aria-label={t("helpGuide.close")}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-zinc-900"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                {!answer ? (
                    <>
                        <p className="mt-1 px-1 text-[13px] leading-5 text-zinc-600 dark:text-zinc-300">
                            {t("helpGuide.intro")}
                        </p>
                        <ul className="mt-3 space-y-1" data-testid="help-guide-intents">
                            {HELP_INTENTS.map((intent) => (
                                <li key={intent.id}>
                                    <button
                                        type="button"
                                        data-help-intent={intent.id}
                                        data-testid={`help-guide-intent-${intent.id}`}
                                        onClick={() => {
                                            lastIntentRef.current = intent.id;
                                            setIntentId(intent.id);
                                        }}
                                        className={rowClass}
                                    >
                                        <span className="min-w-0 flex-1">{t(`${helpIntentCopyKey(intent.id)}.label`)}</span>
                                        <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </>
                ) : (
                    <section data-testid="help-guide-answer" data-intent={answer.intentId} className="mt-1 px-1">
                        <h2
                            id={titleId}
                            ref={headingRef}
                            tabIndex={-1}
                            className="text-base font-bold text-zinc-900 focus:outline-none dark:text-zinc-50"
                        >
                            {t(`${answer.copyKey}.label`)}
                        </h2>
                        <p className="mt-2 text-[13px] leading-6 text-zinc-700 dark:text-zinc-200">
                            {t(`${answer.copyKey}.guide`)}
                        </p>

                        {answer.steps.length > 0 ? (
                            <>
                                <h3 className="mt-4 text-xs font-bold uppercase tracking-wide text-zinc-500">
                                    {t("helpGuide.stepsTitle")}
                                </h3>
                                <ol className="mt-1 list-decimal space-y-1 pl-5 text-[13px] leading-6 text-zinc-700 dark:text-zinc-200" data-testid="help-guide-steps">
                                    {answer.steps.map((step) => (
                                        <li key={step.label} data-step={step.label} data-available={step.available}>
                                            {t(`helpGuide.steps.${step.label}`)}
                                            {step.available ? null : (
                                                <span className="ml-1 text-zinc-500">({t("helpGuide.stepUnavailable")})</span>
                                            )}
                                        </li>
                                    ))}
                                </ol>
                            </>
                        ) : null}

                        <h3 className="mt-4 text-xs font-bold uppercase tracking-wide text-zinc-500">
                            {t("helpGuide.whereToGo")}
                        </h3>
                        <ul className="mt-1 space-y-2" data-testid="help-guide-offers">
                            {answer.offers.map((offer) => (
                                <li
                                    key={offer.copyKey}
                                    data-testid="help-guide-offer"
                                    data-kind={offer.destination.kind}
                                    data-availability={offer.availability}
                                >
                                    {offer.availability === "open" && offer.action.type === "new-tab" ? (
                                        <a
                                            href={offer.action.href}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={rowClass}
                                        >
                                            <span className="min-w-0 flex-1">{t(offer.copyKey)}</span>
                                            <ExternalLink className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                                            <span className="sr-only">{t("helpGuide.opensInNewTab")}</span>
                                        </a>
                                    ) : offer.availability === "open" ? (
                                        <button type="button" onClick={() => act(offer)} className={rowClass}>
                                            <span className="min-w-0 flex-1">{t(offer.copyKey)}</span>
                                            <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                                        </button>
                                    ) : offer.availability === "sign-in" ? (
                                        <div className="rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                                            <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{t(offer.copyKey)}</p>
                                            <p className="mt-0.5 text-[13px] text-zinc-600 dark:text-zinc-300">{t("helpGuide.signInRequired")}</p>
                                            <a
                                                href={signInHref}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-sm font-bold text-blue-700 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300 dark:hover:bg-blue-950/40"
                                            >
                                                {t("helpGuide.signIn")}
                                                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                                                <span className="sr-only">{t("helpGuide.opensInNewTab")}</span>
                                            </a>
                                        </div>
                                    ) : (
                                        <div className="rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                                            <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{t(offer.copyKey)}</p>
                                            <p className="mt-0.5 text-[13px] text-zinc-600 dark:text-zinc-300">{t("helpGuide.unavailable")}</p>
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                        {feedbackUnavailable ? (
                            <p role="status" className="mt-2 text-[13px] text-zinc-600 dark:text-zinc-300">
                                {t("helpGuide.unavailable")}
                            </p>
                        ) : null}
                    </section>
                )}
            </div>
        </div>
    );
}
