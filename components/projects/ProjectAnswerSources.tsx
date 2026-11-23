"use client";

import { useState } from "react";
import { BookOpenCheck } from "lucide-react";
import type { ProjectAnswerReceipt, ProjectSourceRead } from "@tomverse/api-client";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import { ErrorLine, Spinner, projectUi, useCopy } from "./projectUi";
import { useProjectChatScope } from "./ProjectChatScope";

type ReceiptState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "failed"; error: unknown }
    | { status: "ready"; receipt: ProjectAnswerReceipt };

const PREVIEW_CHARACTERS = 1_200;

/**
 * "Project sources" under an assistant answer in a project conversation.
 *
 * The receipt lists what Tomverse *delivered* to the model with this answer.
 * It is not evidence of what the model relied on, and the copy says so; there
 * is deliberately no per-answer "N memories" badge. Opening an entry
 * re-validates it on the server, so a source that was deleted or locked since
 * shows as unavailable instead of its old text.
 */
export function ProjectAnswerSources({ messageId }: { messageId: string }) {
    const { t } = useCopy();
    const scope = useProjectChatScope();
    const client = webProjectWorkspaceClient();
    const [open, setOpen] = useState(false);
    const [state, setState] = useState<ReceiptState>({ status: "idle" });
    const [reads, setReads] = useState<Record<string, ProjectSourceRead | "loading" | "failed">>({});

    if (!scope.enabled || !scope.projectId || !scope.contextActive) return null;

    const load = async () => {
        setState({ status: "loading" });
        try {
            setState({ status: "ready", receipt: await client.receipt(messageId) });
        } catch (error) {
            setState({ status: "failed", error });
        }
    };

    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && state.status === "idle") void load();
    };

    const openSource = async (projectId: string, ref: string) => {
        setReads((current) => ({ ...current, [ref]: "loading" }));
        try {
            const read = await client.readSource(projectId, ref);
            setReads((current) => ({ ...current, [ref]: read }));
        } catch {
            setReads((current) => ({ ...current, [ref]: "failed" }));
        }
    };

    return (
        <div className="mt-2" data-testid="project-answer-sources">
            <button type="button" onClick={toggle} aria-expanded={open} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-zinc-600 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-300 dark:hover:bg-zinc-800" data-testid="project-answer-sources-toggle">
                <BookOpenCheck className="h-4 w-4" aria-hidden="true" />
                {t("projectWorkspace.receipt.toggle")}
            </button>
            {open && (
                <div className="mt-1 space-y-2 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800" data-testid="project-answer-sources-panel">
                    <p className={projectUi.muted}>{t("projectWorkspace.receipt.caveat")}</p>
                    {state.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
                    {state.status === "failed" && <ErrorLine error={state.error} onRetry={() => void load()} />}
                    {state.status === "ready" && (!state.receipt || state.receipt.sources.length === 0) && (
                        <p data-testid="project-receipt-empty">{t("projectWorkspace.receipt.empty")}</p>
                    )}
                    {state.status === "ready" && state.receipt && state.receipt.sources.length > 0 && (
                        <ul className="space-y-2" data-testid="project-receipt-list">
                            {state.receipt.sources.map((source) => {
                                const read = reads[source.ref];
                                const projectId = state.receipt?.projectId ?? scope.projectId;
                                return (
                                    <li key={source.ref} className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800" data-testid="project-receipt-source">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="min-w-0 flex-1 break-words font-semibold">{source.title}</span>
                                            <span className={projectUi.chip}>{t(`projectWorkspace.receipt.via.${source.via}`)}</span>
                                            <button type="button" disabled={!projectId || read === "loading"} onClick={() => projectId && void openSource(projectId, source.ref)} className={projectUi.button} data-testid="project-receipt-open">
                                                {t("projectWorkspace.receipt.open")}
                                            </button>
                                        </div>
                                        {read === "loading" && <p className={projectUi.muted} role="status">{t("projectWorkspace.loading")}</p>}
                                        {read === "failed" && <p role="alert" className="text-red-700 dark:text-red-300">{t("projectWorkspace.errors.generic")}</p>}
                                        {read && read !== "loading" && read !== "failed" && (
                                            read.status === "ok" ? (
                                                <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-800" data-testid="project-receipt-preview">{read.content.slice(0, PREVIEW_CHARACTERS)}</pre>
                                            ) : (
                                                <p className="mt-2 text-amber-800 dark:text-amber-200" role="status" data-testid="project-receipt-unavailable">{t("projectWorkspace.receipt.unavailable")}</p>
                                            )
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
