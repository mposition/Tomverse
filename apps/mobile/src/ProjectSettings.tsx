import { useState } from "react";
import type { ProjectMemoryScope, ProjectSettingsPatch, ProjectSummary } from "@tomverse/api-client";
import type { ProjectPanelProps } from "./ProjectWorkspace";
import { ProjectDelete } from "./ProjectDelete";
import { failureMessage } from "./projectWorkspaceState";
import { useProjectAction } from "./useProjectLoader";

/** What the form can change; only differences are sent, with the revision it was opened at. */
export function settingsPatch(project: ProjectSummary, form: { name: string; description: string; instructions: string; contextEnabled: boolean; memoryScope: ProjectMemoryScope; autoMemoryEnabled: boolean }): ProjectSettingsPatch {
  const patch: ProjectSettingsPatch = {};
  if (form.name.trim() !== project.name) patch.name = form.name.trim();
  if (form.description !== project.description) patch.description = form.description;
  if (form.instructions !== project.instructions) patch.instructions = form.instructions;
  if (form.contextEnabled !== project.contextEnabled) patch.contextEnabled = form.contextEnabled;
  if (form.memoryScope !== project.memoryScope) patch.memoryScope = form.memoryScope;
  if (form.autoMemoryEnabled !== project.autoMemoryEnabled) patch.autoMemoryEnabled = form.autoMemoryEnabled;
  return patch;
}

export function ProjectSettings(props: ProjectPanelProps & { onDeleted: () => void }) {
  // The form is re-seeded whenever the project's revision changes.
  return <SettingsForm key={props.project.revision} {...props} />;
}

function SettingsForm({ api, language, copy, project, onProject, onReloadProject, onDeleted }: ProjectPanelProps & { onDeleted: () => void }) {
  const action = useProjectAction();
  const [form, setForm] = useState({ name: project.name, description: project.description, instructions: project.instructions, contextEnabled: project.contextEnabled, memoryScope: project.memoryScope, autoMemoryEnabled: project.autoMemoryEnabled });
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const patch = settingsPatch(project, form);
  const dirty = Object.keys(patch).length > 0;
  const set = (change: Partial<typeof form>) => { setSaved(false); setForm({ ...form, ...change }); };
  async function apply(change: ProjectSettingsPatch) {
    setSaved(false);
    const result = await action.run(() => api().update(project.id, project.revision, change));
    if (result?.ok) { setSaved(true); onProject(result.value); }
  }

  return <div className="project-form">
    {action.failure === "conflict" && <div role="alert" className="project-note"><p>{copy.conflict}</p><button onClick={onReloadProject}>{copy.reload}</button></div>}
    {action.failure && action.failure !== "conflict" && <p role="alert">{failureMessage(copy, action.failure)}</p>}
    {saved && <p role="status">{copy.saved}</p>}
    <form className="project-form" onSubmit={event => { event.preventDefault(); void apply(patch); }}>
      <label>{copy.projectName}<input value={form.name} maxLength={32} onChange={event => set({ name: event.target.value })} /></label>
      <label>{copy.projectDescription}<textarea rows={3} maxLength={1000} value={form.description} onChange={event => set({ description: event.target.value })} /></label>
      <label>{copy.projectInstructions}<textarea rows={6} maxLength={16000} value={form.instructions} onChange={event => set({ instructions: event.target.value })} /></label>
      <p className="project-note">{copy.instructionsHint}</p>
      <label className="project-check"><input type="checkbox" checked={form.contextEnabled} onChange={event => set({ contextEnabled: event.target.checked })} />{copy.contextLabel}</label>
      <p className="project-note">{form.contextEnabled ? copy.contextOnHint : copy.contextOffHint}</p>
      <label>{copy.memoryScopeLabel}
        <select value={form.memoryScope} disabled={!form.contextEnabled} onChange={event => set({ memoryScope: event.target.value as ProjectMemoryScope })}>
          <option value="project_only">{copy.scopeProjectOnly}</option>
          <option value="project_and_personal">{copy.scopeBoth}</option>
        </select>
      </label>
      <label className="project-check"><input type="checkbox" checked={form.autoMemoryEnabled} disabled={!form.contextEnabled} onChange={event => set({ autoMemoryEnabled: event.target.checked })} />{copy.autoMemory}</label>
      <p className="project-note">{copy.autoMemoryNote}</p>
      <button className="primary" disabled={action.busy || !dirty || !form.name.trim()}>{copy.save}</button>
    </form>
    <hr />
    <p className="project-note">{copy.archiveNote}</p>
    <button disabled={action.busy} onClick={() => void apply({ archived: !project.archivedAt })}>{project.archivedAt ? copy.restore : copy.archive}</button>
    <button className="project-danger" disabled={action.busy} onClick={() => setDeleting(true)}>{copy.deleteProject}</button>
    {deleting && <ProjectDelete api={api} language={language} projectId={project.id} name={project.name} onClose={() => setDeleting(false)} onDeleted={onDeleted} />}
  </div>;
}
