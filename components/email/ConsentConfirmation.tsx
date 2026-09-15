"use client";

import Link from "next/link";
import { useState } from "react";

import { useLanguage } from "@/components/LanguageProvider";

/**
 * The confirmation step of a marketing consent link.
 *
 * Contract: docs/policy/email-double-opt-in.md §3 rule 4, §5, §8.
 *
 * **Nothing happens until the button is pressed.** Rendering this page must not
 * change anything, because link scanners fetch it unprompted and a consent
 * created by a scanner is not a consent.
 *
 * No offer, no feature list, no second call to action: this page confirms and
 * nothing else, for the same reason the confirmation mail does.
 */
export function ConsentConfirmation({ token }: { token: string }) {
    const { t } = useLanguage();
    const [state, setState] = useState<
        "idle" | "working" | "done" | "expired" | "failed"
    >(token ? "idle" : "failed");

    const submit = async () => {
        if (state === "working") return;
        setState("working");
        try {
            const response = await fetch("/api/consent/confirm", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ t: token }),
            });
            const body = (await response.json().catch(() => null)) as {
                code?: string;
            } | null;
            if (response.ok) {
                setState("done");
                return;
            }
            setState(body?.code === "EXPIRED" ? "expired" : "failed");
        } catch {
            setState("failed");
        }
    };

    return (
        <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
            <h1 className="text-2xl font-black text-zinc-950 dark:text-white">
                {state === "done"
                    ? t("consentConfirm.doneTitle")
                    : t("consentConfirm.title")}
            </h1>

            {state === "done" ? (
                <p
                    className="text-sm leading-6 text-zinc-600 dark:text-zinc-300"
                    data-testid="consent-confirm-done"
                >
                    {t("consentConfirm.doneBody")}
                </p>
            ) : state === "expired" || state === "failed" ? (
                <>
                    <p
                        className="text-sm leading-6 text-zinc-600 dark:text-zinc-300"
                        data-testid="consent-confirm-error"
                    >
                        {state === "expired"
                            ? t("consentConfirm.expiredBody")
                            : t("consentConfirm.invalidBody")}
                    </p>
                    <Link
                        href="/settings/notifications"
                        className="text-sm font-semibold text-zinc-900 underline underline-offset-2 dark:text-white"
                    >
                        {t("consentConfirm.settingsLink")}
                    </Link>
                </>
            ) : (
                <>
                    <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                        {t("consentConfirm.body")}
                    </p>
                    <button
                        type="button"
                        disabled={state === "working"}
                        onClick={() => void submit()}
                        data-testid="consent-confirm-button"
                        className="min-h-11 w-full rounded-xl bg-zinc-950 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                    >
                        {t("consentConfirm.confirmButton")}
                    </button>
                </>
            )}
        </main>
    );
}
