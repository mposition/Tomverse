import { useEffect, useRef, useState } from "react";
import { Browser } from "@capacitor/browser";
import type { ProjectMaterial } from "@tomverse/api-client";
import { mobileErrorText } from "../../../locales/mobileErrors";
import { projectText, type MobileProjectsCopy } from "../../../locales/mobileProjects";
import type { ProjectPanelProps } from "./ProjectWorkspace";
import { classifyProjectFailure, failureMessage } from "./projectWorkspaceState";
import { useProjectAction, useProjectLoader } from "./useProjectLoader";

const POLL_MS = 4000;

const statusLabel = (copy: MobileProjectsCopy, status: ProjectMaterial["processingStatus"]) =>
  ({ pending: copy.statusPending, processing: copy.statusProcessing, ready: copy.statusReady, failed: copy.statusFailed })[status];
const kindLabel = (copy: MobileProjectsCopy, kind: ProjectMaterial["sourceKind"]) =>
  ({ upload: copy.kindUpload, note: copy.kindNote, message_attachment: copy.kindMessage, generated_artifact: copy.kindArtifact, review_result: copy.kindReview, research_report: copy.kindResearch })[kind];
const sizeLabel = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Materials are the project's own copies: upload, note, status, retry, download, delete. */
export function ProjectMaterials({ api, copy, language, project, onChanged, onReloadProject }: ProjectPanelProps) {
  const list = useProjectLoader(() => api().materials(project.id), project.id);
  const action = useProjectAction();
  const picker = useRef<HTMLInputElement>(null);
  const noteRequest = useRef(crypto.randomUUID());
  const [note, setNote] = useState<{ title: string; text: string } | null>(null);
  const [removing, setRemoving] = useState<ProjectMaterial | null>(null);
  const [message, setMessage] = useState("");
  const files = list.state.status === "ready" ? list.state.data.files : [];
  const working = files.some(file => file.processingStatus === "pending" || file.processingStatus === "processing");
  // Quiet re-read while a file is still being processed, so status changes show up.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void list.reload(true), POLL_MS);
    return () => clearInterval(timer);
  }, [working]); // eslint-disable-line react-hooks/exhaustive-deps -- reload is stable; only the working flag matters.
  const refresh = async () => { onReloadProject(); await list.reload(true); onChanged(); };
  const failed = (error: unknown, fallback: string) => {
    const kind = classifyProjectFailure(error);
    return kind === "failed" ? mobileErrorText(error, language, fallback) : failureMessage(copy, kind);
  };

  if (list.state.status === "loading") return <p role="status">{copy.loading}</p>;
  if (list.state.status === "error") return <div role="alert"><p>{failureMessage(copy, list.state.failure)}</p>{list.state.failure !== "unavailable" && <button onClick={() => void list.reload()}>{copy.retry}</button>}</div>;
  const { capacity } = list.state.data;
  const remaining = Math.min(capacity.remaining.filesInProfile ?? Infinity, capacity.remaining.filesInAccount ?? Infinity);
  const canAdd = !project.archivedAt && remaining > 0;

  async function upload(file: File) {
    setMessage("");
    if (file.size > capacity.limits.maxFileBytes) { setMessage(mobileErrorText({ status: 413 }, language, copy.uploadFailed)); return; }
    const result = await action.run(() => api().uploadMaterial(project.id, file as File & { name: string; type: string }));
    if (result && !result.ok) setMessage(failed(result.error, copy.uploadFailed));
    await refresh();
  }
  async function saveNote() {
    if (!note) return;
    const result = await action.run(() => api().addNote(project.id, note.title.trim(), note.text, noteRequest.current));
    if (result?.ok) { setNote(null); noteRequest.current = crypto.randomUUID(); await refresh(); }
  }
  async function download(file: ProjectMaterial) {
    const result = await action.run(() => api().materialLink(project.id, file.id));
    if (!result?.ok) return;
    try { await Browser.open({ url: result.value.url }); } catch { window.open(result.value.url, "_blank", "noopener"); }
  }
  async function retry(file: ProjectMaterial) {
    const result = await action.run(() => api().retryMaterial(project.id, file.id));
    if (result?.ok) await list.reload(true);
  }
  async function remove(file: ProjectMaterial) {
    const result = await action.run(() => api().deleteMaterial(project.id, file.id));
    if (result?.ok) { setRemoving(null); await refresh(); }
  }

  return <div className="project-list">
    <p className="project-note">{copy.materialsNotice}</p>
    {project.archivedAt && <p className="project-note">{copy.archivedBanner}</p>}
    {(message || action.failure) && <p role="alert">{message || failureMessage(copy, action.failure)}</p>}
    <div className="project-actions">
      <input ref={picker} type="file" hidden accept={capacity.acceptedMediaTypes.join(",")} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void upload(file); }} />
      <button disabled={!canAdd || action.busy} onClick={() => picker.current?.click()}>{copy.upload}</button>
      <button disabled={!canAdd || action.busy} onClick={() => setNote({ title: "", text: "" })}>{copy.addNote}</button>
    </div>
    {Number.isFinite(remaining) && <p className="project-note">{projectText(copy.materialLimit, { count: remaining })}</p>}
    {note && <form className="project-form" onSubmit={event => { event.preventDefault(); void saveNote(); }}>
      <label>{copy.noteTitle}<input value={note.title} maxLength={100} onChange={event => setNote({ ...note, title: event.target.value })} /></label>
      <label>{copy.noteText}<textarea value={note.text} rows={5} maxLength={200000} onChange={event => setNote({ ...note, text: event.target.value })} /></label>
      <button className="primary" disabled={action.busy || !note.title.trim() || !note.text.trim()}>{copy.saveNote}</button>
      <button type="button" disabled={action.busy} onClick={() => setNote(null)}>{copy.cancel}</button>
    </form>}
    {!files.length && <p>{copy.materialsEmpty}</p>}
    {files.map(file => <div className="project-card" key={file.id} data-status={file.processingStatus}>
      <strong>{file.name}</strong>
      <small>{kindLabel(copy, file.sourceKind)} · {copy.ownedCopy} · {sizeLabel(file.bytes)}</small>
      <span className="project-status" role="status">{statusLabel(copy, file.processingStatus)}</span>
      <div className="project-actions">
        {file.processingStatus === "ready" && <button disabled={action.busy} onClick={() => void download(file)}>{copy.download}</button>}
        {file.processingStatus === "failed" && <button disabled={action.busy || Boolean(project.archivedAt)} onClick={() => void retry(file)}>{copy.retry}</button>}
        <button disabled={action.busy} onClick={() => setRemoving(file)}>{copy.delete}</button>
      </div>
    </div>)}
    {removing && <div className="project-confirm" role="alertdialog" aria-label={copy.delete}>
      <p>{copy.deleteMaterialNotice}</p>
      <button className="primary" disabled={action.busy} onClick={() => void remove(removing)}>{copy.delete}</button>
      <button disabled={action.busy} onClick={() => setRemoving(null)}>{copy.cancel}</button>
    </div>}
  </div>;
}
