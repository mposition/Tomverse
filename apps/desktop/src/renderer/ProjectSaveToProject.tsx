import { useRef, useState } from "react";
import { FolderPlus, Loader2 } from "lucide-react";
import type { MaterialSource, ProjectMaterial, ProjectSummary } from "../../../../packages/api-client/src/projectWorkspace";
import { createRequestIdMemo, materialIntentKey } from "../../../../lib/projectWorkspaceUi";
import type { Language } from "../../../../lib/language";
import type { ChatConversation } from "../chat-contract";
import { ErrorLine, Spinner, desktopProjectClient, useProjectCopy, useProjectResource } from "./project-ui";

// One memo for the app: a retry of the same save keeps its client request id and so returns the same copy.
const requestIds = createRequestIdMemo();

type SourceInput = Extract<Parameters<ReturnType<typeof desktopProjectClient>["saveSource"]>[1], MaterialSource>;
type SaveState =
  | { status: "idle" } | { status: "saving" } | { status: "failed"; error: unknown }
  | { status: "saved"; created: boolean; file: ProjectMaterial; projectId: string };

/**
 * "Save to project materials" on an attachment, a generated file or a Research report. What is
 * saved is a separate copy the project owns; the dialog says so before and after the save.
 */
export function SaveToProject({ source, language, label, testId = "project-save-open", defaultProjectId, onViewMaterials }: {
  source: SourceInput; language: Language; label?: string; testId?: string; defaultProjectId?: string | null;
  onViewMaterials?: (projectId: string) => void;
}) {
  const copy = useProjectCopy(language);
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="soft pw-save-button" data-testid={testId} title={label} onClick={() => setOpen(true)}>
      <FolderPlus size={15} aria-hidden="true" /> {copy.t("projectWorkspace.save.open")}
    </button>
    {open && <SaveDialog source={source} copy={copy} defaultProjectId={defaultProjectId} onClose={() => setOpen(false)} onViewMaterials={onViewMaterials} />}
  </>;
}

function SaveDialog({ source, copy, defaultProjectId, onClose, onViewMaterials }: {
  source: SourceInput; copy: ReturnType<typeof useProjectCopy>; defaultProjectId?: string | null; onClose: () => void; onViewMaterials?: (projectId: string) => void;
}) {
  const { t } = copy;
  const client = desktopProjectClient();
  const projects = useProjectResource<ProjectSummary[]>(() => client.list(), "project-save-targets");
  const [chosen, setChosen] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const dialog = useRef<HTMLDialogElement | null>(null);
  const targets = (projects.data ?? []).filter((item) => !item.archivedAt);
  const targetId = chosen ?? (defaultProjectId && targets.some((item) => item.id === defaultProjectId) ? defaultProjectId : targets[0]?.id ?? null);

  async function save() {
    if (!targetId || state.status === "saving") return;
    setState({ status: "saving" });
    try {
      const intent = materialIntentKey(targetId, source);
      const result = await client.saveSource(targetId, source, requestIds.get(intent));
      requestIds.release(intent);
      setState({ status: "saved", created: result.created, file: result.file, projectId: targetId });
    } catch (error) {
      setState({ status: "failed", error });
    }
  }

  return <dialog ref={(node) => { dialog.current = node; if (node && !node.open) node.showModal(); }} className="task-github-dialog pw-dialog" data-testid="project-save-dialog"
    aria-labelledby="project-save-title" onCancel={(event) => { event.preventDefault(); if (state.status !== "saving") onClose(); }}>
    <div>
      <header><h2 id="project-save-title">{t("projectWorkspace.save.title")}</h2></header>
      {state.status === "saved" ? <div className="pw-dialog-body" data-testid="project-save-done">
        <p role="status" className="pw-strong">{t(state.created ? "projectWorkspace.save.savedNew" : "projectWorkspace.save.savedExisting")}</p>
        <p>{state.file.name}</p>
        <p>{t("projectWorkspace.save.independent")}</p>
        <p className="pw-muted">{t("projectWorkspace.save.processingHint")}</p>
      </div> : <div className="pw-dialog-body">
        <p>{t("projectWorkspace.save.intro")}</p>
        {projects.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
        {projects.status === "error" && <ErrorLine error={projects.error} copy={copy} onRetry={() => void projects.reload()} />}
        {projects.status === "ready" && targets.length === 0 && <p data-testid="project-save-none">{t("projectWorkspace.save.noProjects")}</p>}
        {targets.length > 0 && <>
          <label className="pw-label" htmlFor="project-save-target">{t("projectWorkspace.save.target")}</label>
          <select id="project-save-target" className="pw-select" data-testid="project-save-target" value={targetId ?? ""} onChange={(event) => setChosen(event.currentTarget.value)}>
            {targets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </>}
        {state.status === "failed" && <ErrorLine error={state.error} copy={copy} testId="project-save-error" />}
      </div>}
      <footer className="pw-actions">
        {state.status === "saved" ? <>
          <button type="button" className="soft" onClick={onClose}>{t("projectWorkspace.close")}</button>
          {onViewMaterials && <button type="button" className="primary" data-testid="project-save-view" onClick={() => { onViewMaterials(state.projectId); onClose(); }}>{t("projectWorkspace.save.viewMaterials")}</button>}
        </> : <>
          <button type="button" className="soft" disabled={state.status === "saving"} onClick={onClose}>{t("projectWorkspace.cancel")}</button>
          <button type="button" className="primary" data-testid="project-save-submit" disabled={!targetId || state.status === "saving"} onClick={() => void save()}>
            {state.status === "saving" && <Loader2 size={15} className="pw-spin" aria-hidden="true" />} {t(state.status === "failed" ? "projectWorkspace.retry" : "projectWorkspace.save.submit")}
          </button>
        </>}
      </footer>
    </div>
  </dialog>;
}

/** The save buttons for one saved message: its attachments and its generated files. */
export function MessageProjectSaves({ message, language, projectId, onViewMaterials }: {
  message: ChatConversation["messages"][number]; language: Language; projectId?: string | null; onViewMaterials: (projectId: string) => void;
}) {
  const attachments = message.role === "user" ? (message.attachments ?? []).filter((item) => item.attachmentId && !item.unavailableAt) : [];
  const files = message.role === "assistant" ? message.artifacts.filter((item) => item.status === "ready") : [];
  if (!attachments.length && !files.length) return null;
  return <div className="pw-saves">
    {attachments.map((item) => <SaveToProject key={item.id} language={language} label={item.name} testId="attachment-save-to-project" defaultProjectId={projectId}
      source={{ sourceKind: "message_attachment", attachmentId: item.attachmentId }} onViewMaterials={onViewMaterials} />)}
    {files.map((item) => <SaveToProject key={item.id} language={language} label={item.filename} testId="artifact-save-to-project" defaultProjectId={projectId}
      source={{ sourceKind: "generated_artifact", artifactId: item.id }} onViewMaterials={onViewMaterials} />)}
  </div>;
}
