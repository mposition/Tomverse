"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { ProjectMemory } from "@tomverse/api-client";
import { FACTUAL_MEMORY_KINDS, STYLE_MEMORY_KINDS } from "@/lib/memoryValidatorCore";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import { memoryEvidenceText, memoryMoveWarning } from "@/lib/projectWorkspaceUi";
import { ConfirmDialog, EmptyState, ErrorLine, Spinner, projectUi, useCopy, useProjectResource } from "./projectUi";
import type { ProjectTabProps } from "./ProjectWorkspaceScreen";
import { discardResponseBody } from "@/lib/discardResponseBody";

type MoveRequest = { memory: ProjectMemory; target: string | null };

const STATEMENT_LIMIT = 1_000;
const GROUNDS_LIMIT = 2_000;

export function ProjectMemoriesTab({ project, archived, onProjectChanged }: ProjectTabProps) {
    const { t, tf } = useCopy();
    const client = webProjectWorkspaceClient();
    const resource = useProjectResource(() => client.memories(project.id), `project-memories:${project.id}`);
    const memories = resource.data?.memories ?? [];

    const [kind, setKind] = useState<string>("preference");
    const [statement, setStatement] = useState("");
    const [grounds, setGrounds] = useState("");
    const [createBusy, setCreateBusy] = useState(false);
    const [createError, setCreateError] = useState<unknown>(null);
    const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);
    const [deleting, setDeleting] = useState<ProjectMemory | null>(null);
    const [moving, setMoving] = useState<MoveRequest | null>(null);
    const [dialogError, setDialogError] = useState<unknown>(null);
    const [showPersonal, setShowPersonal] = useState(false);

    const personal = useProjectResource<ProjectMemory[]>(
        async () => {
            if (!showPersonal) return [];
            const response = await fetch("/api/memories?status=active&limit=100", { cache: "no-store" });
            if (!response.ok) {
                await discardResponseBody(response);
                throw new Error("PERSONAL_MEMORIES_FAILED");
            }
            const body = (await response.json()) as { memories?: ProjectMemory[] };
            return (body.memories ?? []).filter((item) => item.projectId === null);
        },
        `project-personal-memories:${project.id}:${showPersonal}`
    );

    const refresh = () => {
        void resource.reload({ quiet: true });
        if (showPersonal) void personal.reload({ quiet: true });
        onProjectChanged();
    };

    const create = async (event: FormEvent) => {
        event.preventDefault();
        if (createBusy || !statement.trim() || !grounds.trim()) return;
        setCreateBusy(true);
        setCreateError(null);
        try {
            await client.createMemory(project.id, { kind, statement: statement.trim(), groundsText: grounds.trim() });
            setStatement("");
            setGrounds("");
            refresh();
        } catch (error) {
            setCreateError(error);
        } finally {
            setCreateBusy(false);
        }
    };

    const act = async (memory: ProjectMemory, action: () => Promise<unknown>) => {
        setBusyId(memory.id);
        setRowError(null);
        try {
            await action();
            refresh();
        } catch (error) {
            setRowError({ id: memory.id, error });
        } finally {
            setBusyId(null);
        }
    };

    const confirmDelete = async () => {
        if (!deleting) return;
        setBusyId(deleting.id);
        setDialogError(null);
        try {
            await client.deleteMemory(project.id, deleting.id);
            setDeleting(null);
            refresh();
        } catch (error) {
            setDialogError(error);
        } finally {
            setBusyId(null);
        }
    };

    const confirmMove = async () => {
        if (!moving) return;
        setBusyId(moving.memory.id);
        setDialogError(null);
        try {
            await client.moveMemory(moving.memory.id, moving.memory.revision, moving.target);
            setMoving(null);
            refresh();
        } catch (error) {
            setDialogError(error);
        } finally {
            setBusyId(null);
        }
    };

    const kindOption = (value: string) => <option key={value} value={value}>{t(`memoryReview.kind.${value}`)}</option>;

    return (
        <div className="space-y-4" data-testid="project-memories">
            <p className="rounded-xl bg-zinc-50 p-3 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                {t(project.memoryScope === "project_and_personal" ? "projectWorkspace.memories.scopePersonal" : "projectWorkspace.memories.scopeProjectOnly")}
            </p>
            {project.autoMemoryEnabled && (
                <p className="text-sm text-amber-800 dark:text-amber-200" role="status" data-testid="project-auto-memory-note">{t("projectWorkspace.memories.autoNote")}</p>
            )}
            {!project.contextEnabled && <p className="text-sm text-amber-800 dark:text-amber-200" role="status">{t("projectWorkspace.memories.folderNotice")}</p>}

            <form onSubmit={(event) => void create(event)} className={`${projectUi.card} space-y-3`} data-testid="project-memory-form">
                <h3 className="text-base font-bold">{t("projectWorkspace.memories.createTitle")}</h3>
                <div>
                    <label className={projectUi.label} htmlFor="project-memory-kind">{t("projectWorkspace.memories.kindLabel")}</label>
                    <select id="project-memory-kind" value={kind} onChange={(event) => setKind(event.target.value)} disabled={archived} className={projectUi.input}>
                        <optgroup label={t("memoryReview.kindGroupFactual")}>{FACTUAL_MEMORY_KINDS.map(kindOption)}</optgroup>
                        <optgroup label={t("memoryReview.kindGroupStyle")}>{STYLE_MEMORY_KINDS.map(kindOption)}</optgroup>
                    </select>
                </div>
                <div>
                    <label className={projectUi.label} htmlFor="project-memory-statement">{t("projectWorkspace.memories.statementLabel")}</label>
                    <textarea id="project-memory-statement" rows={2} maxLength={STATEMENT_LIMIT} value={statement} onChange={(event) => setStatement(event.target.value)} disabled={archived} className={`${projectUi.input} resize-y`} />
                </div>
                <div>
                    <label className={projectUi.label} htmlFor="project-memory-grounds">{t("projectWorkspace.memories.groundsLabel")}</label>
                    <textarea id="project-memory-grounds" rows={2} maxLength={GROUNDS_LIMIT} value={grounds} onChange={(event) => setGrounds(event.target.value)} disabled={archived} className={`${projectUi.input} resize-y`} />
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t("projectWorkspace.memories.groundsHint")}</p>
                </div>
                <button type="submit" disabled={archived || createBusy || !statement.trim() || !grounds.trim()} className={projectUi.primary} data-testid="project-memory-create">
                    {createBusy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    {t("projectWorkspace.memories.create")}
                </button>
                {createError ? <ErrorLine error={createError} /> : null}
            </form>

            {resource.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
            {resource.status === "error" && <ErrorLine error={resource.error} onRetry={() => void resource.reload()} />}
            {resource.status === "ready" && memories.length === 0 && <EmptyState title={t("projectWorkspace.memories.emptyTitle")} body={t("projectWorkspace.memories.emptyBody")} />}
            {resource.status === "ready" && memories.length > 0 && (
                <ul className="space-y-2" data-testid="project-memory-list">
                    {memories.map((memory) => {
                        const evidence = memoryEvidenceText(memory);
                        const isEditing = editing?.id === memory.id;
                        const busy = busyId === memory.id;
                        return (
                            <li key={memory.id} data-testid="project-memory-row" data-memory-id={memory.id} className={`${projectUi.card} space-y-2`}>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className={projectUi.chip}>{t(`memoryReview.kind.${memory.kind}`)}</span>
                                    <span className={memory.status === "active" ? projectUi.chipGood : projectUi.chipWarn}>{t(`memoryReview.status.${memory.status}`)}</span>
                                    {memory.pinned && <span className={projectUi.chip}>{t("projectWorkspace.memories.pinned")}</span>}
                                    {memory.userEdited && <span className={projectUi.chip}>{t("projectWorkspace.memories.edited")}</span>}
                                </div>
                                {isEditing ? (
                                    <div className="space-y-2">
                                        <label className="sr-only" htmlFor={`project-memory-edit-${memory.id}`}>{t("projectWorkspace.memories.statementLabel")}</label>
                                        <textarea id={`project-memory-edit-${memory.id}`} rows={3} maxLength={STATEMENT_LIMIT} value={editing.text} onChange={(event) => setEditing({ id: memory.id, text: event.target.value })} className={`${projectUi.input} resize-y`} />
                                        <div className="flex gap-2">
                                            <button type="button" disabled={busy || !editing.text.trim()} className={projectUi.primary} onClick={() => void act(memory, async () => { await client.editMemory(project.id, memory.id, editing.text.trim()); setEditing(null); })} data-testid="project-memory-save">
                                                {t("projectWorkspace.saveButton")}
                                            </button>
                                            <button type="button" className={projectUi.button} onClick={() => setEditing(null)}>{t("projectWorkspace.cancel")}</button>
                                        </div>
                                    </div>
                                ) : (
                                    <p className="whitespace-pre-wrap break-words text-sm" data-testid="project-memory-statement">{memory.statement}</p>
                                )}
                                {memory.suspendedReason && <p className="text-xs text-amber-800 dark:text-amber-200">{tf("projectWorkspace.memories.suspended", { reason: memory.suspendedReason })}</p>}
                                {evidence.length > 0 && (
                                    <details className="text-sm" data-testid="project-memory-evidence">
                                        <summary className="min-h-11 cursor-pointer py-2 font-semibold">{t("projectWorkspace.memories.evidence")}</summary>
                                        <ul className="list-disc space-y-1 pl-5 text-zinc-700 dark:text-zinc-300">{evidence.map((line, index) => <li key={index} className="break-words">{line}</li>)}</ul>
                                    </details>
                                )}
                                <div className="flex flex-wrap gap-2">
                                    <button type="button" disabled={busy || archived} onClick={() => setEditing({ id: memory.id, text: memory.statement })} className={projectUi.button} data-testid="project-memory-edit">
                                        <Pencil className="h-4 w-4" aria-hidden="true" />{t("projectWorkspace.memories.edit")}
                                    </button>
                                    <button type="button" disabled={busy || archived} onClick={() => void act(memory, () => client.pinMemory(project.id, memory.id, !memory.pinned))} className={projectUi.button} data-testid="project-memory-pin">
                                        {memory.pinned ? <PinOff className="h-4 w-4" aria-hidden="true" /> : <Pin className="h-4 w-4" aria-hidden="true" />}
                                        {t(memory.pinned ? "projectWorkspace.memories.unpin" : "projectWorkspace.memories.pin")}
                                    </button>
                                    <button type="button" disabled={busy || archived} onClick={() => { setDialogError(null); setMoving({ memory, target: null }); }} className={projectUi.button} data-testid="project-memory-to-personal">
                                        {t("projectWorkspace.memories.moveToPersonal")}
                                    </button>
                                    <button type="button" disabled={busy} onClick={() => { setDialogError(null); setDeleting(memory); }} className={projectUi.danger} data-testid="project-memory-delete">
                                        <Trash2 className="h-4 w-4" aria-hidden="true" />{t("projectWorkspace.memories.delete")}
                                    </button>
                                </div>
                                {rowError?.id === memory.id ? <ErrorLine error={rowError.error} /> : null}
                            </li>
                        );
                    })}
                </ul>
            )}

            <section className={`${projectUi.card} space-y-3`} data-testid="project-memory-personal">
                <button type="button" aria-expanded={showPersonal} onClick={() => setShowPersonal((value) => !value)} className={projectUi.button}>
                    {t("projectWorkspace.memories.personalToggle")}
                </button>
                {showPersonal && (
                    <>
                        <p className={projectUi.muted}>{t("projectWorkspace.memories.personalHint")}</p>
                        {personal.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
                        {personal.status === "error" && <ErrorLine error={personal.error} onRetry={() => void personal.reload()} />}
                        {personal.status === "ready" && (personal.data ?? []).length === 0 && <p className={projectUi.muted}>{t("projectWorkspace.memories.personalEmpty")}</p>}
                        {personal.status === "ready" && (personal.data ?? []).length > 0 && (
                            <ul className="space-y-2">
                                {(personal.data ?? []).map((memory) => (
                                    <li key={memory.id} className="flex flex-wrap items-center gap-2 border-b border-zinc-200 pb-2 dark:border-zinc-800">
                                        <span className="min-w-0 flex-1 break-words text-sm">{memory.statement}</span>
                                        <button type="button" disabled={archived} className={projectUi.button} onClick={() => { setDialogError(null); setMoving({ memory, target: project.id }); }} data-testid="project-memory-to-project">
                                            {t("projectWorkspace.memories.moveToProject")}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </>
                )}
            </section>

            <ConfirmDialog
                open={Boolean(deleting)}
                title={t("projectWorkspace.memories.deleteTitle")}
                confirmLabel={t("projectWorkspace.memories.delete")}
                cancelLabel={t("projectWorkspace.cancel")}
                destructive
                busy={Boolean(deleting) && busyId === deleting?.id}
                error={dialogError}
                onCancel={() => setDeleting(null)}
                onConfirm={() => void confirmDelete()}
                testId="project-memory-delete-dialog"
            >
                <p className="break-words font-semibold">{deleting?.statement}</p>
                <p>{t("projectWorkspace.memories.deleteBody")}</p>
            </ConfirmDialog>

            <ConfirmDialog
                open={Boolean(moving)}
                title={t(moving?.target === null ? "projectWorkspace.memories.moveToPersonalTitle" : "projectWorkspace.memories.moveToProjectTitle")}
                confirmLabel={t("projectWorkspace.memories.confirmMove")}
                cancelLabel={t("projectWorkspace.cancel")}
                busy={Boolean(moving) && busyId === moving?.memory.id}
                error={dialogError}
                onCancel={() => setMoving(null)}
                onConfirm={() => void confirmMove()}
                testId="project-memory-move-dialog"
            >
                {moving && (
                    <>
                        <p className="break-words font-semibold">{moving.memory.statement}</p>
                        {memoryMoveWarning(moving.memory, moving.target) === "personal_wide" ? (
                            <p role="alert" data-testid="project-memory-personal-warning" className="font-semibold text-amber-800 dark:text-amber-200">{t("projectWorkspace.memories.personalWarning")}</p>
                        ) : (
                            <p>{t("projectWorkspace.memories.projectOnlyBody")}</p>
                        )}
                    </>
                )}
            </ConfirmDialog>
        </div>
    );
}
