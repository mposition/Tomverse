"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

/** Keep conditional processing visible until both account readings resolve. */
export function ImportMemoryNotice() {
    const { t } = useLanguage();
    const state = useImportMemoryState();
    return (
        <div
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            data-testid="external-import-memory-notice"
        >
            <Brain className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
            <p>
                {t(
                    state === "off"
                        ? "journey.memoryOff"
                        : state === "unavailable"
                          ? "journey.memoryUnavailable"
                          : "journey.memoryConditional",
                )}{" "}
                <Link
                    href="/settings/memory"
                    target="_blank"
                    rel="noopener"
                    className="font-semibold text-blue-600 hover:underline dark:text-blue-300"
                >
                    {t("memoryReview.importNoticeSettings")}
                </Link>
                {" · "}
                <Link
                    href="/privacy"
                    target="_blank"
                    rel="noopener"
                    className="font-semibold text-blue-600 hover:underline dark:text-blue-300"
                >
                    {t("memoryReview.importNoticePrivacy")}
                </Link>
            </p>
        </div>
    );
}

/** These are account-wide signals, never an assertion that this file has finished. */
export function useImportMemoryState() {
    const [state, setState] = useState<
        "unknown" | "off" | "available" | "organising" | "unavailable"
    >("unknown");
    useEffect(() => {
        let controller: AbortController;
        const refresh = () => {
            controller?.abort();
            controller = new AbortController();
            const signal = controller.signal;
            const read = async (path: string) => {
                const response = await fetch(path, {
                    cache: "no-store",
                    signal,
                });
                return {
                    ok: response.ok,
                    body: await response.json().catch(() => null),
                };
            };
            // Either endpoint can be slow or unavailable. A confirmed account opt-out
            // is conclusive without waiting for the unrelated run-history endpoint.
            let master: boolean | undefined;
            let runs: "unknown" | "available" | "organising" | "unavailable" = "unknown";
            const publish = () => {
                if (!signal.aborted) setState(master === false ? "off" :
                    runs === "unavailable" ? runs : master === true ? runs : "unknown");
            };
            void read("/api/memories/settings").then(result => {
                master = result.ok && typeof result.body?.masterEnabled === "boolean"
                    ? result.body.masterEnabled : undefined;
                publish();
            }).catch(publish);
            void read("/api/memories/extraction-runs").then(result => {
                runs = result.body?.code === "MEMORY_FEATURE_DISABLED" ? "unavailable"
                    : result.ok ? (result.body?.activeRunId ? "organising" : "available") : "unknown";
                publish();
            }).catch(publish);

        };
        refresh();
        window.addEventListener("focus", refresh);
        return () => {
            controller.abort();
            window.removeEventListener("focus", refresh);
        };
    }, []);
    return state;
}
