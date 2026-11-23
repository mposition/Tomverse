"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Download, FileText, Loader2, RotateCcw, Trash2, Upload } from "lucide-react";
import type { ProjectMaterial } from "@tomverse/api-client";
import { webProjectWorkspaceClient } from "@/lib/projectWorkspaceWeb";
import {
    PROJECT_UI_LIMITS,
    createRequestIdMemo,
    formatBytes,
    materialCanDownload,
    materialCanRetry,
    materialFailureKey,
    materialSourceKey,
    materialStatusKey,
    materialsNeedPolling,
    uploadableMaterial,
} from "@/lib/projectWorkspaceUi";
import { ConfirmDialog, EmptyState, ErrorLine, Spinner, formatProjectDate, projectUi, useCopy, useProjectResource } from "./projectUi";
import type { ProjectTabProps } from "./ProjectWorkspaceScreen";

const POLL_MS = 4_000;

export function ProjectMaterialsTab({ project, archived, onProjectChanged, highlightFileId }: ProjectTabProps & { highlightFileId: string | null }) {
    const { t, tf, lang } = useCopy();
    const client = webProjectWorkspaceClient();
    const resource = useProjectResource(() => client.materials(project.id), `project-materials:${project.id}`);
    const reload = resource.reload;
    const files = resource.data?.files ?? [];
    const capacity = resource.data?.capacity;
    const polling = materialsNeedPolling(files);

    useEffect(() => {
        if (!polling) return;
        const timer = window.setInterval(() => void reload({ quiet: true }), POLL_MS);
        return () => window.clearInterval(timer);
    }, [polling, reload]);

    const inputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState<{ name: string }[]>([]);
    const [uploadError, setUploadError] = useState<{ name: string; error: unknown } | null>(null);
    const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<ProjectMaterial | null>(null);
    const [deleteError, setDeleteError] = useState<unknown>(null);
    const [noteTitle, setNoteTitle] = useState("");
    const [noteText, setNoteText] = useState("");
    const [noteBusy, setNoteBusy] = useState(false);
    const [noteError, setNoteError] = useState<unknown>(null);
    const [noteSaved, setNoteSaved] = useState(false);
    const noteIds = useRef(createRequestIdMemo());

    const upload = async (event: ChangeEvent<HTMLInputElement>) => {
        const picked = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (picked.length === 0) return;
        setUploadError(null);
        for (const file of picked) {
            setUploading((current) => [...current, { name: file.name }]);
            try {
                await client.uploadMaterial(project.id, uploadableMaterial(file));
            } catch (error) {
                setUploadError({ name: file.name, error });
            } finally {
                setUploading((current) => current.filter((item) => item.name !== file.name));
            }
        }
        void reload({ quiet: true });
        onProjectChanged();
    };

    const saveNote = async (event: FormEvent) => {
        event.preventDefault();
        const text = noteText.trim();
        if (!text || noteBusy) return;
        const title = noteTitle.trim() || t("projectWorkspace.materials.noteDefaultTitle");
        const intent = JSON.stringify([project.id, title, text]);
        setNoteBusy(true);
        setNoteError(null);
        setNoteSaved(false);
        try {
            // The same text retried after a lost response returns the same note.
            await client.addNote(project.id, title, text, noteIds.current.get(intent));
            noteIds.current.release(intent);
            setNoteTitle("");
            setNoteText("");
            setNoteSaved(true);
            void reload({ quiet: true });
            onProjectChanged();
        } catch (error) {
            setNoteError(error);
        } finally {
            setNoteBusy(false);
        }
    };

    const act = async (material: ProjectMaterial, action: () => Promise<void>) => {
        setBusyId(material.id);
        setRowError(null);
        try {
            await action();
        } catch (error) {
            setRowError({ id: material.id, error });
        } finally {
            setBusyId(null);
        }
    };

    const download = (material: ProjectMaterial) =>
        act(material, async () => {
            const link = await client.materialLink(project.id, material.id);
            const anchor = document.createElement("a");
            anchor.href = link.url;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.click();
        });

    const retry = (material: ProjectMaterial) =>
        act(material, async () => {
            await client.retryMaterial(project.id, material.id);
            await reload({ quiet: true });
            onProjectChanged();
        });

    const confirmDelete = async () => {
        if (!deleting) return;
        setBusyId(deleting.id);
        setDeleteError(null);
        try {
            await client.deleteMaterial(project.id, deleting.id);
            setDeleting(null);
            void reload({ quiet: true });
            onProjectChanged();
        } catch (error) {
            setDeleteError(error);
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div className="space-y-4" data-testid="project-materials">
            <p className="rounded-xl bg-zinc-50 p-3 text-sm text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300" data-testid="project-materials-ownership">
                {t("projectWorkspace.materials.ownership")}
            </p>
            {!project.contextEnabled && <p className="text-sm text-amber-800 dark:text-amber-200" role="status">{t("projectWorkspace.materials.folderNotice")}</p>}

            <section className={`${projectUi.card} space-y-3`}>
                <div className="flex flex-wrap items-center gap-2">
                    <input ref={inputRef} type="file" multiple hidden onChange={(event) => void upload(event)} accept={capacity?.acceptedMediaTypes?.join(",")} data-testid="project-material-file" />
                    <button type="button" disabled={archived || !capacity || uploading.length > 0} onClick={() => inputRef.current?.click()} className={projectUi.primary} data-testid="project-material-upload">
                        {uploading.length > 0 ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
                        {t("projectWorkspace.materials.upload")}
                    </button>
                    {capacity && (
                        <p className={projectUi.muted} data-testid="project-materials-capacity">
                            {tf("projectWorkspace.materials.capacity", {
                                size: Math.floor(capacity.limits.maxFileBytes / (1024 * 1024)),
                                remaining: Math.max(0, capacity.remaining.filesInProfile ?? capacity.remaining.filesInAccount ?? 0),
                            })}
                        </p>
                    )}
                </div>
                {archived && <p className={projectUi.muted}>{t("projectWorkspace.materials.archivedHint")}</p>}
                {uploading.map((item) => <p key={item.name} className={projectUi.muted} role="status"><Spinner label={tf("projectWorkspace.materials.uploading", { name: item.name })} /></p>)}
                {uploadError && (
                    <div data-testid="project-upload-error" className="space-y-1">
                        <p className="text-sm font-semibold break-words">{uploadError.name}</p>
                        <ErrorLine error={uploadError.error} />
                    </div>
                )}
            </section>

            <form onSubmit={(event) => void saveNote(event)} className={`${projectUi.card} space-y-3`} data-testid="project-note-form">
                <h3 className="text-base font-bold">{t("projectWorkspace.materials.noteTitle")}</h3>
                <div>
                    <label className={projectUi.label} htmlFor="project-note-title">{t("projectWorkspace.materials.noteTitleLabel")}</label>
                    <input id="project-note-title" value={noteTitle} maxLength={PROJECT_UI_LIMITS.maxNoteTitleLength} onChange={(event) => setNoteTitle(event.target.value)} disabled={archived} className={projectUi.input} />
                </div>
                <div>
                    <label className={projectUi.label} htmlFor="project-note-text">{t("projectWorkspace.materials.noteTextLabel")}</label>
                    <textarea id="project-note-text" value={noteText} maxLength={PROJECT_UI_LIMITS.maxNoteCharacters} rows={5} onChange={(event) => { setNoteText(event.target.value); setNoteSaved(false); }} disabled={archived} className={`${projectUi.input} resize-y`} />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <button type="submit" disabled={archived || noteBusy || !noteText.trim()} className={projectUi.primary} data-testid="project-note-save">
                        {noteBusy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                        {t("projectWorkspace.materials.noteSave")}
                    </button>
                    {noteSaved && <span role="status" className="text-sm font-semibold text-blue-700 dark:text-blue-300">{t("projectWorkspace.materials.noteSaved")}</span>}
                </div>
                {noteError ? <ErrorLine error={noteError} /> : null}
            </form>

            {resource.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
            {resource.status === "error" && <ErrorLine error={resource.error} onRetry={() => void reload()} />}
            {resource.status === "ready" && files.length === 0 && <EmptyState title={t("projectWorkspace.materials.emptyTitle")} body={t("projectWorkspace.materials.emptyBody")} />}
            {resource.status === "ready" && files.length > 0 && (
                <ul className="space-y-2" data-testid="project-material-list">
                    {files.map((material) => (
                        <MaterialRow
                            key={material.id}
                            material={material}
                            highlighted={material.id === highlightFileId}
                            busy={busyId === material.id}
                            error={rowError?.id === material.id ? rowError.error : null}
                            lang={lang}
                            onDownload={() => void download(material)}
                            onRetry={() => void retry(material)}
                            onDelete={() => { setDeleteError(null); setDeleting(material); }}
                            archived={archived}
                        />
                    ))}
                </ul>
            )}

            <ConfirmDialog
                open={Boolean(deleting)}
                title={t("projectWorkspace.materials.deleteTitle")}
                confirmLabel={t("projectWorkspace.materials.delete")}
                cancelLabel={t("projectWorkspace.cancel")}
                destructive
                busy={Boolean(deleting) && busyId === deleting?.id}
                error={deleteError}
                onCancel={() => setDeleting(null)}
                onConfirm={() => void confirmDelete()}
                testId="project-material-delete-dialog"
            >
                <p className="font-semibold break-words">{deleting?.name}</p>
                <p>{t("projectWorkspace.materials.deleteBody")}</p>
            </ConfirmDialog>
        </div>
    );
}

function MaterialRow({ material, highlighted, busy, error, lang, onDownload, onRetry, onDelete, archived }: {
    material: ProjectMaterial;
    highlighted: boolean;
    busy: boolean;
    error: unknown;
    lang: string;
    onDownload: () => void;
    onRetry: () => void;
    onDelete: () => void;
    archived: boolean;
}) {
    const { t, tf } = useCopy();
    const ref = useRef<HTMLLIElement>(null);
    useEffect(() => {
        if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, [highlighted]);
    const statusClass = material.processingStatus === "failed" ? projectUi.chipBad : material.processingStatus === "ready" ? projectUi.chipGood : projectUi.chipWarn;
    return (
        <li ref={ref} data-testid="project-material-row" data-material-id={material.id} data-status={material.processingStatus} className={`${projectUi.card} space-y-2 ${highlighted ? "ring-2 ring-blue-500" : ""}`}>
            <div className="flex flex-wrap items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                <span className="min-w-0 flex-1 break-words text-sm font-semibold">{material.name}</span>
                <span className={statusClass} data-testid="project-material-status">{t(materialStatusKey(material.processingStatus))}</span>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {t(materialSourceKey(material.sourceKind))} · {formatBytes(material.bytes)} · {formatProjectDate(material.createdAt, lang)}
                {material.processingStatus === "ready" ? ` · ${tf("projectWorkspace.materials.chunks", { count: material.chunkCount })}` : ""}
            </p>
            {material.processingStatus === "failed" && (
                <p role="alert" data-testid="project-material-failure" className="text-sm text-red-700 dark:text-red-300">{t(materialFailureKey(material.failureCode))}</p>
            )}
            {material.sourceKind !== "upload" && material.sourceKind !== "note" && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("projectWorkspace.materials.independentCopy")}</p>
            )}
            <div className="flex flex-wrap gap-2">
                {materialCanDownload(material) && (
                    <button type="button" disabled={busy} onClick={onDownload} className={projectUi.button} data-testid="project-material-download">
                        <Download className="h-4 w-4" aria-hidden="true" />
                        {t("projectWorkspace.materials.download")}
                    </button>
                )}
                {materialCanRetry(material) && (
                    <button type="button" disabled={busy || archived} onClick={onRetry} className={projectUi.button} data-testid="project-material-retry">
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        {t("projectWorkspace.materials.retry")}
                    </button>
                )}
                <button type="button" disabled={busy} onClick={onDelete} className={projectUi.danger} data-testid="project-material-delete">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    {t("projectWorkspace.materials.delete")}
                </button>
            </div>
            {error ? <ErrorLine error={error} /> : null}
        </li>
    );
}
