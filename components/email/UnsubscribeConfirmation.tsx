"use client";

import { useState } from "react";

import { useLanguage } from "@/components/LanguageProvider";

/**
 * The confirmation step of an unsubscribe link.
 *
 * Contract: .github/audits/email-notification-architecture-2026-08-21.md §11.3.
 *
 * Deliberately small. Two decisions in it are worth stating:
 *
 *  - **Nothing happens until the button is pressed.** Rendering this page must
 *    not change anything, because link scanners and mail clients fetch it
 *    unprompted.
 *  - **No re-subscribe offer, no "are you sure", no survey.** The Australian
 *    rule forbids extra steps, and even where it does not apply, a person who
 *    has decided to leave and is made to argue about it reaches for the spam
 *    button instead -- which costs the sending domain far more than the
 *    subscription was worth.
 *
 * The undo link is not an extra step: it appears after the unsubscribe has
 * already taken effect, and only to catch a mis-click.
 */
export function UnsubscribeConfirmation({ token }: { token: string }) {
    const { t } = useLanguage();
    const [state, setState] = useState<"idle" | "working" | "done" | "failed">(
        token ? "idle" : "failed"
    );
    const [scope, setScope] = useState<"purpose" | "all">("purpose");

    const submit = async (all: boolean) => {
        if (state === "working") return;
        setState("working");
        try {
            const body = new URLSearchParams({ t: token });
            if (all) body.set("all", "1");
            const response = await fetch("/api/unsubscribe", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
            });
            if (!response.ok) {
                await response.text().catch(() => "");
                setState("failed");
                return;
            }
            await response.text().catch(() => "");
            setScope(all ? "all" : "purpose");
            setState("done");
        } catch {
            setState("failed");
        }
    };

    return (
        <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
            <h1 className="text-2xl font-black text-zinc-950 dark:text-white">
                {state === "done"
                    ? t("unsubscribe.doneTitle")
                    : t("unsubscribe.title")}
            </h1>

            {state === "done" ? (
                <>
                    <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                        {scope === "all"
                            ? t("unsubscribe.doneAllBody")
                            : t("unsubscribe.doneBody")}
                    </p>
                    <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        {t("unsubscribe.stillReceiveNote")}
                    </p>
                </>
            ) : state === "failed" ? (
                <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {t("unsubscribe.invalidBody")}
                </p>
            ) : (
                <>
                    <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                        {t("unsubscribe.body")}
                    </p>
                    <div className="flex flex-col gap-3">
                        <button
                            type="button"
                            disabled={state === "working"}
                            onClick={() => submit(false)}
                            className="w-full rounded-xl bg-zinc-950 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                        >
                            {t("unsubscribe.confirmButton")}
                        </button>
                        <button
                            type="button"
                            disabled={state === "working"}
                            onClick={() => submit(true)}
                            className="w-full text-center text-xs font-semibold text-zinc-500 hover:underline disabled:opacity-50 dark:text-zinc-400"
                        >
                            {t("unsubscribe.allButton")}
                        </button>
                    </div>
                    <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        {t("unsubscribe.stillReceiveNote")}
                    </p>
                </>
            )}
        </main>
    );
}
