"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderPlus, Loader2 } from "lucide-react";
import type { MaterialSource, ProjectMaterial, ProjectSummary } from "@tomverse/api-client";
import { useModalDialog } from "@/components/useModalDialog";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import { createRequestIdMemo, materialIntentKey } from "@/lib/projectWorkspaceUi";
import { ErrorLine, Spinner, projectUi, useCopy, useProjectResource } from "./projectUi";
import { useProjectChatScope } from "./ProjectChatScope";

// One memo for the page: a retry of the same save (same source, same project)
// keeps its client request id and so returns the same copy.
const requestIds = createRequestIdMemo();

type SourceInput = MaterialSource | (() => Promise<MaterialSource>);

type SaveState =
    | { status: "idle" }
    | { status: "saving" }
    | { status: "failed"; error: unknown }
    | { status: "saved"; created: boolean; file: ProjectMaterial; projectId: string };

/**
 * "Save to project materials": an entry point on a generated file, an
 * attachment, a Review analysis or a Research report.
 *
 * What is saved is a separate copy the project owns. The dialog says so before
 * the save and again after it, because the usual wrong assumption is that the
 * project now "links" to the original.
 */
export function ProjectSaveToProject({ source, className, testId = "project-save-open", compact = false }: {
    source: SourceInput;
    className?: string;
    testId?: string;
    compact?: boolean;
}) {
    const { t } = useCopy();
    const scope = useProjectChatScope();
    const [open, setOpen] = useState(false);
    if (!scope.enabled) return null;
    return (
        <>
            <button type="button" onClick={() => setOpen(true)} className={className ?? `${projectUi.button}`} data-testid={testId}>
                <FolderPlus className="h-4 w-4" aria-hidden="true" />
                <span className={compact ? "sr-only sm:not-sr-only" : undefined}>{t("projectWorkspace.save.open")}</span>
            </button>
            {open && <SaveDialog source={source} onClose={() => setOpen(false)} />}
        </>
    );
}

function SaveDialog({ source, onClose }: { source: SourceInput; onClose: () => void }) {
    const { t } = useCopy();
    const scope = useProjectChatScope();
    const client = webProjectWorkspaceClient();
    const dialogRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const projects = useProjectResource<ProjectSummary[]>(() => client.list(), "project-save-targets");
    const [chosen, setChosen] = useState<string | null>(null);
    const [state, setState] = useState<SaveState>({ status: "idle" });
    useModalDialog({ open: true, onClose: state.status === "saving" ? () => undefined : onClose, dialogRef, panelRef });

    const targets = (projects.data ?? []).filter((item) => !item.archivedAt);
    const targetId = chosen ?? (scope.projectId && targets.some((item) => item.id === scope.projectId) ? scope.projectId : targets[0]?.id ?? null);

    const save = async () => {
        if (!targetId || state.status === "saving") return;
        setState({ status: "saving" });
        let resolved: MaterialSource | null = null;
        try {
            resolved = typeof source === "function" ? await source() : source;
            const intent = materialIntentKey(targetId, resolved);
            const result = await client.saveSource(targetId, resolved, requestIds.get(intent));
            requestIds.release(intent);
            setState({ status: "saved", created: result.created, file: result.file, projectId: targetId });
        } catch (error) {
            setState({ status: "failed", error });
        }
    };

    return createPortal(
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="project-save-title" data-testid="project-save-dialog" className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-3">
            <div ref={panelRef} tabIndex={-1} className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-2xl bg-white p-4 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
                <h2 id="project-save-title" className="text-lg font-bold">{t("projectWorkspace.save.title")}</h2>
                {state.status === "saved" ? (
                    <div className="space-y-2 text-sm" data-testid="project-save-done">
                        <p role="status" className="font-semibold">{t(state.created ? "projectWorkspace.save.savedNew" : "projectWorkspace.save.savedExisting")}</p>
                        <p className="break-words">{state.file.name}</p>
                        <p>{t("projectWorkspace.save.independent")}</p>
                        <p className={projectUi.muted}>{t("projectWorkspace.save.processingHint")}</p>
                    </div>
                ) : (
                    <div className="space-y-3 text-sm">
                        <p>{t("projectWorkspace.save.intro")}</p>
                        {projects.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
                        {projects.status === "error" && <ErrorLine error={projects.error} onRetry={() => void projects.reload()} />}
                        {projects.status === "ready" && targets.length === 0 && (
                            <p data-testid="project-save-none">{t("projectWorkspace.save.noProjects")}</p>
                        )}
                        {targets.length > 0 && (
                            <div>
                                <label className={projectUi.label} htmlFor="project-save-target">{t("projectWorkspace.save.target")}</label>
                                <select id="project-save-target" value={targetId ?? ""} onChange={(event) => setChosen(event.target.value)} className={projectUi.input} data-testid="project-save-target">
                                    {targets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                                </select>
                            </div>
                        )}
                        {state.status === "failed" && <ErrorLine error={state.error} testId="project-save-error" />}
                    </div>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                    {state.status === "saved" ? (
                        <>
                            <button type="button" className={projectUi.button} onClick={onClose}>{t("projectWorkspace.close")}</button>
                            <button type="button" className={projectUi.primary} onClick={() => { scope.openWorkspace({ kind: "project", projectId: state.projectId, tab: "materials" }); onClose(); }} data-testid="project-save-view">
                                {t("projectWorkspace.save.viewMaterials")}
                            </button>
                        </>
                    ) : (
                        <>
                            <button type="button" className={projectUi.button} disabled={state.status === "saving"} onClick={onClose}>{t("projectWorkspace.cancel")}</button>
                            {targets.length === 0 && projects.status === "ready" ? (
                                <button type="button" className={projectUi.primary} onClick={() => { scope.openWorkspace({ kind: "new" }); onClose(); }}>{t("projectWorkspace.save.createProject")}</button>
                            ) : (
                                <button type="button" disabled={!targetId || state.status === "saving"} onClick={() => void save()} className={projectUi.primary} data-testid="project-save-submit">
                                    {state.status === "saving" && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                                    {t(state.status === "failed" ? "projectWorkspace.retry" : "projectWorkspace.save.submit")}
                                </button>
                            )}
                        </>
                    )}
                </div>
                <span className="sr-only" aria-live="polite">{state.status === "saving" ? t("projectWorkspace.save.saving") : ""}</span>
            </div>
        </div>,
        document.body
    );
}
