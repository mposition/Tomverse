import { useEffect, useRef, useState, type FormEvent } from "react";
import { Download, FileText, Loader2, Pencil, Pin, PinOff, RotateCcw, Trash2, Upload } from "lucide-react";
import { ProjectWorkspaceError, type ProjectMaterial, type ProjectMemory } from "../../../../packages/api-client/src/projectWorkspace";
import { FACTUAL_MEMORY_KINDS, STYLE_MEMORY_KINDS } from "../../../../lib/memoryValidatorCore";
import {
  PROJECT_UI_LIMITS, createRequestIdMemo, deleteProjectAfterConfirmation, formatBytes, loadProjectDeletionPlan, materialCanDownload, materialCanRetry,
  materialFailureKey, materialSourceKey, materialStatusKey, materialsNeedPolling, memoryEvidenceText, memoryMoveWarning, projectNameValid,
  projectSettingsPatch, saveProjectSettings, settingsDraftFromProject, type ProjectDeletionPlan, type ProjectSettingsDraft,
} from "../../../../lib/projectWorkspaceUi";
import type { ProjectTabProps } from "./ProjectWorkspace";
import { ConfirmDialog, EmptyState, ErrorLine, Spinner, asSharedClient, desktopProjectClient, formatProjectDate, useProjectResource } from "./project-ui";

const POLL_MS = 4_000;

export function ProjectMaterialsTab({ project, archived, copy, onProjectChanged, highlightFileId }: ProjectTabProps & { highlightFileId: string | null }) {
  const { t, tf } = copy;
  const client = desktopProjectClient();
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

  const [uploading, setUploading] = useState(false);
  const [uploadFailures, setUploadFailures] = useState<Array<{ name: string; error: ProjectWorkspaceError }>>([]);
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

  async function upload() {
    if (uploading) return;
    setUploading(true);
    setUploadFailures([]);
    try {
      const result = await client.uploadMaterials(project.id);
      setUploadFailures(result.files.flatMap((file) => file.code ? [{ name: file.name, error: new ProjectWorkspaceError(0, file.code) }] : []));
      if (!result.cancelled) { void reload({ quiet: true }); onProjectChanged(); }
    } catch (error) {
      setUploadFailures([{ name: "", error: error instanceof ProjectWorkspaceError ? error : new ProjectWorkspaceError(0, "PROJECT_REQUEST_FAILED") }]);
    } finally {
      setUploading(false);
    }
  }

  async function saveNote(event: FormEvent) {
    event.preventDefault();
    const text = noteText.trim();
    if (!text || noteBusy) return;
    const title = noteTitle.trim() || t("projectWorkspace.materials.noteDefaultTitle");
    const intent = JSON.stringify([project.id, title, text]);
    setNoteBusy(true); setNoteError(null); setNoteSaved(false);
    try {
      // The same text retried after a lost response returns the same note.
      await client.addNote(project.id, title, text, noteIds.current.get(intent));
      noteIds.current.release(intent);
      setNoteTitle(""); setNoteText(""); setNoteSaved(true);
      void reload({ quiet: true });
      onProjectChanged();
    } catch (error) {
      setNoteError(error);
    } finally {
      setNoteBusy(false);
    }
  }

  async function act(material: ProjectMaterial, action: () => Promise<void>) {
    setBusyId(material.id); setRowError(null);
    try { await action(); } catch (error) { setRowError({ id: material.id, error }); } finally { setBusyId(null); }
  }
  const retry = (material: ProjectMaterial) => act(material, async () => {
    await client.retryMaterial(project.id, material.id);
    await reload({ quiet: true });
    onProjectChanged();
  });
  const download = (material: ProjectMaterial) => act(material, async () => { await client.downloadMaterial(project.id, material.id); });

  async function confirmDelete() {
    if (!deleting) return;
    setBusyId(deleting.id); setDeleteError(null);
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
  }

  return <div className="pw-stack" data-testid="project-materials">
    <p className="pw-banner" data-testid="project-materials-ownership">{t("projectWorkspace.materials.ownership")}</p>
    {!project.contextEnabled && <p className="pw-banner pw-banner-warn" role="status">{t("projectWorkspace.materials.folderNotice")}</p>}
    <section className="pw-card pw-stack">
      <div className="pw-actions">
        <button type="button" className="primary" disabled={archived || !capacity || uploading} data-testid="project-material-upload" onClick={() => void upload()}>
          {uploading ? <Loader2 size={15} className="pw-spin" aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />} {t("projectWorkspace.materials.upload")}
        </button>
        {capacity && <p className="pw-muted" data-testid="project-materials-capacity">{tf("projectWorkspace.materials.capacity", {
          size: Math.floor(capacity.limits.maxFileBytes / (1024 * 1024)),
          remaining: Math.max(0, capacity.remaining.filesInProfile ?? capacity.remaining.filesInAccount ?? 0),
        })}</p>}
      </div>
      {archived && <p className="pw-muted">{t("projectWorkspace.materials.archivedHint")}</p>}
      {uploadFailures.map((failure, index) => <div key={`${failure.name}:${index}`} data-testid="project-upload-error">
        {failure.name && <p className="pw-strong">{failure.name}</p>}
        <ErrorLine error={failure.error} copy={copy} />
      </div>)}
    </section>

    <form className="pw-card pw-stack" data-testid="project-note-form" onSubmit={(event) => void saveNote(event)}>
      <h3>{t("projectWorkspace.materials.noteTitle")}</h3>
      <label className="pw-label" htmlFor="project-note-title">{t("projectWorkspace.materials.noteTitleLabel")}</label>
      <input id="project-note-title" className="history-search" value={noteTitle} maxLength={PROJECT_UI_LIMITS.maxNoteTitleLength} disabled={archived} onChange={(event) => setNoteTitle(event.currentTarget.value)} />
      <label className="pw-label" htmlFor="project-note-text">{t("projectWorkspace.materials.noteTextLabel")}</label>
      <textarea id="project-note-text" className="pw-textarea" rows={5} value={noteText} maxLength={PROJECT_UI_LIMITS.maxNoteCharacters} disabled={archived}
        onChange={(event) => { setNoteText(event.currentTarget.value); setNoteSaved(false); }} />
      <div className="pw-actions">
        <button type="submit" className="primary" data-testid="project-note-save" disabled={archived || noteBusy || !noteText.trim()}>
          {noteBusy && <Loader2 size={15} className="pw-spin" aria-hidden="true" />} {t("projectWorkspace.materials.noteSave")}
        </button>
        {noteSaved && <span role="status" className="pw-strong">{t("projectWorkspace.materials.noteSaved")}</span>}
      </div>
      {noteError ? <ErrorLine error={noteError} copy={copy} /> : null}
    </form>

    {resource.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
    {resource.status === "error" && <ErrorLine error={resource.error} copy={copy} onRetry={() => void reload()} />}
    {resource.status === "ready" && files.length === 0 && <EmptyState title={t("projectWorkspace.materials.emptyTitle")} body={t("projectWorkspace.materials.emptyBody")} />}
    {resource.status === "ready" && files.length > 0 && <ul className="pw-rows pw-cards" data-testid="project-material-list">
      {files.map((material) => <MaterialRow key={material.id} material={material} copy={copy} highlighted={material.id === highlightFileId} archived={archived}
        busy={busyId === material.id} error={rowError?.id === material.id ? rowError.error : null}
        onDownload={() => void download(material)} onRetry={() => void retry(material)} onDelete={() => { setDeleteError(null); setDeleting(material); }} />)}
    </ul>}
    <ConfirmDialog open={Boolean(deleting)} copy={copy} testId="project-material-delete-dialog" destructive busy={Boolean(deleting) && busyId === deleting?.id} error={deleteError}
      title={t("projectWorkspace.materials.deleteTitle")} confirmLabel={t("projectWorkspace.materials.delete")} cancelLabel={t("projectWorkspace.cancel")}
      onCancel={() => setDeleting(null)} onConfirm={() => void confirmDelete()}>
      <p className="pw-strong">{deleting?.name}</p>
      <p>{t("projectWorkspace.materials.deleteBody")}</p>
    </ConfirmDialog>
  </div>;
}

function MaterialRow({ material, copy, highlighted, busy, error, archived, onDownload, onRetry, onDelete }: {
  material: ProjectMaterial; copy: ProjectTabProps["copy"]; highlighted: boolean; busy: boolean; error: unknown; archived: boolean;
  onDownload: () => void; onRetry: () => void; onDelete: () => void;
}) {
  const { t, tf, language } = copy;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (highlighted) ref.current?.scrollIntoView?.({ block: "center" }); }, [highlighted]);
  const statusClass = material.processingStatus === "failed" ? "pw-chip pw-chip-bad" : material.processingStatus === "ready" ? "pw-chip pw-chip-good" : "pw-chip pw-chip-warn";
  return <li ref={ref} className={highlighted ? "pw-card pw-stack pw-highlight" : "pw-card pw-stack"} data-testid="project-material-row" data-material-id={material.id} data-status={material.processingStatus}>
    <div className="pw-inline">
      <FileText size={15} aria-hidden="true" />
      <span className="pw-grow pw-strong">{material.name}</span>
      <span className={statusClass} data-testid="project-material-status">{t(materialStatusKey(material.processingStatus))}</span>
    </div>
    <p className="pw-muted">
      {t(materialSourceKey(material.sourceKind))} · {formatBytes(material.bytes)} · {formatProjectDate(material.createdAt, language)}
      {material.processingStatus === "ready" ? ` · ${tf("projectWorkspace.materials.chunks", { count: material.chunkCount })}` : ""}
    </p>
    {material.processingStatus === "failed" && <p role="alert" className="pw-error" data-testid="project-material-failure">{t(materialFailureKey(material.failureCode))}</p>}
    {material.sourceKind !== "upload" && material.sourceKind !== "note" && <p className="pw-muted">{t("projectWorkspace.materials.independentCopy")}</p>}
    <div className="pw-actions">
      {materialCanDownload(material) && <button type="button" className="soft" disabled={busy} data-testid="project-material-download" onClick={onDownload}>
        <Download size={15} aria-hidden="true" /> {t("projectWorkspace.materials.download")}</button>}
      {materialCanRetry(material) && <button type="button" className="soft" disabled={busy || archived} data-testid="project-material-retry" onClick={onRetry}>
        <RotateCcw size={15} aria-hidden="true" /> {t("projectWorkspace.materials.retry")}</button>}
      <button type="button" className="pw-danger" disabled={busy} data-testid="project-material-delete" onClick={onDelete}>
        <Trash2 size={15} aria-hidden="true" /> {t("projectWorkspace.materials.delete")}</button>
    </div>
    {error ? <ErrorLine error={error} copy={copy} /> : null}
  </li>;
}

export function ProjectMemoriesTab({ project, archived, copy, onProjectChanged }: ProjectTabProps) {
  const { t, tf } = copy;
  const client = desktopProjectClient();
  const resource = useProjectResource(() => client.memories(project.id), `project-memories:${project.id}`);
  const memories = resource.data?.memories ?? [];
  const [kind, setKind] = useState<(typeof FACTUAL_MEMORY_KINDS)[number] | (typeof STYLE_MEMORY_KINDS)[number]>("preference");
  const [statement, setStatement] = useState("");
  const [grounds, setGrounds] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);
  const [deleting, setDeleting] = useState<ProjectMemory | null>(null);
  const [moving, setMoving] = useState<{ memory: ProjectMemory; target: string | null } | null>(null);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [showPersonal, setShowPersonal] = useState(false);
  const personal = useProjectResource<ProjectMemory[]>(async () => showPersonal ? (await client.personalMemories(project.id)).memories.filter((item) => item.projectId === null) : [],
    `project-personal-memories:${project.id}:${showPersonal}`);

  function refresh() {
    void resource.reload({ quiet: true });
    if (showPersonal) void personal.reload({ quiet: true });
    onProjectChanged();
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (createBusy || !statement.trim() || !grounds.trim()) return;
    setCreateBusy(true); setCreateError(null);
    try {
      await client.createMemory(project.id, { kind, statement: statement.trim(), groundsText: grounds.trim() });
      setStatement(""); setGrounds("");
      refresh();
    } catch (error) {
      setCreateError(error);
    } finally {
      setCreateBusy(false);
    }
  }
  async function act(memory: ProjectMemory, action: () => Promise<unknown>) {
    setBusyId(memory.id); setRowError(null);
    try { await action(); refresh(); } catch (error) { setRowError({ id: memory.id, error }); } finally { setBusyId(null); }
  }
  async function dialogAction(memory: ProjectMemory, action: () => Promise<unknown>, close: () => void) {
    setBusyId(memory.id); setDialogError(null);
    try { await action(); close(); refresh(); } catch (error) { setDialogError(error); } finally { setBusyId(null); }
  }
  const kindOption = (value: string) => <option key={value} value={value}>{t(`memoryReview.kind.${value}`)}</option>;

  return <div className="pw-stack" data-testid="project-memories">
    <p className="pw-banner">{t(project.memoryScope === "project_and_personal" ? "projectWorkspace.memories.scopePersonal" : "projectWorkspace.memories.scopeProjectOnly")}</p>
    {project.autoMemoryEnabled && <p className="pw-banner pw-banner-warn" role="status" data-testid="project-auto-memory-note">{t("projectWorkspace.memories.autoNote")}</p>}
    {!project.contextEnabled && <p className="pw-banner pw-banner-warn" role="status">{t("projectWorkspace.memories.folderNotice")}</p>}

    <form className="pw-card pw-stack" data-testid="project-memory-form" onSubmit={(event) => void create(event)}>
      <h3>{t("projectWorkspace.memories.createTitle")}</h3>
      <label className="pw-label" htmlFor="project-memory-kind">{t("projectWorkspace.memories.kindLabel")}</label>
      <select id="project-memory-kind" className="pw-select" value={kind} disabled={archived} onChange={(event) => setKind(event.currentTarget.value as typeof kind)}>
        <optgroup label={t("memoryReview.kindGroupFactual")}>{FACTUAL_MEMORY_KINDS.map(kindOption)}</optgroup>
        <optgroup label={t("memoryReview.kindGroupStyle")}>{STYLE_MEMORY_KINDS.map(kindOption)}</optgroup>
      </select>
      <label className="pw-label" htmlFor="project-memory-statement">{t("projectWorkspace.memories.statementLabel")}</label>
      <textarea id="project-memory-statement" className="pw-textarea" rows={2} maxLength={1_000} value={statement} disabled={archived} onChange={(event) => setStatement(event.currentTarget.value)} />
      <label className="pw-label" htmlFor="project-memory-grounds">{t("projectWorkspace.memories.groundsLabel")}</label>
      <textarea id="project-memory-grounds" className="pw-textarea" rows={2} maxLength={2_000} value={grounds} disabled={archived} onChange={(event) => setGrounds(event.currentTarget.value)} />
      <p className="pw-muted">{t("projectWorkspace.memories.groundsHint")}</p>
      <div className="pw-actions">
        <button type="submit" className="primary" data-testid="project-memory-create" disabled={archived || createBusy || !statement.trim() || !grounds.trim()}>
          {createBusy && <Loader2 size={15} className="pw-spin" aria-hidden="true" />} {t("projectWorkspace.memories.create")}
        </button>
      </div>
      {createError ? <ErrorLine error={createError} copy={copy} /> : null}
    </form>

    {resource.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
    {resource.status === "error" && <ErrorLine error={resource.error} copy={copy} onRetry={() => void resource.reload()} />}
    {resource.status === "ready" && memories.length === 0 && <EmptyState title={t("projectWorkspace.memories.emptyTitle")} body={t("projectWorkspace.memories.emptyBody")} />}
    {resource.status === "ready" && memories.length > 0 && <ul className="pw-rows pw-cards" data-testid="project-memory-list">
      {memories.map((memory) => {
        const evidence = memoryEvidenceText(memory);
        const isEditing = editing?.id === memory.id;
        const busy = busyId === memory.id;
        return <li key={memory.id} className="pw-card pw-stack" data-testid="project-memory-row" data-memory-id={memory.id}>
          <div className="pw-chips">
            <span className="pw-chip">{t(`memoryReview.kind.${memory.kind}`)}</span>
            <span className={memory.status === "active" ? "pw-chip pw-chip-good" : "pw-chip pw-chip-warn"}>{t(`memoryReview.status.${memory.status}`)}</span>
            {memory.pinned && <span className="pw-chip">{t("projectWorkspace.memories.pinned")}</span>}
            {memory.userEdited && <span className="pw-chip">{t("projectWorkspace.memories.edited")}</span>}
          </div>
          {isEditing ? <div className="pw-stack">
            <label className="pw-sr" htmlFor={`project-memory-edit-${memory.id}`}>{t("projectWorkspace.memories.statementLabel")}</label>
            <textarea id={`project-memory-edit-${memory.id}`} className="pw-textarea" rows={3} maxLength={1_000} value={editing.text}
              onChange={(event) => setEditing({ id: memory.id, text: event.currentTarget.value })} />
            <div className="pw-actions">
              <button type="button" className="primary" data-testid="project-memory-save" disabled={busy || !editing.text.trim()}
                onClick={() => void act(memory, async () => { await client.editMemory(project.id, memory.id, editing.text.trim()); setEditing(null); })}>{t("projectWorkspace.saveButton")}</button>
              <button type="button" className="soft" onClick={() => setEditing(null)}>{t("projectWorkspace.cancel")}</button>
            </div>
          </div> : <p className="pw-text" data-testid="project-memory-statement">{memory.statement}</p>}
          {memory.suspendedReason && <p className="pw-muted">{tf("projectWorkspace.memories.suspended", { reason: memory.suspendedReason })}</p>}
          {evidence.length > 0 && <details data-testid="project-memory-evidence">
            <summary>{t("projectWorkspace.memories.evidence")}</summary>
            <ul className="pw-list">{evidence.map((line, index) => <li key={index}>{line}</li>)}</ul>
          </details>}
          <div className="pw-actions">
            <button type="button" className="soft" disabled={busy || archived} data-testid="project-memory-edit" onClick={() => setEditing({ id: memory.id, text: memory.statement })}>
              <Pencil size={15} aria-hidden="true" /> {t("projectWorkspace.memories.edit")}</button>
            <button type="button" className="soft" disabled={busy || archived} data-testid="project-memory-pin" onClick={() => void act(memory, () => client.pinMemory(project.id, memory.id, !memory.pinned))}>
              {memory.pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />} {t(memory.pinned ? "projectWorkspace.memories.unpin" : "projectWorkspace.memories.pin")}</button>
            <button type="button" className="soft" disabled={busy || archived} data-testid="project-memory-to-personal" onClick={() => { setDialogError(null); setMoving({ memory, target: null }); }}>
              {t("projectWorkspace.memories.moveToPersonal")}</button>
            <button type="button" className="pw-danger" disabled={busy} data-testid="project-memory-delete" onClick={() => { setDialogError(null); setDeleting(memory); }}>
              <Trash2 size={15} aria-hidden="true" /> {t("projectWorkspace.memories.delete")}</button>
          </div>
          {rowError?.id === memory.id ? <ErrorLine error={rowError.error} copy={copy} /> : null}
        </li>;
      })}
    </ul>}

    <section className="pw-card pw-stack" data-testid="project-memory-personal">
      <button type="button" className="soft" aria-expanded={showPersonal} onClick={() => setShowPersonal((value) => !value)}>{t("projectWorkspace.memories.personalToggle")}</button>
      {showPersonal && <>
        <p className="pw-muted">{t("projectWorkspace.memories.personalHint")}</p>
        {personal.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
        {personal.status === "error" && <ErrorLine error={personal.error} copy={copy} onRetry={() => void personal.reload()} />}
        {personal.status === "ready" && (personal.data ?? []).length === 0 && <p className="pw-muted">{t("projectWorkspace.memories.personalEmpty")}</p>}
        {personal.status === "ready" && (personal.data ?? []).length > 0 && <ul className="pw-rows">{(personal.data ?? []).map((memory) => <li key={memory.id}>
          <span className="pw-grow">{memory.statement}</span>
          <button type="button" className="soft" disabled={archived} data-testid="project-memory-to-project" onClick={() => { setDialogError(null); setMoving({ memory, target: project.id }); }}>
            {t("projectWorkspace.memories.moveToProject")}</button>
        </li>)}</ul>}
      </>}
    </section>

    <ConfirmDialog open={Boolean(deleting)} copy={copy} testId="project-memory-delete-dialog" destructive busy={Boolean(deleting) && busyId === deleting?.id} error={dialogError}
      title={t("projectWorkspace.memories.deleteTitle")} confirmLabel={t("projectWorkspace.memories.delete")} cancelLabel={t("projectWorkspace.cancel")}
      onCancel={() => setDeleting(null)} onConfirm={() => deleting && void dialogAction(deleting, () => client.deleteMemory(project.id, deleting.id), () => setDeleting(null))}>
      <p className="pw-strong">{deleting?.statement}</p>
      <p>{t("projectWorkspace.memories.deleteBody")}</p>
    </ConfirmDialog>
    <ConfirmDialog open={Boolean(moving)} copy={copy} testId="project-memory-move-dialog" busy={Boolean(moving) && busyId === moving?.memory.id} error={dialogError}
      title={t(moving?.target === null ? "projectWorkspace.memories.moveToPersonalTitle" : "projectWorkspace.memories.moveToProjectTitle")}
      confirmLabel={t("projectWorkspace.memories.confirmMove")} cancelLabel={t("projectWorkspace.cancel")}
      onCancel={() => setMoving(null)} onConfirm={() => moving && void dialogAction(moving.memory, () => client.moveMemory(moving.memory.id, moving.memory.revision, moving.target), () => setMoving(null))}>
      {moving && <>
        <p className="pw-strong">{moving.memory.statement}</p>
        {memoryMoveWarning(moving.memory, moving.target) === "personal_wide"
          ? <p role="alert" data-testid="project-memory-personal-warning" className="pw-strong">{t("projectWorkspace.memories.personalWarning")}</p>
          : <p>{t("projectWorkspace.memories.projectOnlyBody")}</p>}
      </>}
    </ConfirmDialog>
  </div>;
}

export function ProjectSettingsTab(props: ProjectTabProps & { onDeleted: () => void }) {
  // Keyed on the revision: after any save the form starts again from what the server now holds.
  return <SettingsForm key={`${props.project.id}:${props.project.revision}`} {...props} />;
}

function SettingsForm({ project, archived, copy, onProjectChanged, onDeleted }: ProjectTabProps & { onDeleted: () => void }) {
  const { t, tf } = copy;
  const client = desktopProjectClient();
  const shared = asSharedClient(client);
  const [draft, setDraft] = useState<ProjectSettingsDraft>(() => settingsDraftFromProject(project));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<unknown>(null);
  const patch = projectSettingsPatch(project, draft);
  const update = <K extends keyof ProjectSettingsDraft>(key: K, value: ProjectSettingsDraft[K]) => { setDraft((current) => ({ ...current, [key]: value })); setSaved(false); };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!patch || saving || !projectNameValid(draft.name)) return;
    setSaving(true); setFailure(null);
    try {
      await saveProjectSettings(shared, project, patch);
      setSaved(true);
      onProjectChanged();
    } catch (error) {
      setFailure(error);
    } finally {
      setSaving(false);
    }
  }
  async function setArchived(next: boolean) {
    setArchiveBusy(true); setArchiveError(null);
    try { await client.update(project.id, project.revision, { archived: next }); onProjectChanged(); }
    catch (error) { setArchiveError(error); }
    finally { setArchiveBusy(false); }
  }

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [plan, setPlan] = useState<ProjectDeletionPlan | null>(null);
  const [planError, setPlanError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  async function openDelete() {
    setDeleteOpen(true); setPlan(null); setPlanError(null); setStale(false); setDeleteError(null);
    try { setPlan(await loadProjectDeletionPlan(shared, project.id)); } catch (error) { setPlanError(error); }
  }
  async function confirmDelete() {
    if (!plan || deleteBusy) return;
    setDeleteBusy(true); setDeleteError(null);
    try {
      const outcome = await deleteProjectAfterConfirmation(shared, project.id, plan);
      if (outcome.status === "stale") { setPlan(outcome.plan); setStale(true); return; }
      setDeleteOpen(false);
      onDeleted();
    } catch (error) {
      setDeleteError(error);
    } finally {
      setDeleteBusy(false);
    }
  }

  return <div className="pw-stack" data-testid="project-settings">
    <form className="pw-card pw-stack" onSubmit={(event) => void save(event)}>
      <label className="pw-label" htmlFor="project-settings-name">{t("projectWorkspace.settings.name")}</label>
      <input id="project-settings-name" className="history-search" value={draft.name} maxLength={PROJECT_UI_LIMITS.maxNameLength} disabled={archived} onChange={(event) => update("name", event.currentTarget.value)} />
      <label className="pw-label" htmlFor="project-settings-description">{t("projectWorkspace.settings.description")}</label>
      <textarea id="project-settings-description" className="pw-textarea" rows={3} maxLength={PROJECT_UI_LIMITS.maxDescriptionLength} value={draft.description} disabled={archived} onChange={(event) => update("description", event.currentTarget.value)} />
      <label className="pw-label" htmlFor="project-settings-instructions">{t("projectWorkspace.settings.instructions")}</label>
      <textarea id="project-settings-instructions" className="pw-textarea" rows={6} maxLength={PROJECT_UI_LIMITS.maxInstructionsLength} value={draft.instructions} disabled={archived} onChange={(event) => update("instructions", event.currentTarget.value)} />
      <p className="pw-muted">{t("projectWorkspace.settings.instructionsHint")}</p>
      <fieldset className="pw-stack">
        <legend className="pw-label">{t("projectWorkspace.settings.contextLegend")}</legend>
        <label className="pw-check"><input type="checkbox" checked={draft.contextEnabled} disabled={archived} onChange={(event) => update("contextEnabled", event.currentTarget.checked)} data-testid="project-settings-context" />
          <span><strong>{t("projectWorkspace.settings.contextEnabled")}</strong><small>{t(draft.contextEnabled ? "projectWorkspace.settings.contextOnHint" : "projectWorkspace.settings.contextOffHint")}</small></span></label>
        <label className="pw-check"><input type="checkbox" checked={draft.includePersonalMemory} disabled={archived || !draft.contextEnabled} onChange={(event) => update("includePersonalMemory", event.currentTarget.checked)} />
          <span><strong>{t("projectWorkspace.settings.personalMemory")}</strong><small>{t("projectWorkspace.settings.personalMemoryHint")}</small></span></label>
        <label className="pw-check"><input type="checkbox" checked={draft.autoMemoryEnabled} disabled={archived || !draft.contextEnabled} onChange={(event) => update("autoMemoryEnabled", event.currentTarget.checked)} />
          <span><strong>{t("projectWorkspace.settings.autoMemory")}</strong><small>{t("projectWorkspace.settings.autoMemoryHint")}</small></span></label>
      </fieldset>
      <div className="pw-actions">
        <button type="submit" className="primary" data-testid="project-settings-save" disabled={archived || !patch || saving || !projectNameValid(draft.name)}>
          {saving && <Loader2 size={15} className="pw-spin" aria-hidden="true" />} {t("projectWorkspace.saveButton")}
        </button>
        {patch && !saving && <span className="pw-muted" role="status">{t("projectWorkspace.settings.unsaved")}</span>}
        {saved && !patch && <span className="pw-strong" role="status">{t("projectWorkspace.settings.saved")}</span>}
      </div>
      {failure ? <div role="alert" className="pw-error"><ErrorLine error={failure} copy={copy} />
        {isRevisionConflictError(failure) && <button type="button" className="soft" onClick={onProjectChanged}>{t("projectWorkspace.settings.reloadLatest")}</button>}</div> : null}
    </form>

    <section className="pw-card pw-stack">
      <h3>{t(archived ? "projectWorkspace.settings.restoreTitle" : "projectWorkspace.settings.archiveTitle")}</h3>
      <p>{t(archived ? "projectWorkspace.settings.restoreBody" : "projectWorkspace.settings.archiveBody")}</p>
      <div className="pw-actions"><button type="button" className="soft" disabled={archiveBusy} data-testid="project-archive-toggle" onClick={() => void setArchived(!archived)}>
        {archiveBusy && <Loader2 size={15} className="pw-spin" aria-hidden="true" />} {t(archived ? "projectWorkspace.settings.restore" : "projectWorkspace.settings.archive")}</button></div>
      {archiveError ? <ErrorLine error={archiveError} copy={copy} /> : null}
    </section>

    <section className="pw-card pw-stack">
      <h3>{t("projectWorkspace.delete.title")}</h3>
      <p>{t("projectWorkspace.delete.intro")}</p>
      <div className="pw-actions"><button type="button" className="pw-danger" data-testid="project-delete-open" onClick={() => void openDelete()}>{t("projectWorkspace.delete.open")}</button></div>
    </section>

    <ConfirmDialog open={deleteOpen} copy={copy} testId="project-delete-dialog" destructive busy={deleteBusy || (!plan && !planError)} error={planError ?? deleteError}
      title={tf("projectWorkspace.delete.dialogTitle", { name: project.name })} confirmLabel={t("projectWorkspace.delete.confirm")} cancelLabel={t("projectWorkspace.cancel")}
      onCancel={() => setDeleteOpen(false)} onConfirm={() => void confirmDelete()}>
      {!plan && !planError && <Spinner label={t("projectWorkspace.loading")} />}
      {plan && <>
        {stale && <p role="alert" data-testid="project-delete-stale" className="pw-strong">{t("projectWorkspace.delete.stale")}</p>}
        <ul className="pw-list">
          <li>{tf("projectWorkspace.delete.conversations", { count: plan.summary.conversations })}</li>
          <li>{tf("projectWorkspace.delete.materials", { count: plan.summary.materials })}</li>
          <li>{tf("projectWorkspace.delete.memories", { count: plan.summary.memories })}</li>
        </ul>
        {plan.needsConfirmation && <p className="pw-strong">{t("projectWorkspace.delete.irreversible")}</p>}
      </>}
    </ConfirmDialog>
  </div>;
}

const isRevisionConflictError = (error: unknown) =>
  error instanceof ProjectWorkspaceError && (error.code === "PROJECT_REVISION_CONFLICT" || error.code === "PROJECT_REVISION_REQUIRED");
