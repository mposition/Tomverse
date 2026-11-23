import { useState } from "react";
import { projectDeletionNeedsConfirmation, type ProjectDeletionSummary, type ProjectWorkspaceClient } from "@tomverse/api-client";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileProjectsCopy, projectText } from "../../../locales/mobileProjects";
import { Sheet } from "./Sheet";
import { deletionConfirmation, deletionSummaryFromError, failureMessage } from "./projectWorkspaceState";
import { useProjectAction, useProjectLoader } from "./useProjectLoader";

/**
 * The delete confirmation. It shows what stays (conversations) and what is
 * deleted (materials, memories), and sends the summary the user saw. When the
 * project changed in the meantime the server answers with the new summary,
 * which is shown for a fresh confirmation; nothing is deleted on that answer.
 */
export function ProjectDelete({ api, language, projectId, name, onClose, onDeleted }: {
  api: () => ProjectWorkspaceClient; language: MobileLanguage; projectId: string; name: string; onClose: () => void; onDeleted: () => void;
}) {
  const copy = mobileProjectsCopy[language];
  const loaded = useProjectLoader(() => api().deletionSummary(projectId), projectId);
  const action = useProjectAction();
  // A summary replaced after a stale answer; the user must confirm this one.
  const [replaced, setReplaced] = useState<ProjectDeletionSummary | null>(null);
  const [stale, setStale] = useState(false);
  const summary = replaced ?? (loaded.state.status === "ready" ? loaded.state.data : null);

  async function confirm(shown: ProjectDeletionSummary) {
    setStale(false);
    const result = await action.run(() => api().remove(projectId, deletionConfirmation(shown)));
    if (result?.ok) { onDeleted(); return; }
    if (result && (result.failure === "deleteStale" || result.failure === "deleteRequired")) {
      const next = deletionSummaryFromError(result.error);
      if (next) setReplaced(next); else { setReplaced(null); await loaded.reload(); }
      setStale(true);
    }
  }

  return <Sheet className="project-sheet" title={`${copy.deleteTitle}: ${name}`} closeLabel={mobileCopy[language].close} onClose={() => { if (!action.busy) onClose(); }}>
    {loaded.state.status === "loading" && !summary && <p role="status">{copy.loading}</p>}
    {loaded.state.status === "error" && !summary && <div role="alert"><p>{failureMessage(copy, loaded.state.failure)}</p></div>}
    {stale && <p role="alert">{copy.deleteStale}</p>}
    {action.failure && action.failure !== "deleteStale" && action.failure !== "deleteRequired" && <p role="alert">{failureMessage(copy, action.failure)}</p>}
    {summary && <form className="project-form" onSubmit={event => { event.preventDefault(); void confirm(summary); }}>
      <ul className="project-counts" data-testid="project-delete-summary">
        <li>{projectText(copy.deleteKeeps, { count: summary.conversations })}</li>
        {projectDeletionNeedsConfirmation(summary)
          ? <><li>{projectText(copy.deleteMaterials, { count: summary.materials })}</li><li>{projectText(copy.deleteMemories, { count: summary.memories })}</li></>
          : null}
      </ul>
      <p>{projectDeletionNeedsConfirmation(summary) ? copy.deleteIrreversible : copy.deleteNone}</p>
      <button className="primary" disabled={action.busy}>{copy.deleteConfirm}</button>
      <button type="button" disabled={action.busy} onClick={onClose}>{copy.cancel}</button>
    </form>}
  </Sheet>;
}
