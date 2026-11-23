"use client";

import type { ProjectWorkspaceTab } from "@/lib/projectWorkspaceRoute";
import type { ProjectTabProps } from "./ProjectWorkspaceScreen";
import { formatProjectDate, projectUi, useCopy } from "./projectUi";

/** Counts and the plain meaning of this project's context state. */
export function ProjectOverviewTab({ project, onGoTab }: ProjectTabProps & { onGoTab: (tab: ProjectWorkspaceTab) => void }) {
    const { t, tf, lang } = useCopy();
    const failed = project.failedMaterialCount ?? 0;
    const stats: Array<{ tab: ProjectWorkspaceTab; value: number; label: string }> = [
        { tab: "conversations", value: project.conversationCount, label: t("projectWorkspace.tabs.conversations") },
        { tab: "materials", value: project.materialCount, label: t("projectWorkspace.tabs.materials") },
        { tab: "memories", value: project.memoryCount, label: t("projectWorkspace.tabs.memories") },
    ];
    return (
        <div className="space-y-4" data-testid="project-overview">
            {project.description && <p className="whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-300" data-testid="project-overview-description">{project.description}</p>}
            <ul className="grid grid-cols-3 gap-2 sm:gap-3">
                {stats.map((item) => (
                    <li key={item.tab}>
                        <button type="button" onClick={() => onGoTab(item.tab)} className={`${projectUi.card} w-full text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-800/60`} data-testid={`project-stat-${item.tab}`}>
                            <span className="block text-2xl font-bold">{item.value}</span>
                            <span className={projectUi.muted}>{item.label}</span>
                        </button>
                    </li>
                ))}
            </ul>
            {failed > 0 && (
                <p role="status" data-testid="project-overview-failed" className="flex flex-wrap items-center gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-900 dark:bg-red-900/20 dark:text-red-100">
                    <span>{tf("projectWorkspace.overview.failedMaterials", { count: failed })}</span>
                    <button type="button" onClick={() => onGoTab("materials")} className="min-h-11 font-semibold underline underline-offset-2">{t("projectWorkspace.overview.reviewMaterials")}</button>
                </p>
            )}
            <section className={`${projectUi.card} space-y-2`}>
                <h2 className="text-base font-bold">{t("projectWorkspace.overview.howTitle")}</h2>
                <p className="text-sm text-zinc-700 dark:text-zinc-300">{t(project.contextEnabled ? "projectWorkspace.overview.howOn" : "projectWorkspace.overview.howOff")}</p>
                {project.contextEnabled && (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
                        <li>{t(project.memoryScope === "project_and_personal" ? "projectWorkspace.overview.memoryPersonal" : "projectWorkspace.overview.memoryProjectOnly")}</li>
                        <li>{t(project.autoMemoryEnabled ? "projectWorkspace.overview.autoOn" : "projectWorkspace.overview.autoOff")}</li>
                        {project.instructions.trim() && <li>{t("projectWorkspace.overview.hasInstructions")}</li>}
                    </ul>
                )}
            </section>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{tf("projectWorkspace.overview.updated", { date: formatProjectDate(project.updatedAt, lang) })}</p>
        </div>
    );
}
