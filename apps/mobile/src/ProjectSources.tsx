import { useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { ProjectSearchAnswer, ProjectSearchHit, ProjectSourceRead, ProjectSummary } from "@tomverse/api-client";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileProjectsCopy, projectText, type MobileProjectsCopy } from "../../../locales/mobileProjects";
import type { ChatTransport } from "./chatTransport";
import { Sheet } from "./Sheet";
import { classifyProjectFailure, createLatestGuard, failureMessage, MAX_PROJECT_REFERENCES, receiptGroups, toggleReference, type ProjectFailure, type ProjectReference } from "./projectWorkspaceState";
import { useProjectLoader } from "./useProjectLoader";

export type ProjectInfo = { project: ProjectSummary | null; failure: ProjectFailure | null };

/**
 * The project a conversation belongs to. Re-read when the account, the
 * project, or the workspace revision changes; an older answer is dropped.
 */
export function useProjectInfo(transport: ChatTransport, projectId: string | null, owner: string | null, revision: number, enabled = true): ProjectInfo | null {
  // The answer is matched on account and project only, so a refresh after an edit keeps showing the last answer instead of flickering.
  const scope = projectId && owner ? `${owner}:${projectId}` : "";
  const [info, setInfo] = useState<(ProjectInfo & { scope: string }) | null>(null);
  useEffect(() => {
    if (!scope || !projectId || !transport.projects || !enabled) return;
    let live = true;
    void transport.projects.detail(projectId)
      .then(project => { if (live) setInfo({ scope, project, failure: null }); })
      .catch(error => { const failure = classifyProjectFailure(error); if (live && failure !== "aborted") setInfo({ scope, project: null, failure }); });
    return () => { live = false; };
  }, [transport, projectId, scope, revision, enabled]);
  // A server that has not switched the workspace on is not asked at all; the chat reads as unavailable.
  if (!enabled && scope) return { project: null, failure: "unavailable" };
  return info && info.scope === scope ? info : null;
}

const sourceKind = (copy: MobileProjectsCopy, kind: ProjectSearchHit["location"]["kind"]) =>
  ({ message: copy.sourceMessage, imported: copy.sourceImported, material: copy.sourceMaterial })[kind];

/** Project chip, "Project sources" button and the list of sources attached to the next question. */
export function ProjectChatBar({ transport, language, projectId, info, references, onReferences, disabled, onOpenProject, available = true }: {
  transport: ChatTransport; language: MobileLanguage; projectId: string; info: ProjectInfo | null;
  references: ProjectReference[]; onReferences: (items: ProjectReference[]) => void; disabled: boolean; onOpenProject: () => void; available?: boolean;
}) {
  const copy = mobileProjectsCopy[language];
  const [picking, setPicking] = useState(false);
  const project = info?.project ?? null;
  const canAttach = Boolean(project && project.contextEnabled && !project.archivedAt);
  return <div className="project-chat-bar" data-testid="project-chat-bar">
    <div className="project-chat-row">
      {available
        ? <button type="button" className="project-chip" onClick={onOpenProject}><FolderOpen size={15} aria-hidden="true" />{projectText(copy.inProject, { name: project?.name ?? "…" })}</button>
        : <span className="project-chip"><FolderOpen size={15} aria-hidden="true" />{projectText(copy.inProject, { name: "…" })}</span>}
      {canAttach && <button type="button" className="project-chip" disabled={disabled} onClick={() => setPicking(true)}>{copy.sourcesButton}</button>}
    </div>
    {project?.archivedAt && <p className="project-note" role="status">{copy.archivedChat}</p>}
    {info?.failure === "unavailable" && <p className="project-note" role="status">{copy.unavailableChat}</p>}
    {references.length > 0 && <div className="project-refs">
      <p className="project-note">{projectText(copy.attachedCount, { count: references.length })} · {copy.attachNote}</p>
      <ul>{references.map(item => <li key={item.ref}><span>{item.title}</span>
        <button type="button" aria-label={`${copy.removeSource}: ${item.title}`} disabled={disabled} onClick={() => onReferences(references.filter(value => value.ref !== item.ref))}>×</button></li>)}</ul>
    </div>}
    {picking && <ProjectReferencePicker transport={transport} language={language} projectId={projectId} references={references} onReferences={onReferences} onClose={() => setPicking(false)} />}
  </div>;
}

/** Searches the project and lets the user pick sources for the next question. Choosing never touches the draft or attachments. */
function ProjectReferencePicker({ transport, language, projectId, references, onReferences, onClose }: {
  transport: ChatTransport; language: MobileLanguage; projectId: string; references: ProjectReference[]; onReferences: (items: ProjectReference[]) => void; onClose: () => void;
}) {
  const copy = mobileProjectsCopy[language];
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{ status: "idle" } | { status: "loading" } | { status: "done"; answer: ProjectSearchAnswer } | { status: "error"; failure: ProjectFailure }>({ status: "idle" });
  const guard = useRef(createLatestGuard());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { guard.current.invalidate(); controller.current?.abort(); }, []);
  async function search() {
    const text = query.trim();
    if (!text || !transport.projects) return;
    controller.current?.abort();
    const abort = controller.current = new AbortController();
    const current = guard.current.begin();
    setState({ status: "loading" });
    try {
      const answer = await transport.projects.search(projectId, text, abort.signal);
      if (current()) setState({ status: "done", answer });
    } catch (error) {
      const failure = classifyProjectFailure(error);
      if (current() && failure !== "aborted") setState({ status: "error", failure });
    }
  }
  const reference = (hit: ProjectSearchHit): ProjectReference => ({ ref: hit.ref, title: hit.title, kind: hit.location.kind });
  return <Sheet className="project-sheet" title={copy.sourcesButton} closeLabel={mobileCopy[language].close} onClose={onClose}>
    <form className="project-search" onSubmit={event => { event.preventDefault(); void search(); }}>
      <input type="search" aria-label={copy.searchPlaceholder} placeholder={copy.searchPlaceholder} maxLength={200} value={query} onChange={event => setQuery(event.target.value)} />
      <button disabled={!query.trim() || state.status === "loading"}>{copy.search}</button>
    </form>
    <p className="project-note">{projectText(copy.attachLimit, { max: MAX_PROJECT_REFERENCES })} {copy.attachNote}</p>
    {state.status === "loading" && <p role="status">{copy.loading}</p>}
    {state.status === "error" && <p role="alert">{failureMessage(copy, state.failure)}</p>}
    {state.status === "done" && <>
      {state.answer.status === "partial" || state.answer.incomplete.length > 0 ? <p className="project-note" role="status">{copy.searchPartial}</p> : null}
      {!state.answer.hits.length && <p>{copy.searchEmpty}</p>}
      <ul className="project-hits">{state.answer.hits.map(hit => {
        const chosen = references.some(item => item.ref === hit.ref);
        return <li key={hit.ref} className="project-card">
          <strong>{hit.title}</strong><small>{sourceKind(copy, hit.location.kind)}</small><p>{hit.snippet}</p>
          <button aria-pressed={chosen} disabled={!chosen && references.length >= MAX_PROJECT_REFERENCES} onClick={() => onReferences(toggleReference(references, reference(hit)))}>{chosen ? copy.attached : copy.attach}</button>
        </li>;
      })}</ul>
    </>}
  </Sheet>;
}

/** The sources a project answer was given. Opening one re-reads it, so a deleted source shows as unavailable. */
export function ProjectReceiptSheet({ transport, language, projectId, messageId, onClose }: {
  transport: ChatTransport; language: MobileLanguage; projectId: string; messageId: string; onClose: () => void;
}) {
  const copy = mobileProjectsCopy[language];
  const receipt = useProjectLoader(async () => {
    if (!transport.projects) throw Object.assign(Error("PROJECTS_UNAVAILABLE"), { status: 503 });
    return transport.projects.receipt(messageId);
  }, messageId);
  const [opened, setOpened] = useState<Record<string, ProjectSourceRead | "loading" | "failed">>({});
  async function open(ref: string) {
    if (!transport.projects) return;
    setOpened(value => ({ ...value, [ref]: "loading" }));
    try {
      const read = await transport.projects.readSource(projectId, ref);
      setOpened(value => ({ ...value, [ref]: read }));
    } catch (error) {
      if (classifyProjectFailure(error) !== "aborted") setOpened(value => ({ ...value, [ref]: "failed" }));
    }
  }
  const groups = receipt.state.status === "ready" ? receiptGroups(receipt.state.data) : null;
  const section = (title: string, sources: NonNullable<typeof groups>["context"]) => sources.length ? <section>
    <h3>{title}</h3>
    <ul className="project-hits">{sources.map(source => {
      const read = opened[source.ref];
      return <li key={source.ref} className="project-card">
        <strong>{source.title}</strong>
        <button disabled={read === "loading"} onClick={() => void open(source.ref)}>{copy.viewSource}</button>
        {read === "failed" && <p role="alert">{copy.failed}</p>}
        {read && read !== "loading" && read !== "failed" && (read.status === "ok" ? <p className="project-source-text">{read.content}</p> : <p role="status">{copy.sourceUnavailable}</p>)}
      </li>;
    })}</ul>
  </section> : null;
  return <Sheet className="project-sheet" title={copy.receiptTitle} closeLabel={mobileCopy[language].close} onClose={onClose}>
    {receipt.state.status === "loading" && <p role="status">{copy.loading}</p>}
    {receipt.state.status === "error" && <p role="alert">{failureMessage(copy, receipt.state.failure)}</p>}
    {groups && <>
      <p className="project-note">{copy.receiptNote}</p>
      {!groups.context.length && !groups.tool.length && <p>{copy.receiptEmpty}</p>}
      {section(copy.viaContext, groups.context)}
      {section(copy.viaTool, groups.tool)}
    </>}
  </Sheet>;
}
