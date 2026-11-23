"use client";

import { useMemo, useState } from "react";
import { MessageSquarePlus, Plus } from "lucide-react";
import type { ProjectConversationRow, ProjectSummary } from "@tomverse/api-client";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import { announceConversationProjectChanged, conversationMoveEffect } from "@/lib/projectWorkspaceUi";
import { ConfirmDialog, EmptyState, ErrorLine, Spinner, formatProjectDate, projectUi, useCopy, useProjectResource } from "./projectUi";
import type { ProjectTabProps } from "./ProjectWorkspaceScreen";

/** The part of the page's conversation list this tab needs. */
/** What the server said about a conversation, enough to choose the surface it opens on. */
export type ProjectConversationHint = { continuation: boolean; productKey: string | null };

export type WorkspaceConversationRow = {
    id: string;
    title: string;
    projectId?: string | null;
    surface?: "workspace" | "continuation" | "chat";
    isLocked?: boolean;
    kind?: string;
};

type MoveTarget = { conversation: { id: string; title: string }; target: string | null; mode: "add" | "move" | "remove" };

export function ProjectConversationsTab({
    project,
    archived,
    onProjectChanged,
    conversations,
    onOpenConversation,
    onNewChat,
}: ProjectTabProps & {
    conversations: WorkspaceConversationRow[];
    onOpenConversation: (conversationId: string, hint: ProjectConversationHint | null) => void;
    onNewChat: () => void;
}) {
    const { t, tf, lang } = useCopy();
    const client = webProjectWorkspaceClient();
    const rows = useProjectResource<ProjectConversationRow[]>(() => client.conversations(project.id), `project-conversations:${project.id}`);
    const projects = useProjectResource<ProjectSummary[]>(() => client.list(), "project-list");
    const [adding, setAdding] = useState(false);
    const [filter, setFilter] = useState("");
    const [pending, setPending] = useState<MoveTarget | null>(null);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<unknown>(null);

    const projectById = useMemo(() => new Map((projects.data ?? []).map((item) => [item.id, item])), [projects.data]);
    const candidates = useMemo(() => {
        const text = filter.trim().toLowerCase();
        return conversations
            .filter((item) => (item.projectId ?? null) !== project.id && item.kind !== "image")
            .filter((item) => !text || item.title.toLowerCase().includes(text))
            .slice(0, 40);
    }, [conversations, filter, project.id]);

    const targetProject = (id: string | null) => (id ? projectById.get(id) ?? null : null);

    const confirm = async () => {
        if (!pending) return;
        setBusy(true);
        setFailure(null);
        try {
            await client.moveConversation(pending.conversation.id, pending.target);
            announceConversationProjectChanged({ conversationId: pending.conversation.id, projectId: pending.target });
            setPending(null);
            void rows.reload({ quiet: true });
            onProjectChanged();
        } catch (error) {
            setFailure(error);
        } finally {
            setBusy(false);
        }
    };

    const effectFor = (pendingMove: MoveTarget, fromProjectId: string | null) =>
        conversationMoveEffect(targetProject(fromProjectId) ?? (fromProjectId === project.id ? project : null), pendingMove.target === project.id ? project : targetProject(pendingMove.target));

    const otherProjects = (projects.data ?? []).filter((item) => item.id !== project.id && !item.archivedAt);

    return (
        <div className="space-y-4" data-testid="project-conversations">
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={onNewChat} disabled={archived} className={projectUi.primary} data-testid="project-conversations-new">
                    <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
                    {t("projectWorkspace.newChat")}
                </button>
                <button type="button" onClick={() => setAdding((value) => !value)} disabled={archived} aria-expanded={adding} className={projectUi.button} data-testid="project-conversations-add-toggle">
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t("projectWorkspace.conversations.addExisting")}
                </button>
            </div>
            {archived && <p className={projectUi.muted}>{t("projectWorkspace.conversations.archivedHint")}</p>}
            <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="project-move-notice">{t("projectWorkspace.conversations.moveNotice")}</p>

            {adding && !archived && (
                <section className={`${projectUi.card} space-y-3`} data-testid="project-conversations-picker">
                    <label className={projectUi.label} htmlFor="project-add-filter">{t("projectWorkspace.conversations.pickTitle")}</label>
                    <input id="project-add-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("projectWorkspace.conversations.filterPlaceholder")} className={projectUi.input} />
                    {candidates.length === 0 ? (
                        <p className={projectUi.muted}>{t("projectWorkspace.conversations.noCandidates")}</p>
                    ) : (
                        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                            {candidates.map((item) => {
                                const from = item.projectId ? projectById.get(item.projectId) : null;
                                return (
                                    <li key={item.id} className="flex flex-wrap items-center gap-2 py-2" data-testid="project-conversations-candidate">
                                        <span className="min-w-0 flex-1 break-words text-sm font-semibold">{item.isLocked ? t("projectWorkspace.conversations.locked") : item.title}</span>
                                        {from && <span className={projectUi.chip}>{from.name}</span>}
                                        <button type="button" className={projectUi.button} onClick={() => setPending({ conversation: { id: item.id, title: item.isLocked ? t("projectWorkspace.conversations.locked") : item.title }, target: project.id, mode: item.projectId ? "move" : "add" })}>
                                            {t(item.projectId ? "projectWorkspace.conversations.moveHere" : "projectWorkspace.conversations.add")}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            )}

            {rows.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
            {rows.status === "error" && <ErrorLine error={rows.error} onRetry={() => void rows.reload()} />}
            {rows.status === "ready" && (rows.data ?? []).length === 0 && (
                <EmptyState title={t("projectWorkspace.conversations.emptyTitle")} body={t("projectWorkspace.conversations.emptyBody")} />
            )}
            {rows.status === "ready" && (rows.data ?? []).length > 0 && (
                <ul className="space-y-2" data-testid="project-conversation-list">
                    {(rows.data ?? []).map((row) => {
                        const title = row.locked ? t("projectWorkspace.conversations.locked") : row.title || t("sidebar.newChat");
                        return (
                            <li key={row.id} data-testid="project-conversation-row" data-conversation-id={row.id} className={`${projectUi.card} flex flex-wrap items-center gap-2`}>
                                <div className="min-w-0 flex-1">
                                    <p className="break-words text-sm font-semibold">{title}</p>
                                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                        {tf("projectWorkspace.conversations.meta", { count: row.messageCount, date: formatProjectDate(row.updatedAt, lang) })}
                                        {row.kind === "image" ? ` · ${t("projectWorkspace.conversations.image")}` : ""}
                                        {row.continuation ? ` · ${t("projectWorkspace.conversations.continuation")}` : ""}
                                    </p>
                                </div>
                                <button type="button" className={projectUi.button} onClick={() => onOpenConversation(row.id, { continuation: Boolean(row.continuation), productKey: row.productKey })} data-testid="project-conversation-open">
                                    {t("projectWorkspace.open")}
                                </button>
                                {otherProjects.length > 0 && (
                                    <>
                                        <label className="sr-only" htmlFor={`project-move-${row.id}`}>{tf("projectWorkspace.conversations.moveLabel", { title })}</label>
                                        <select
                                            id={`project-move-${row.id}`}
                                            value=""
                                            onChange={(event) => event.target.value && setPending({ conversation: { id: row.id, title }, target: event.target.value, mode: "move" })}
                                            className="min-h-11 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                                            data-testid="project-conversation-move"
                                        >
                                            <option value="">{t("projectWorkspace.conversations.moveTo")}</option>
                                            {otherProjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                                        </select>
                                    </>
                                )}
                                <button type="button" className={projectUi.danger} onClick={() => setPending({ conversation: { id: row.id, title }, target: null, mode: "remove" })} data-testid="project-conversation-remove">
                                    {t("projectWorkspace.conversations.remove")}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            <ConfirmDialog
                open={Boolean(pending)}
                title={t(pending?.mode === "remove" ? "projectWorkspace.conversations.removeTitle" : "projectWorkspace.conversations.moveTitle")}
                confirmLabel={t(pending?.mode === "remove" ? "projectWorkspace.conversations.remove" : "projectWorkspace.conversations.confirmMove")}
                cancelLabel={t("projectWorkspace.cancel")}
                busy={busy}
                error={failure}
                destructive={pending?.mode === "remove"}
                onCancel={() => { setPending(null); setFailure(null); }}
                onConfirm={() => void confirm()}
                testId="project-move-dialog"
            >
                {pending && (
                    <>
                        <p className="font-semibold">{pending.conversation.title}</p>
                        <p>
                            {tf(
                                pending.mode === "remove"
                                    ? "projectWorkspace.conversations.removeBody"
                                    : "projectWorkspace.conversations.moveBody",
                                { project: targetProject(pending.target)?.name ?? (pending.target === project.id ? project.name : "") }
                            )}
                        </p>
                        <p data-testid="project-move-effect">{t(`projectWorkspace.conversations.effect.${effectFor(pending, pending.mode === "add" ? null : pending.mode === "move" ? conversations.find((item) => item.id === pending.conversation.id)?.projectId ?? project.id : project.id)}`)}</p>
                        <p className={projectUi.muted}>{t("projectWorkspace.conversations.moveNotice")}</p>
                    </>
                )}
            </ConfirmDialog>
        </div>
    );
}
