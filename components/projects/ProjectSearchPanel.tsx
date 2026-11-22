"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Loader2, Paperclip, Search } from "lucide-react";
import type { ProjectSearchAnswer, ProjectSearchHit, ProjectSourceRead } from "@tomverse/api-client";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import { MAX_PROJECT_REFERENCES, projectErrorKey } from "@/lib/projectWorkspaceUi";
import { ErrorLine, projectUi, useCopy } from "./projectUi";

type SearchState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "done"; query: string; answer: ProjectSearchAnswer }
    | { status: "failed"; error: unknown };

const PREVIEW_CHARACTERS = 1_500;

/**
 * Search inside one project and pick results to attach to the next question.
 *
 * Results can be partial (some conversations or materials could not be read);
 * that is shown, never hidden, because "nothing found" and "could not check
 * everything" lead the owner to different next steps.
 */
export function ProjectSearchPanel({
    projectId,
    selected,
    onToggle,
    onOpenHit,
    compact = false,
    autoFocus = false,
}: {
    projectId: string;
    selected: readonly ProjectSearchHit[];
    onToggle: (hit: ProjectSearchHit) => void;
    onOpenHit?: (hit: ProjectSearchHit) => void;
    compact?: boolean;
    autoFocus?: boolean;
}) {
    const { t, tf } = useCopy();
    const [query, setQuery] = useState("");
    const [state, setState] = useState<SearchState>({ status: "idle" });
    const [previews, setPreviews] = useState<Record<string, ProjectSourceRead | "loading" | "failed">>({});
    const controller = useRef<AbortController | null>(null);
    const currentProject = useRef(projectId);

    useEffect(() => {
        currentProject.current = projectId;
        controller.current?.abort();
        // Another project: nothing from the previous one may stay on screen.
        queueMicrotask(() => {
            setState({ status: "idle" });
            setPreviews({});
        });
    }, [projectId]);

    useEffect(() => () => controller.current?.abort(), []);

    const submit = async (event?: FormEvent) => {
        event?.preventDefault();
        const text = query.trim();
        if (!text) return;
        controller.current?.abort();
        const next = new AbortController();
        controller.current = next;
        setState({ status: "loading" });
        setPreviews({});
        try {
            const answer = await webProjectWorkspaceClient().search(projectId, text, next.signal);
            if (!next.signal.aborted) setState({ status: "done", query: text, answer });
        } catch (error) {
            if (!next.signal.aborted) setState({ status: "failed", error });
        }
    };

    const preview = async (hit: ProjectSearchHit) => {
        if (previews[hit.ref] && previews[hit.ref] !== "failed") return;
        setPreviews((current) => ({ ...current, [hit.ref]: "loading" }));
        try {
            const read = await webProjectWorkspaceClient().readSource(projectId, hit.ref);
            if (currentProject.current === projectId) setPreviews((current) => ({ ...current, [hit.ref]: read }));
        } catch {
            setPreviews((current) => ({ ...current, [hit.ref]: "failed" }));
        }
    };

    const selectedRefs = new Set(selected.map((hit) => hit.ref));
    const limitReached = selected.length >= MAX_PROJECT_REFERENCES;

    return (
        <section data-testid="project-search" aria-label={t("projectWorkspace.search.title")} className={compact ? "space-y-2" : `${projectUi.card} space-y-3`}>
            {!compact && <h3 className="text-base font-bold">{t("projectWorkspace.search.title")}</h3>}
            <form onSubmit={(event) => void submit(event)} className="flex gap-2" role="search">
                <label className="sr-only" htmlFor={`project-search-${projectId}`}>{t("projectWorkspace.search.label")}</label>
                <input
                    id={`project-search-${projectId}`}
                    data-testid="project-search-input"
                    value={query}
                    autoFocus={autoFocus}
                    maxLength={500}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("projectWorkspace.search.placeholder")}
                    className={projectUi.input}
                />
                <button type="submit" disabled={!query.trim() || state.status === "loading"} className={projectUi.primary} data-testid="project-search-submit">
                    {state.status === "loading" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Search className="h-4 w-4" aria-hidden="true" />}
                    <span>{t("projectWorkspace.search.submit")}</span>
                </button>
            </form>
            {state.status === "failed" && <ErrorLine error={state.error} onRetry={() => void submit()} testId="project-search-error" />}
            {state.status === "done" && (
                <div className="space-y-2" data-testid="project-search-results" data-search-status={state.answer.status}>
                    {state.answer.status === "partial" && (
                        <p role="status" data-testid="project-search-partial" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
                            {t("projectWorkspace.search.partial")}
                        </p>
                    )}
                    {state.answer.hits.length === 0 ? (
                        <p className={projectUi.muted} data-testid="project-search-empty">
                            {state.answer.status === "partial" ? t("projectWorkspace.search.emptyPartial") : tf("projectWorkspace.search.empty", { query: state.query })}
                        </p>
                    ) : (
                        <>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("projectWorkspace.search.referenceHint")}</p>
                            <ul className="space-y-2">
                                {state.answer.hits.map((hit) => {
                                    const isSelected = selectedRefs.has(hit.ref);
                                    const read = previews[hit.ref];
                                    return (
                                        <li key={hit.ref} data-testid="project-search-hit" data-ref={hit.ref} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="min-w-0 flex-1 break-words text-sm font-semibold">{hit.title}</span>
                                                <span className={projectUi.chip}>{t(`projectWorkspace.search.kind.${hit.location.kind}`)}</span>
                                            </div>
                                            <p className="mt-1 break-words text-sm text-zinc-700 dark:text-zinc-300">{hit.snippet}</p>
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {onOpenHit && (
                                                    <button type="button" onClick={() => onOpenHit(hit)} className={projectUi.button} data-testid="project-search-open">
                                                        {t("projectWorkspace.search.open")}
                                                    </button>
                                                )}
                                                <button type="button" onClick={() => void preview(hit)} className={projectUi.button} data-testid="project-search-preview">
                                                    {t("projectWorkspace.search.preview")}
                                                </button>
                                                <button
                                                    type="button"
                                                    aria-pressed={isSelected}
                                                    disabled={!isSelected && limitReached}
                                                    onClick={() => onToggle(hit)}
                                                    className={isSelected ? projectUi.primary : projectUi.button}
                                                    data-testid="project-search-attach"
                                                >
                                                    {isSelected ? <Check className="h-4 w-4" aria-hidden="true" /> : <Paperclip className="h-4 w-4" aria-hidden="true" />}
                                                    {t(isSelected ? "projectWorkspace.search.attached" : "projectWorkspace.search.attach")}
                                                </button>
                                            </div>
                                            {!isSelected && limitReached && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{tf("projectWorkspace.search.limit", { max: MAX_PROJECT_REFERENCES })}</p>}
                                            {read === "loading" && <p className={`${projectUi.muted} mt-2`} role="status">{t("projectWorkspace.loading")}</p>}
                                            {read === "failed" && <p className="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">{t(projectErrorKey(null))}</p>}
                                            {read && read !== "loading" && read !== "failed" && (
                                                read.status === "ok" ? (
                                                    <pre data-testid="project-source-preview" className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{read.content.slice(0, PREVIEW_CHARACTERS)}</pre>
                                                ) : (
                                                    <p className="mt-2 text-sm text-amber-800 dark:text-amber-200" role="status" data-testid="project-source-unavailable">{t("projectWorkspace.search.unavailable")}</p>
                                                )
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    )}
                </div>
            )}
        </section>
    );
}
