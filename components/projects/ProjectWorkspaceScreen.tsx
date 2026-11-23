"use client";

import { useCallback, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, MessageSquarePlus } from "lucide-react";
import type { ProjectSearchHit, ProjectSummary } from "@tomverse/api-client";
import { PROJECT_WORKSPACE_TABS, type ProjectWorkspaceRoute, type ProjectWorkspaceTab } from "@/lib/projectWorkspaceRoute";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import { announceProjectChanged, projectStatusLabelKey } from "@/lib/projectWorkspaceUi";
import { EmptyState, ErrorLine, Spinner, projectUi, useCopy, useProjectResource } from "./projectUi";
import { useProjectChatScope } from "./ProjectChatScope";
import { ProjectSearchPanel } from "./ProjectSearchPanel";
import { ProjectOverviewTab } from "./ProjectOverviewTab";
import { ProjectConversationsTab, type ProjectConversationHint, type WorkspaceConversationRow } from "./ProjectConversationsTab";
import { ProjectMaterialsTab } from "./ProjectMaterialsTab";
import { ProjectMemoriesTab } from "./ProjectMemoriesTab";
import { ProjectSettingsTab } from "./ProjectSettingsTab";

export type ProjectTabProps = {
    project: ProjectSummary;
    archived: boolean;
    /** Re-read the project (counts, revision) and tell the rest of the page. */
    onProjectChanged: () => void;
};

/**
 * The Project workspace pane: overview, chats, materials, memories and
 * settings for one project, plus search over what the project holds.
 *
 * Opening a project by URL is only a request: the project is read through the
 * owner-checked API, and a 404 is shown as "not available" with no hint of
 * whether the id exists for someone else.
 */
export function ProjectWorkspaceScreen({
    projectId,
    tab,
    onNavigate,
    onOpenConversation,
    onNewChat,
    onDeleted,
    conversations,
}: {
    projectId: string;
    tab: ProjectWorkspaceTab;
    onNavigate: (route: ProjectWorkspaceRoute | null) => void;
    onOpenConversation: (conversationId: string, hint: ProjectConversationHint | null) => void;
    onNewChat: (projectId: string) => void;
    onDeleted: (projectId: string) => void;
    /** The page's conversation list, for "add an existing chat". */
    conversations: WorkspaceConversationRow[];
}) {
    const { t, tf } = useCopy();
    const scope = useProjectChatScope();
    const tabsId = useId();
    const [searchOpen, setSearchOpen] = useState(false);
    const [highlightFileId, setHighlightFileId] = useState<string | null>(null);
    const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

    const resource = useProjectResource<ProjectSummary>(() => webProjectWorkspaceClient().detail(projectId), `project:${projectId}`);
    const reload = resource.reload;
    const project = resource.data;

    const changed = useCallback(() => {
        announceProjectChanged();
        void reload({ quiet: true });
    }, [reload]);

    const go = (next: ProjectWorkspaceTab) => onNavigate({ kind: "project", projectId, tab: next });

    const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        let target = index;
        if (event.key === "ArrowRight") target = (index + 1) % PROJECT_WORKSPACE_TABS.length;
        else if (event.key === "ArrowLeft") target = (index - 1 + PROJECT_WORKSPACE_TABS.length) % PROJECT_WORKSPACE_TABS.length;
        else if (event.key === "Home") target = 0;
        else if (event.key === "End") target = PROJECT_WORKSPACE_TABS.length - 1;
        else return;
        event.preventDefault();
        const next = PROJECT_WORKSPACE_TABS[target];
        go(next);
        queueMicrotask(() => tabRefs.current[next]?.focus());
    };

    const openHit = (hit: ProjectSearchHit) => {
        if (hit.location.kind === "material") {
            setHighlightFileId(hit.location.fileId ?? null);
            go("materials");
            return;
        }
        if (hit.location.conversationId) {
            // A conversation the page's list has not loaded gets no hint: the page
            // then resolves its surface from the owned row instead of guessing.
            const row = conversations.find((item) => item.id === hit.location.conversationId);
            onOpenConversation(
                hit.location.conversationId,
                row?.surface ? { continuation: row.surface === "continuation", productKey: row.surface === "chat" ? "chat" : null } : null
            );
        }
    };

    const archived = Boolean(project?.archivedAt);

    return (
        <div data-testid="project-workspace" data-project-id={projectId} data-tab={tab} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4 md:py-6">
                <header className="flex flex-wrap items-start gap-3">
                    <button type="button" onClick={() => onNavigate(null)} className={projectUi.button} data-testid="project-workspace-close" aria-label={t("projectWorkspace.back")}>
                        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                        <span className="hidden sm:inline">{t("projectWorkspace.back")}</span>
                    </button>
                    <div className="min-w-0 flex-1">
                        <h1 className="break-words text-xl font-bold md:text-2xl" data-testid="project-workspace-title">{project?.name ?? t("projectWorkspace.loading")}</h1>
                        {project && (
                            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                                <span className={project.archivedAt ? projectUi.chipWarn : project.contextEnabled ? projectUi.chipGood : projectUi.chip} data-testid="project-workspace-status">
                                    {t(projectStatusLabelKey(project))}
                                </span>
                                <span className={projectUi.muted}>{t(project.contextEnabled ? "projectWorkspace.statusHint.contextOn" : "projectWorkspace.statusHint.folder")}</span>
                            </p>
                        )}
                    </div>
                    {project && (
                        <div className="flex flex-wrap gap-2">
                            <button type="button" onClick={() => setSearchOpen((value) => !value)} aria-expanded={searchOpen} className={projectUi.button} data-testid="project-workspace-search-toggle">
                                {t("projectWorkspace.search.title")}
                            </button>
                            <button type="button" disabled={archived} onClick={() => onNewChat(project.id)} className={projectUi.primary} data-testid="project-workspace-new-chat">
                                <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
                                {t("projectWorkspace.newChat")}
                            </button>
                        </div>
                    )}
                </header>

                {resource.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
                {resource.status === "error" && (
                    <div className={projectUi.card}>
                        <ErrorLine error={resource.error} onRetry={() => void reload()} testId="project-workspace-error" />
                    </div>
                )}

                {project && (
                    <>
                        {archived && (
                            <p role="status" data-testid="project-archived-banner" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
                                {t("projectWorkspace.archivedBanner")}
                            </p>
                        )}
                        {searchOpen && (
                            <ProjectSearchPanel
                                projectId={project.id}
                                selected={scope.referencesFor(project.id)}
                                onToggle={(hit) => scope.toggleReference(project.id, hit)}
                                onOpenHit={openHit}
                            />
                        )}
                        <div role="tablist" aria-label={tf("projectWorkspace.tabsLabel", { name: project.name })} className="flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
                            {PROJECT_WORKSPACE_TABS.map((item, index) => (
                                <button
                                    key={item}
                                    ref={(node) => {
                                        tabRefs.current[item] = node;
                                    }}
                                    type="button"
                                    role="tab"
                                    id={`${tabsId}-tab-${item}`}
                                    aria-selected={tab === item}
                                    aria-controls={`${tabsId}-panel-${item}`}
                                    tabIndex={tab === item ? 0 : -1}
                                    data-testid={`project-tab-${item}`}
                                    onClick={() => go(item)}
                                    onKeyDown={(event) => onTabKeyDown(event, index)}
                                    className={`min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                                        tab === item
                                            ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300"
                                            : "border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                                    }`}
                                >
                                    {t(`projectWorkspace.tabs.${item}`)}
                                    {item === "materials" && (project.failedMaterialCount ?? 0) > 0 && (
                                        <span className={`${projectUi.chipBad} ml-2`}>{project.failedMaterialCount}</span>
                                    )}
                                </button>
                            ))}
                        </div>
                        <div role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`} tabIndex={0} className="focus-visible:outline-none">
                            {tab === "overview" && <ProjectOverviewTab project={project} archived={archived} onProjectChanged={changed} onGoTab={go} />}
                            {tab === "conversations" && (
                                <ProjectConversationsTab
                                    project={project}
                                    archived={archived}
                                    onProjectChanged={changed}
                                    conversations={conversations}
                                    onOpenConversation={onOpenConversation}
                                    onNewChat={() => onNewChat(project.id)}
                                />
                            )}
                            {tab === "materials" && <ProjectMaterialsTab project={project} archived={archived} onProjectChanged={changed} highlightFileId={highlightFileId} />}
                            {tab === "memories" && <ProjectMemoriesTab project={project} archived={archived} onProjectChanged={changed} />}
                            {tab === "settings" && <ProjectSettingsTab project={project} archived={archived} onProjectChanged={changed} onDeleted={() => onDeleted(project.id)} />}
                        </div>
                    </>
                )}
                {resource.status === "error" && !project && (
                    <EmptyState title={t("projectWorkspace.unavailableTitle")} body={t("projectWorkspace.unavailableBody")} action={<button type="button" className={projectUi.button} onClick={() => onNavigate(null)}>{t("projectWorkspace.back")}</button>} />
                )}
            </div>
        </div>
    );
}
