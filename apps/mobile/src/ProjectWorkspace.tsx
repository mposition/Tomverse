import { useState } from "react";
import type { ProjectConversationRow, ProjectSummary, ProjectWorkspaceClient } from "@tomverse/api-client";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileProjectsCopy, projectText, type MobileProjectsCopy } from "../../../locales/mobileProjects";
import type { ChatTransport } from "./chatTransport";
import { Sheet } from "./Sheet";
import { ProjectMaterials } from "./ProjectMaterials";
import { ProjectMemories } from "./ProjectMemories";
import { ProjectSettings } from "./ProjectSettings";
import { failureMessage } from "./projectWorkspaceState";
import { useProjectAction, useProjectLoader } from "./useProjectLoader";

export type ProjectTab = "overview" | "chats" | "materials" | "memories" | "settings";
const TABS: ProjectTab[] = ["overview", "chats", "materials", "memories", "settings"];
const tabLabel = (copy: MobileProjectsCopy, tab: ProjectTab) =>
  ({ overview: copy.tabOverview, chats: copy.tabChats, materials: copy.tabMaterials, memories: copy.tabMemories, settings: copy.tabSettings })[tab];

export type ProjectPanelProps = {
  api: () => ProjectWorkspaceClient; language: MobileLanguage; copy: MobileProjectsCopy; project: ProjectSummary;
  /** Replaces the loaded project (a save returns the new revision). */
  onProject: (project: ProjectSummary) => void; onChanged: () => void; onReloadProject: () => void;
};

export function ProjectWorkspace({ transport, language, projectId, initialTab = "overview", onClose, onOpenConversation, onNewChat, onChanged, onDeleted }: {
  transport: ChatTransport; language: MobileLanguage; projectId: string; initialTab?: ProjectTab; onClose: () => void;
  onOpenConversation: (id: string) => void; onNewChat: (project: ProjectSummary) => void; onChanged: () => void; onDeleted: (id: string) => void;
}) {
  const copy = mobileProjectsCopy[language];
  const [tab, setTab] = useState<ProjectTab>(initialTab);
  // Read at call time so every request is bound to the sign-in that exists now.
  const api = () => { if (!transport.projects) throw Object.assign(Error("PROJECTS_UNAVAILABLE"), { status: 503, code: "PROJECTS_UNAVAILABLE" }); return transport.projects; };
  const detail = useProjectLoader(() => api().detail(projectId), projectId);
  const project = detail.state.status === "ready" ? detail.state.data : null;
  const panel = project ? { api, language, copy, project, onChanged, onReloadProject: () => void detail.reload(true),
    onProject: (next: ProjectSummary) => { detail.set({ status: "ready", data: next }); onChanged(); } } : null;
  return <Sheet className="project-sheet" title={project?.name ?? copy.openWorkspace} closeLabel={mobileCopy[language].close} onClose={onClose}>
    {detail.state.status === "loading" && <p role="status" className="project-note">{copy.loading}</p>}
    {detail.state.status === "error" && <div role="alert" className="project-note">
      <p>{detail.state.failure === "unavailable" ? copy.unavailable : failureMessage(copy, detail.state.failure === "failed" ? null : detail.state.failure)}</p>
      {detail.state.failure !== "unavailable" && detail.state.failure !== "notFound" && <button onClick={() => void detail.reload()}>{copy.retry}</button>}
    </div>}
    {panel && project && <>
      {project.archivedAt && <p className="project-note" role="status">{copy.archivedBanner}</p>}
      <div className="project-tabs" role="tablist">
        {TABS.map(item => <button key={item} role="tab" id={`project-tab-${item}`} aria-selected={tab === item} aria-controls="project-tab-panel" onClick={() => setTab(item)}>{tabLabel(copy, item)}</button>)}
      </div>
      <div id="project-tab-panel" role="tabpanel" aria-labelledby={`project-tab-${tab}`} className="project-panel">
        {tab === "overview" && <Overview {...panel} onNewChat={() => onNewChat(project)} />}
        {tab === "chats" && <Chats {...panel} onOpen={onOpenConversation} />}
        {tab === "materials" && <ProjectMaterials {...panel} />}
        {tab === "memories" && <ProjectMemories {...panel} />}
        {tab === "settings" && <ProjectSettings {...panel} onDeleted={() => onDeleted(projectId)} />}
      </div>
    </>}
  </Sheet>;
}

function Overview({ copy, project, onNewChat }: ProjectPanelProps & { onNewChat: () => void }) {
  return <div className="project-overview">
    <p className="project-context" data-context={project.contextEnabled ? "on" : "off"}>{project.contextEnabled ? copy.contextOn : copy.contextOff}</p>
    {project.description && <p>{project.description}</p>}
    <ul className="project-counts">
      <li>{projectText(copy.summaryChats, { count: project.conversationCount })}</li>
      <li>{projectText(copy.summaryMaterials, { count: project.materialCount })}</li>
      <li>{projectText(copy.summaryMemories, { count: project.memoryCount })}</li>
    </ul>
    <h3>{copy.instructionsHeading}</h3>
    <p className="project-instructions">{project.instructions || copy.noInstructions}</p>
    <button className="primary" disabled={Boolean(project.archivedAt)} onClick={onNewChat}>{copy.newChat}</button>
  </div>;
}

function Chats({ api, copy, project, onChanged, onOpen }: ProjectPanelProps & { onOpen: (id: string) => void }) {
  const rows = useProjectLoader(() => api().conversations(project.id), project.id);
  const action = useProjectAction();
  const [leaving, setLeaving] = useState<ProjectConversationRow | null>(null);
  async function leave(row: ProjectConversationRow) {
    const result = await action.run(() => api().moveConversation(row.id, null));
    if (result?.ok) { setLeaving(null); onChanged(); await rows.reload(true); }
  }
  if (rows.state.status === "loading") return <p role="status">{copy.loading}</p>;
  if (rows.state.status === "error") return <div role="alert"><p>{failureMessage(copy, rows.state.failure)}</p><button onClick={() => void rows.reload()}>{copy.retry}</button></div>;
  const list = rows.state.data;
  return <div className="project-list">
    {action.failure && <p role="alert">{failureMessage(copy, action.failure)}</p>}
    {!list.length && <p>{copy.chatsEmpty}</p>}
    {list.map(row => <div className="project-row" key={row.id}>
      <button className="project-row-main" disabled={row.locked} onClick={() => onOpen(row.id)}>
        <span>{row.title || copy.untitled}</span>{row.locked && <small>{copy.locked}</small>}
      </button>
      <button disabled={action.busy} onClick={() => setLeaving(row)}>{copy.removeFromProject}</button>
    </div>)}
    {leaving && <div className="project-confirm" role="alertdialog" aria-label={copy.removeFromProject}>
      <p>{copy.moveNotice}</p>
      <button className="primary" disabled={action.busy} onClick={() => void leave(leaving)}>{copy.removeFromProject}</button>
      <button disabled={action.busy} onClick={() => setLeaving(null)}>{copy.cancel}</button>
    </div>}
  </div>;
}
