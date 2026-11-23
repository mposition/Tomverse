"use client";

import { useState } from "react";
import { FolderOpen, Paperclip, X } from "lucide-react";
import { projectUi, useCopy } from "./projectUi";
import { ProjectSearchPanel } from "./ProjectSearchPanel";
import { useProjectChatScope } from "./ProjectChatScope";
import { MAX_PROJECT_REFERENCES } from "@/lib/projectWorkspaceUi";

/**
 * A strip above the composer for a conversation that belongs to a project:
 * which project it is, what that means for the next answer, and the
 * references attached to the next question.
 *
 * It never touches the draft, the attachments or a selected issue: picking a
 * reference is a side channel to the same Send.
 */
export function ProjectComposerBar() {
    const { t, tf } = useCopy();
    const scope = useProjectChatScope();
    const [searching, setSearching] = useState(false);
    const { project, projectId } = scope;
    if (!scope.enabled || !projectId) return null;

    const archived = Boolean(project?.archivedAt);
    const stateKey = !project
        ? null
        : archived
            ? "projectWorkspace.composer.archived"
            : project.contextEnabled
                ? "projectWorkspace.composer.contextOn"
                : "projectWorkspace.composer.contextOff";

    return (
        <div data-testid="project-composer-bar" data-project-id={projectId} data-context-active={scope.contextActive} className="mx-auto w-full max-w-4xl px-3 pb-1 pt-2">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/60">
                <FolderOpen className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                <span className="min-w-0 max-w-full truncate font-semibold" data-testid="project-composer-name">{project?.name ?? t("projectWorkspace.loading")}</span>
                {stateKey && <span className={scope.contextActive ? projectUi.chipGood : projectUi.chip}>{t(stateKey)}</span>}
                <button
                    type="button"
                    onClick={() => scope.openWorkspace({ kind: "project", projectId, tab: "overview" })}
                    className="ml-auto min-h-11 rounded-lg px-2 text-sm font-semibold underline underline-offset-2"
                    data-testid="project-composer-open"
                >
                    {t("projectWorkspace.composer.open")}
                </button>
                {scope.contextActive && (
                    <button
                        type="button"
                        aria-expanded={searching}
                        onClick={() => setSearching((value) => !value)}
                        className={projectUi.button}
                        data-testid="project-composer-reference"
                    >
                        <Paperclip className="h-4 w-4" aria-hidden="true" />
                        {t("projectWorkspace.composer.addReference")}
                    </button>
                )}
            </div>
            {scope.references.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-2" aria-label={t("projectWorkspace.composer.references")} data-testid="project-reference-chips">
                    {scope.references.map((hit) => (
                        <li key={hit.ref} className="inline-flex max-w-full items-center gap-1 rounded-full border border-blue-200 bg-blue-50 py-1 pl-3 pr-1 text-xs font-semibold text-blue-900 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-100" data-testid="project-reference-chip">
                            <span className="min-w-0 max-w-[16rem] truncate">{hit.title}</span>
                            <button
                                type="button"
                                aria-label={tf("projectWorkspace.composer.removeReference", { title: hit.title })}
                                onClick={() => scope.removeReference(hit.ref)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-blue-100 dark:hover:bg-blue-800/50"
                            >
                                <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </li>
                    ))}
                    <li className="self-center text-xs text-zinc-500 dark:text-zinc-400">{tf("projectWorkspace.composer.referenceCount", { count: scope.references.length, max: MAX_PROJECT_REFERENCES })}</li>
                </ul>
            )}
            {searching && scope.contextActive && (
                <div className="mt-2 max-h-[40dvh] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                    <ProjectSearchPanel
                        compact
                        autoFocus
                        projectId={projectId}
                        selected={scope.references}
                        onToggle={(hit) => scope.toggleReference(projectId, hit)}
                    />
                </div>
            )}
        </div>
    );
}
