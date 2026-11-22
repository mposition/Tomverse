import { useState } from "react";
import type { ProjectSummary } from "@tomverse/api-client";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileProjectsCopy } from "../../../locales/mobileProjects";
import type { ChatTransport } from "./chatTransport";
import { Sheet } from "./Sheet";
import { failureMessage } from "./projectWorkspaceState";
import { useProjectAction } from "./useProjectLoader";

/** New workspace: context is on by default and is sent explicitly, never left to a server default. */
export function ProjectCreate({ transport, language, onClose, onCreated }: {
  transport: ChatTransport; language: MobileLanguage; onClose: () => void; onCreated: (project: ProjectSummary) => void;
}) {
  const copy = mobileProjectsCopy[language];
  const action = useProjectAction();
  const [form, setForm] = useState({ name: "", description: "", instructions: "", contextEnabled: true });
  async function create() {
    const result = await action.run(async () => {
      if (!transport.projects) throw Object.assign(Error("PROJECTS_UNAVAILABLE"), { status: 503 });
      return transport.projects.create({
        name: form.name.trim(), description: form.description.trim() || undefined, instructions: form.instructions.trim() || undefined,
        contextEnabled: form.contextEnabled, memoryScope: "project_only", autoMemoryEnabled: false,
      });
    });
    if (result?.ok) onCreated(result.value);
  }
  return <Sheet className="project-sheet" title={copy.newProject} closeLabel={mobileCopy[language].close} onClose={() => { if (!action.busy) onClose(); }}>
    {action.failure && <p role="alert">{failureMessage(copy, action.failure)}</p>}
    <form className="project-form" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>{copy.projectName}<input value={form.name} maxLength={32} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>{copy.projectDescription}<textarea rows={2} maxLength={1000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <label>{copy.projectInstructions}<textarea rows={4} maxLength={16000} value={form.instructions} onChange={event => setForm({ ...form, instructions: event.target.value })} /></label>
      <p className="project-note">{copy.instructionsHint}</p>
      <label className="project-check"><input type="checkbox" checked={form.contextEnabled} onChange={event => setForm({ ...form, contextEnabled: event.target.checked })} />{copy.contextLabel}</label>
      <p className="project-note">{form.contextEnabled ? copy.contextOnHint : copy.contextOffHint}</p>
      <button className="primary" disabled={action.busy || !form.name.trim()}>{copy.createProject}</button>
    </form>
  </Sheet>;
}
