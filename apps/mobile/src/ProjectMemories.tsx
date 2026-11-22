import { useState } from "react";
import type { ProjectMemory } from "@tomverse/api-client";
import type { MobileProjectsCopy } from "../../../locales/mobileProjects";
import type { ProjectPanelProps } from "./ProjectWorkspace";
import { failureMessage } from "./projectWorkspaceState";
import { useProjectAction, useProjectLoader } from "./useProjectLoader";

const KINDS = ["preference", "decision", "constraint", "project", "expertise", "long_term_goal", "recurring_context"] as const;
const kindLabel = (copy: MobileProjectsCopy, kind: string) => ({
  preference: copy.kindPreference, decision: copy.kindDecision, constraint: copy.kindConstraint, project: copy.kindProject,
  expertise: copy.kindExpertise, long_term_goal: copy.kindGoal, recurring_context: copy.kindRecurring,
} as Record<string, string>)[kind] ?? kind;

type Draft = { kind: string; statement: string; grounds: string };
type Step = { type: "edit"; memory: ProjectMemory; text: string } | { type: "move"; memory: ProjectMemory } | { type: "delete"; memory: ProjectMemory };

/** Project memories: list, add, edit, pin, evidence, delete, and move to personal memory. */
export function ProjectMemories({ api, copy, project, onChanged, onReloadProject }: ProjectPanelProps) {
  const list = useProjectLoader(() => api().memories(project.id), project.id);
  const action = useProjectAction();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [importing, setImporting] = useState(false);
  const refresh = async () => { onReloadProject(); await list.reload(true); onChanged(); };
  async function mutate(work: () => Promise<unknown>, done?: () => void) {
    const result = await action.run(work);
    if (result?.ok) { done?.(); await refresh(); }
    return result;
  }

  if (list.state.status === "loading") return <p role="status">{copy.loading}</p>;
  if (list.state.status === "error") return <div role="alert"><p>{failureMessage(copy, list.state.failure)}</p>{list.state.failure !== "unavailable" && <button onClick={() => void list.reload()}>{copy.retry}</button>}</div>;
  const memories = list.state.data.memories.filter(item => item.status === "active" || item.status === "candidate");

  return <div className="project-list">
    <p className="project-note">{copy.memoriesNotice}</p>
    {action.failure && <p role="alert">{failureMessage(copy, action.failure)}</p>}
    <div className="project-actions">
      <button disabled={action.busy || Boolean(project.archivedAt)} onClick={() => setDraft({ kind: "preference", statement: "", grounds: "" })}>{copy.addMemory}</button>
      <button disabled={action.busy || Boolean(project.archivedAt)} onClick={() => setImporting(value => !value)}>{copy.importMemory}</button>
    </div>
    {importing && <PersonalImport api={api} copy={copy} project={project} onMoved={refresh} />}
    {draft && <form className="project-form" onSubmit={event => { event.preventDefault(); void mutate(() => api().createMemory(project.id, { kind: draft.kind, statement: draft.statement.trim(), groundsText: draft.grounds.trim() }), () => setDraft(null)); }}>
      <label>{copy.memoryKind}<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value })}>{KINDS.map(kind => <option key={kind} value={kind}>{kindLabel(copy, kind)}</option>)}</select></label>
      <label>{copy.memoryStatement}<textarea rows={3} maxLength={1000} value={draft.statement} onChange={event => setDraft({ ...draft, statement: event.target.value })} /></label>
      <label>{copy.memoryGrounds}<textarea rows={2} maxLength={2000} value={draft.grounds} onChange={event => setDraft({ ...draft, grounds: event.target.value })} /></label>
      <button className="primary" disabled={action.busy || !draft.statement.trim() || !draft.grounds.trim()}>{copy.save}</button>
      <button type="button" disabled={action.busy} onClick={() => setDraft(null)}>{copy.cancel}</button>
    </form>}
    {!memories.length && <p>{copy.memoriesEmpty}</p>}
    {memories.map(memory => <div className="project-card" key={memory.id} data-pinned={memory.pinned || undefined}>
      <small>{kindLabel(copy, memory.kind)}{memory.pinned ? ` · ${copy.pinned}` : ""}{memory.status === "candidate" ? ` · ${copy.statusCandidate}` : ""}{memory.suspendedReason ? ` · ${copy.suspended}` : ""}</small>
      {step?.type === "edit" && step.memory.id === memory.id
        ? <form className="project-form" onSubmit={event => { event.preventDefault(); void mutate(() => api().editMemory(project.id, memory.id, step.text.trim()), () => setStep(null)); }}>
            <textarea aria-label={copy.edit} rows={3} maxLength={1000} value={step.text} onChange={event => setStep({ ...step, text: event.target.value })} />
            <button className="primary" disabled={action.busy || !step.text.trim()}>{copy.save}</button>
            <button type="button" disabled={action.busy} onClick={() => setStep(null)}>{copy.cancel}</button>
          </form>
        : <p className="project-statement">{memory.statement}</p>}
      <details><summary>{copy.evidence}</summary>
        {memory.evidence.length ? <ul>{memory.evidence.map(item => <li key={item.id}>{item.manualContent || item.sourceTitle || item.sourceType}</li>)}</ul> : <p>{copy.noEvidence}</p>}
      </details>
      <div className="project-actions">
        <button disabled={action.busy} onClick={() => setStep({ type: "edit", memory, text: memory.statement })}>{copy.edit}</button>
        <button disabled={action.busy} onClick={() => void mutate(() => api().pinMemory(project.id, memory.id, !memory.pinned))}>{memory.pinned ? copy.unpin : copy.pin}</button>
        <button disabled={action.busy} onClick={() => setStep({ type: "move", memory })}>{copy.moveToPersonal}</button>
        <button disabled={action.busy} onClick={() => setStep({ type: "delete", memory })}>{copy.delete}</button>
      </div>
    </div>)}
    {step?.type === "move" && <div className="project-confirm" role="alertdialog" aria-label={copy.moveToPersonal}>
      <p>{copy.moveWarn}</p>
      <button className="primary" disabled={action.busy} onClick={() => void mutate(async () => {
        const moved = await api().moveMemory(step.memory.id, step.memory.revision, null);
        if (!moved.moved) throw Object.assign(Error("MEMORY_MOVE_REFUSED"), { status: 409 });
      }, () => setStep(null))}>{copy.moveConfirm}</button>
      <button disabled={action.busy} onClick={() => setStep(null)}>{copy.cancel}</button>
    </div>}
    {step?.type === "delete" && <div className="project-confirm" role="alertdialog" aria-label={copy.delete}>
      <p>{step.memory.statement}</p>
      <button className="primary" disabled={action.busy} onClick={() => void mutate(() => api().deleteMemory(project.id, step.memory.id), () => setStep(null))}>{copy.delete}</button>
      <button disabled={action.busy} onClick={() => setStep(null)}>{copy.cancel}</button>
    </div>}
  </div>;
}

/** Personal memories that can be moved into this project. A moved memory leaves personal use, so the warning comes before the move. */
function PersonalImport({ api, copy, project, onMoved }: Pick<ProjectPanelProps, "api" | "copy" | "project"> & { onMoved: () => Promise<void> }) {
  const list = useProjectLoader(() => api().personalMemories(project.id), project.id);
  const action = useProjectAction();
  const [pick, setPick] = useState<ProjectMemory | null>(null);
  async function move(memory: ProjectMemory) {
    const result = await action.run(async () => {
      const moved = await api().moveMemory(memory.id, memory.revision, project.id);
      if (!moved.moved) throw Object.assign(Error("MEMORY_NOT_MOVED"), { status: 409, code: "MEMORY_ITEM_STATE" });
    });
    if (result?.ok) { setPick(null); await onMoved(); await list.reload(true); }
    // A changed memory is read again, so the next attempt uses its current revision.
    else if (result?.failure === "memoryChanged") await list.reload(true);
  }
  if (list.state.status === "loading") return <p role="status">{copy.loading}</p>;
  if (list.state.status === "error") return <div role="alert"><p>{failureMessage(copy, list.state.failure)}</p>{list.state.failure !== "unavailable" && <button onClick={() => void list.reload()}>{copy.retry}</button>}</div>;
  const items = list.state.data.memories.filter(item => item.status === "active" || item.status === "candidate");
  return <div className="project-list" data-testid="personal-memory-import">
    {action.failure && <p role="alert">{failureMessage(copy, action.failure)}</p>}
    {!items.length && <p>{copy.importEmpty}</p>}
    {items.map(memory => <div className="project-card" key={memory.id}>
      <small>{kindLabel(copy, memory.kind)}</small>
      <p className="project-statement">{memory.statement}</p>
      <div className="project-actions"><button disabled={action.busy} onClick={() => setPick(memory)}>{copy.importConfirm}</button></div>
    </div>)}
    {pick && <div className="project-confirm" role="alertdialog" aria-label={copy.importMemory}>
      <p>{pick.statement}</p><p>{copy.importWarn}</p>
      <button className="primary" disabled={action.busy} onClick={() => void move(pick)}>{copy.importConfirm}</button>
      <button disabled={action.busy} onClick={() => setPick(null)}>{copy.cancel}</button>
    </div>}
  </div>;
}
