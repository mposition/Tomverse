import { useCallback, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowLeft, Check, Loader2, MessageSquarePlus, Plus, Search } from "lucide-react";
import type { ProjectConversationRow, ProjectSearchHit, ProjectSummary } from "../../../../packages/api-client/src/projectWorkspace";
import { PROJECT_WORKSPACE_TABS, type ProjectWorkspaceRoute, type ProjectWorkspaceTab } from "../../../../lib/projectWorkspaceRoute";
import {
  DEFAULT_PROJECT_CREATE_FORM, buildProjectCreateInput, conversationMoveEffect, projectNameValid, projectStatusLabelKey, PROJECT_UI_LIMITS,
  type ProjectCreateForm,
} from "../../../../lib/projectWorkspaceUi";
import type { Language } from "../../../../lib/language";
import { mobileCopy } from "../../../../locales/mobile";
import type { ChatHistoryRow } from "../chat-contract";
import {
  ConfirmDialog, EmptyState, ErrorLine, Spinner, desktopProjectClient, formatProjectDate, useProjectCopy, useProjectResource, type ProjectCopy,
} from "./project-ui";
import { ProjectMaterialsTab, ProjectMemoriesTab, ProjectSettingsTab } from "./ProjectTabs";

export type ProjectTabProps = {
  project: ProjectSummary;
  archived: boolean;
  copy: ProjectCopy;
  /** Re-read the project (counts, revision) and tell the rest of the app. */
  onProjectChanged: () => void;
};

export type ProjectWorkspaceProps = {
  language: Language;
  route: ProjectWorkspaceRoute;
  /** The Chat history, for "add an existing chat". */
  conversations: ChatHistoryRow[];
  onRoute: (route: ProjectWorkspaceRoute | null) => void;
  onOpenConversation: (row: ProjectConversationRow) => void;
  onNewChat: (project: { id: string; name: string }) => void;
  /** A project or one of its chats changed: the sidebar lists must be read again. */
  onChanged: () => void;
  onDeleted: (projectId: string) => void;
};

/** The project workspace pane: overview, chats, materials, memories and settings, plus a search. */
export function ProjectWorkspace(props: ProjectWorkspaceProps) {
  const copy = useProjectCopy(props.language);
  if (props.route.kind === "new") return <ProjectCreate copy={copy} onRoute={props.onRoute} onChanged={props.onChanged} />;
  return <ProjectScreen key={props.route.projectId} {...props} projectId={props.route.projectId} tab={props.route.tab} copy={copy} />;
}

/** A chat the Desktop Chat can open itself; Review and image chats open in their own workspaces. */
export const projectChatOpenable = (row: Pick<ProjectConversationRow, "kind" | "productKey">) => row.kind === "chat" && row.productKey === "chat";

function ProjectScreen({ projectId, tab, copy, onRoute, onOpenConversation, onNewChat, onChanged, onDeleted, conversations }:
  ProjectWorkspaceProps & { projectId: string; tab: ProjectWorkspaceTab; copy: ProjectCopy }) {
  const { t, tf } = copy;
  const client = desktopProjectClient();
  const tabsId = useId();
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightFileId, setHighlightFileId] = useState<string | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const resource = useProjectResource<ProjectSummary>(() => client.detail(projectId), `project:${projectId}`);
  const reload = resource.reload;
  const project = resource.data;
  const archived = Boolean(project?.archivedAt);
  const changed = useCallback(() => { onChanged(); void reload({ quiet: true }); }, [onChanged, reload]);
  const go = (next: ProjectWorkspaceTab) => onRoute({ kind: "project", projectId, tab: next });

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let target = index;
    if (event.key === "ArrowRight") target = (index + 1) % PROJECT_WORKSPACE_TABS.length;
    else if (event.key === "ArrowLeft") target = (index - 1 + PROJECT_WORKSPACE_TABS.length) % PROJECT_WORKSPACE_TABS.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = PROJECT_WORKSPACE_TABS.length - 1;
    else return;
    event.preventDefault();
    const next = PROJECT_WORKSPACE_TABS[target];
    go(next);
    queueMicrotask(() => tabRefs.current[next]?.focus());
  }

  function openHit(hit: ProjectSearchHit) {
    if (hit.location.kind === "material") {
      setHighlightFileId(hit.location.fileId ?? null);
      go("materials");
      return;
    }
    const id = hit.location.conversationId;
    if (!id) return;
    const row = conversations.find((item) => item.id === id);
    onOpenConversation({ id, title: row?.title ?? hit.title, productKey: row ? row.productKey ?? null : "chat", kind: row?.kind ?? "chat", locked: row?.isLocked === true,
      continuation: row?.surface === "continuation" ? { provider: "" } : null, messageCount: 0, updatedAt: row?.updatedAt ?? "" });
  }

  return <div className="desktop-chat-workspace pw-pane" data-testid="project-workspace" data-project-id={projectId} data-tab={tab}>
    <div className="scroll"><div className="content pw-content">
      <header className="pw-header">
        <button type="button" className="soft" data-testid="project-workspace-close" onClick={() => onRoute(null)}>
          <ArrowLeft size={15} aria-hidden="true" /> {t("projectWorkspace.back")}
        </button>
        <div className="pw-title">
          <h1 data-testid="project-workspace-title">{project?.name ?? t("projectWorkspace.loading")}</h1>
          {project && <p className="pw-chips">
            <span className={project.archivedAt ? "pw-chip pw-chip-warn" : project.contextEnabled ? "pw-chip pw-chip-good" : "pw-chip"} data-testid="project-workspace-status">
              {t(projectStatusLabelKey(project))}
            </span>
            <span className="pw-muted">{t(project.contextEnabled ? "projectWorkspace.statusHint.contextOn" : "projectWorkspace.statusHint.folder")}</span>
          </p>}
        </div>
        {project && <div className="pw-actions">
          <button type="button" className="soft" aria-expanded={searchOpen} data-testid="project-workspace-search-toggle" onClick={() => setSearchOpen((value) => !value)}>
            <Search size={15} aria-hidden="true" /> {t("projectWorkspace.search.title")}
          </button>
          <button type="button" className="primary" disabled={archived} data-testid="project-workspace-new-chat" onClick={() => onNewChat({ id: project.id, name: project.name })}>
            <MessageSquarePlus size={15} aria-hidden="true" /> {t("projectWorkspace.newChat")}
          </button>
        </div>}
      </header>

      {resource.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
      {resource.status === "error" && !project && <EmptyState title={t("projectWorkspace.unavailableTitle")} body={t("projectWorkspace.unavailableBody")}
        action={<button type="button" className="soft" onClick={() => onRoute(null)}>{t("projectWorkspace.back")}</button>} />}
      {resource.status === "error" && !project && <ErrorLine error={resource.error} copy={copy} onRetry={() => void reload()} testId="project-workspace-error" />}

      {project && <>
        {archived && <p role="status" data-testid="project-archived-banner" className="pw-banner pw-banner-warn">{t("projectWorkspace.archivedBanner")}</p>}
        {searchOpen && <ProjectSearchPanel projectId={project.id} copy={copy} onOpenHit={openHit} />}
        <div role="tablist" aria-label={tf("projectWorkspace.tabsLabel", { name: project.name })} className="pw-tabs">
          {PROJECT_WORKSPACE_TABS.map((item, index) => <button key={item} type="button" role="tab" id={`${tabsId}-tab-${item}`}
            ref={(node) => { tabRefs.current[item] = node; }} aria-selected={tab === item} aria-controls={`${tabsId}-panel-${item}`}
            tabIndex={tab === item ? 0 : -1} data-testid={`project-tab-${item}`} onClick={() => go(item)} onKeyDown={(event) => onTabKeyDown(event, index)}>
            {t(`projectWorkspace.tabs.${item}`)}
            {item === "materials" && (project.failedMaterialCount ?? 0) > 0 && <span className="pw-chip pw-chip-bad">{project.failedMaterialCount}</span>}
          </button>)}
        </div>
        <div role="tabpanel" id={`${tabsId}-panel-${tab}`} aria-labelledby={`${tabsId}-tab-${tab}`}>
          {tab === "overview" && <ProjectOverviewTab project={project} archived={archived} copy={copy} onProjectChanged={changed} onGoTab={go} />}
          {tab === "conversations" && <ProjectConversationsTab project={project} archived={archived} copy={copy} onProjectChanged={changed}
            conversations={conversations} onOpenConversation={onOpenConversation} onNewChat={() => onNewChat({ id: project.id, name: project.name })} />}
          {tab === "materials" && <ProjectMaterialsTab project={project} archived={archived} copy={copy} onProjectChanged={changed} highlightFileId={highlightFileId} />}
          {tab === "memories" && <ProjectMemoriesTab project={project} archived={archived} copy={copy} onProjectChanged={changed} />}
          {tab === "settings" && <ProjectSettingsTab project={project} archived={archived} copy={copy} onProjectChanged={changed} onDeleted={() => onDeleted(project.id)} />}
        </div>
      </>}
    </div></div>
  </div>;
}

function ProjectOverviewTab({ project, copy, onGoTab }: ProjectTabProps & { onGoTab: (tab: ProjectWorkspaceTab) => void }) {
  const { t, tf, language } = copy;
  const failed = project.failedMaterialCount ?? 0;
  const stats: Array<{ tab: ProjectWorkspaceTab; value: number }> = [
    { tab: "conversations", value: project.conversationCount }, { tab: "materials", value: project.materialCount }, { tab: "memories", value: project.memoryCount },
  ];
  return <div className="pw-stack" data-testid="project-overview">
    {project.description && <p className="pw-text" data-testid="project-overview-description">{project.description}</p>}
    <ul className="pw-stats">{stats.map((item) => <li key={item.tab}>
      <button type="button" className="pw-card pw-stat" data-testid={`project-stat-${item.tab}`} onClick={() => onGoTab(item.tab)}>
        <strong>{item.value}</strong><span className="pw-muted">{t(`projectWorkspace.tabs.${item.tab}`)}</span>
      </button></li>)}</ul>
    {failed > 0 && <p role="status" data-testid="project-overview-failed" className="pw-banner pw-banner-bad">
      {tf("projectWorkspace.overview.failedMaterials", { count: failed })}{" "}
      <button type="button" className="pw-link" onClick={() => onGoTab("materials")}>{t("projectWorkspace.overview.reviewMaterials")}</button>
    </p>}
    <section className="pw-card pw-stack">
      <h2>{t("projectWorkspace.overview.howTitle")}</h2>
      <p>{t(project.contextEnabled ? "projectWorkspace.overview.howOn" : "projectWorkspace.overview.howOff")}</p>
      {project.contextEnabled && <ul className="pw-list">
        <li>{t(project.memoryScope === "project_and_personal" ? "projectWorkspace.overview.memoryPersonal" : "projectWorkspace.overview.memoryProjectOnly")}</li>
        <li>{t(project.autoMemoryEnabled ? "projectWorkspace.overview.autoOn" : "projectWorkspace.overview.autoOff")}</li>
        {project.instructions.trim() && <li>{t("projectWorkspace.overview.hasInstructions")}</li>}
      </ul>}
    </section>
    <p className="pw-muted">{tf("projectWorkspace.overview.updated", { date: formatProjectDate(project.updatedAt, language) })}</p>
  </div>;
}

type MoveTarget = { conversation: { id: string; title: string }; target: string | null; mode: "add" | "move" | "remove" };

function ProjectConversationsTab({ project, archived, copy, onProjectChanged, conversations, onOpenConversation, onNewChat }: ProjectTabProps & {
  conversations: ChatHistoryRow[]; onOpenConversation: (row: ProjectConversationRow) => void; onNewChat: () => void;
}) {
  const { t, tf, language } = copy;
  const client = desktopProjectClient();
  const rows = useProjectResource<ProjectConversationRow[]>(() => client.conversations(project.id), `project-conversations:${project.id}`);
  const projects = useProjectResource<ProjectSummary[]>(() => client.list(), "project-list");
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<MoveTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const projectById = useMemo(() => new Map((projects.data ?? []).map((item) => [item.id, item])), [projects.data]);
  const candidates = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return conversations.filter((item) => (item.projectId ?? null) !== project.id && item.kind === "chat" && !item.isLocked)
      .filter((item) => !text || item.title.toLowerCase().includes(text)).slice(0, 40);
  }, [conversations, filter, project.id]);
  const targetProject = (id: string | null) => id === project.id ? project : id ? projectById.get(id) ?? null : null;

  async function confirm() {
    if (!pending) return;
    setBusy(true); setFailure(null);
    try {
      await client.moveConversation(pending.conversation.id, pending.target);
      setPending(null);
      void rows.reload({ quiet: true });
      onProjectChanged();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  const otherProjects = (projects.data ?? []).filter((item) => item.id !== project.id && !item.archivedAt);
  const effect = pending && conversationMoveEffect(
    pending.mode === "add" ? null : pending.mode === "move" ? targetProject(conversations.find((item) => item.id === pending.conversation.id)?.projectId ?? project.id) : project,
    targetProject(pending.target));

  return <div className="pw-stack" data-testid="project-conversations">
    <div className="pw-actions">
      <button type="button" className="primary" disabled={archived} data-testid="project-conversations-new" onClick={onNewChat}>
        <MessageSquarePlus size={15} aria-hidden="true" /> {t("projectWorkspace.newChat")}
      </button>
      <button type="button" className="soft" disabled={archived} aria-expanded={adding} data-testid="project-conversations-add-toggle" onClick={() => setAdding((value) => !value)}>
        <Plus size={15} aria-hidden="true" /> {t("projectWorkspace.conversations.addExisting")}
      </button>
    </div>
    {archived && <p className="pw-muted">{t("projectWorkspace.conversations.archivedHint")}</p>}
    <p className="pw-text" data-testid="project-move-notice">{t("projectWorkspace.conversations.moveNotice")}</p>
    {adding && !archived && <section className="pw-card pw-stack" data-testid="project-conversations-picker">
      <label className="pw-label" htmlFor="project-add-filter">{t("projectWorkspace.conversations.pickTitle")}</label>
      <input id="project-add-filter" className="history-search" value={filter} placeholder={t("projectWorkspace.conversations.filterPlaceholder")} onChange={(event) => setFilter(event.currentTarget.value)} />
      {candidates.length === 0 ? <p className="pw-muted">{t("projectWorkspace.conversations.noCandidates")}</p>
        : <ul className="pw-rows">{candidates.map((item) => {
          const from = item.projectId ? projectById.get(item.projectId) : null;
          return <li key={item.id} data-testid="project-conversations-candidate">
            <span className="pw-grow pw-strong">{item.title}</span>
            {from && <span className="pw-chip">{from.name}</span>}
            <button type="button" className="soft" onClick={() => setPending({ conversation: { id: item.id, title: item.title }, target: project.id, mode: item.projectId ? "move" : "add" })}>
              {t(item.projectId ? "projectWorkspace.conversations.moveHere" : "projectWorkspace.conversations.add")}
            </button>
          </li>;
        })}</ul>}
    </section>}
    {rows.status === "loading" && <Spinner label={t("projectWorkspace.loading")} />}
    {rows.status === "error" && <ErrorLine error={rows.error} copy={copy} onRetry={() => void rows.reload()} />}
    {rows.status === "ready" && (rows.data ?? []).length === 0 && <EmptyState title={t("projectWorkspace.conversations.emptyTitle")} body={t("projectWorkspace.conversations.emptyBody")} />}
    {rows.status === "ready" && (rows.data ?? []).length > 0 && <ul className="pw-rows pw-cards" data-testid="project-conversation-list">
      {(rows.data ?? []).map((row) => {
        const title = row.locked ? t("projectWorkspace.conversations.locked") : row.title || mobileCopy[language].newChat;
        return <li key={row.id} className="pw-card" data-testid="project-conversation-row" data-conversation-id={row.id}>
          <div className="pw-grow">
            <p className="pw-strong">{title}</p>
            <p className="pw-muted">
              {tf("projectWorkspace.conversations.meta", { count: row.messageCount, date: formatProjectDate(row.updatedAt, language) })}
              {row.kind === "image" ? ` · ${t("projectWorkspace.conversations.image")}` : ""}
              {row.continuation ? ` · ${t("projectWorkspace.conversations.continuation")}` : ""}
            </p>
          </div>
          {projectChatOpenable(row) && !row.locked && <button type="button" className="soft" data-testid="project-conversation-open" onClick={() => onOpenConversation(row)}>{t("projectWorkspace.open")}</button>}
          {otherProjects.length > 0 && <>
            <label className="pw-sr" htmlFor={`project-move-${row.id}`}>{tf("projectWorkspace.conversations.moveLabel", { title })}</label>
            <select id={`project-move-${row.id}`} className="pw-select" value="" data-testid="project-conversation-move"
              onChange={(event) => { const value = event.currentTarget.value; if (value) setPending({ conversation: { id: row.id, title }, target: value, mode: "move" }); }}>
              <option value="">{t("projectWorkspace.conversations.moveTo")}</option>
              {otherProjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </>}
          <button type="button" className="pw-danger" data-testid="project-conversation-remove" onClick={() => setPending({ conversation: { id: row.id, title }, target: null, mode: "remove" })}>
            {t("projectWorkspace.conversations.remove")}
          </button>
        </li>;
      })}
    </ul>}
    <ConfirmDialog open={Boolean(pending)} copy={copy} testId="project-move-dialog" busy={busy} error={failure} destructive={pending?.mode === "remove"}
      title={t(pending?.mode === "remove" ? "projectWorkspace.conversations.removeTitle" : "projectWorkspace.conversations.moveTitle")}
      confirmLabel={t(pending?.mode === "remove" ? "projectWorkspace.conversations.remove" : "projectWorkspace.conversations.confirmMove")}
      cancelLabel={t("projectWorkspace.cancel")} onCancel={() => { setPending(null); setFailure(null); }} onConfirm={() => void confirm()}>
      {pending && <>
        <p className="pw-strong">{pending.conversation.title}</p>
        <p>{tf(pending.mode === "remove" ? "projectWorkspace.conversations.removeBody" : "projectWorkspace.conversations.moveBody", { project: targetProject(pending.target)?.name ?? project.name })}</p>
        {effect && <p data-testid="project-move-effect">{t(`projectWorkspace.conversations.effect.${effect}`)}</p>}
        <p className="pw-muted">{t("projectWorkspace.conversations.moveNotice")}</p>
      </>}
    </ConfirmDialog>
  </div>;
}

type SearchState = { status: "idle" } | { status: "loading" } | { status: "done"; query: string; hits: ProjectSearchHit[]; partial: boolean } | { status: "failed"; error: unknown };

function ProjectSearchPanel({ projectId, copy, onOpenHit }: { projectId: string; copy: ProjectCopy; onOpenHit: (hit: ProjectSearchHit) => void }) {
  const { t, tf } = copy;
  const client = desktopProjectClient();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const [previews, setPreviews] = useState<Record<string, string | "loading" | "failed" | "unavailable">>({});
  const ticket = useRef(0);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = query.trim();
    if (!text) return;
    const mine = ++ticket.current;
    setState({ status: "loading" });
    setPreviews({});
    try {
      const answer = await client.search(projectId, text);
      if (mine === ticket.current) setState({ status: "done", query: text, hits: answer.hits, partial: answer.status === "partial" });
    } catch (error) {
      if (mine === ticket.current) setState({ status: "failed", error });
    }
  }
  async function preview(hit: ProjectSearchHit) {
    if (previews[hit.ref] && previews[hit.ref] !== "failed") return;
    setPreviews((current) => ({ ...current, [hit.ref]: "loading" }));
    try {
      const read = await client.readSource(projectId, hit.ref);
      setPreviews((current) => ({ ...current, [hit.ref]: read.status === "ok" ? read.content.slice(0, 1_500) : "unavailable" }));
    } catch {
      setPreviews((current) => ({ ...current, [hit.ref]: "failed" }));
    }
  }
  return <section className="pw-card pw-stack" data-testid="project-search" aria-label={t("projectWorkspace.search.title")}>
    <h3>{t("projectWorkspace.search.title")}</h3>
    <form className="pw-inline" role="search" onSubmit={(event) => void submit(event)}>
      <label className="pw-sr" htmlFor={`project-search-${projectId}`}>{t("projectWorkspace.search.label")}</label>
      <input id={`project-search-${projectId}`} data-testid="project-search-input" className="history-search" value={query} maxLength={500}
        placeholder={t("projectWorkspace.search.placeholder")} onChange={(event) => setQuery(event.currentTarget.value)} />
      <button type="submit" className="primary" data-testid="project-search-submit" disabled={!query.trim() || state.status === "loading"}>
        {state.status === "loading" ? <Loader2 size={15} className="pw-spin" aria-hidden="true" /> : <Search size={15} aria-hidden="true" />} {t("projectWorkspace.search.submit")}
      </button>
    </form>
    {state.status === "failed" && <ErrorLine error={state.error} copy={copy} onRetry={() => void submit()} testId="project-search-error" />}
    {state.status === "done" && <div className="pw-stack" data-testid="project-search-results">
      {state.partial && <p role="status" data-testid="project-search-partial" className="pw-banner pw-banner-warn">{t("projectWorkspace.search.partial")}</p>}
      {state.hits.length === 0
        ? <p className="pw-muted" data-testid="project-search-empty">{state.partial ? t("projectWorkspace.search.emptyPartial") : tf("projectWorkspace.search.empty", { query: state.query })}</p>
        : <ul className="pw-rows pw-cards">{state.hits.map((hit) => {
          const read = previews[hit.ref];
          return <li key={hit.ref} className="pw-card pw-stack" data-testid="project-search-hit" data-ref={hit.ref}>
            <div className="pw-inline"><span className="pw-grow pw-strong">{hit.title}</span><span className="pw-chip">{t(`projectWorkspace.search.kind.${hit.location.kind}`)}</span></div>
            <p>{hit.snippet}</p>
            <div className="pw-actions">
              <button type="button" className="soft" data-testid="project-search-open" onClick={() => onOpenHit(hit)}>{t("projectWorkspace.search.open")}</button>
              <button type="button" className="soft" data-testid="project-search-preview" onClick={() => void preview(hit)}>{t("projectWorkspace.search.preview")}</button>
            </div>
            {read === "loading" && <p className="pw-muted" role="status">{t("projectWorkspace.loading")}</p>}
            {read === "failed" && <p className="pw-error" role="alert">{t("projectWorkspace.errors.generic")}</p>}
            {read === "unavailable" && <p className="pw-muted" role="status" data-testid="project-source-unavailable">{t("projectWorkspace.search.unavailable")}</p>}
            {read && read !== "loading" && read !== "failed" && read !== "unavailable" && <pre className="pw-preview" data-testid="project-source-preview">{read}</pre>}
          </li>;
        })}</ul>}
    </div>}
  </section>;
}

function ProjectCreate({ copy, onRoute, onChanged }: { copy: ProjectCopy; onRoute: (route: ProjectWorkspaceRoute | null) => void; onChanged: () => void }) {
  const { t } = copy;
  const client = desktopProjectClient();
  const [form, setForm] = useState<ProjectCreateForm>(DEFAULT_PROJECT_CREATE_FORM);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const set = <K extends keyof ProjectCreateForm>(key: K, value: ProjectCreateForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !projectNameValid(form.name)) return;
    setBusy(true); setFailure(null);
    try {
      const project = await client.create(buildProjectCreateInput(form));
      onChanged();
      onRoute({ kind: "project", projectId: project.id, tab: "overview" });
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  return <div className="desktop-chat-workspace pw-pane" data-testid="project-create"><div className="scroll"><div className="content pw-content">
    <header className="pw-header">
      <button type="button" className="soft" onClick={() => onRoute(null)}><ArrowLeft size={15} aria-hidden="true" /> {t("projectWorkspace.back")}</button>
      <div className="pw-title"><h1>{t("projectWorkspace.create.title")}</h1></div>
    </header>
    <p className="pw-text">{t("projectWorkspace.create.intro")}</p>
    <form className="pw-card pw-stack" onSubmit={(event) => void submit(event)}>
      <label className="pw-label" htmlFor="project-create-name">{t("projectWorkspace.settings.name")}</label>
      <input id="project-create-name" className="history-search" autoFocus value={form.name} maxLength={PROJECT_UI_LIMITS.maxNameLength} onChange={(event) => set("name", event.currentTarget.value)} />
      <label className="pw-label" htmlFor="project-create-description">{t("projectWorkspace.settings.description")}</label>
      <textarea id="project-create-description" className="pw-textarea" rows={3} maxLength={PROJECT_UI_LIMITS.maxDescriptionLength} value={form.description} onChange={(event) => set("description", event.currentTarget.value)} />
      <label className="pw-label" htmlFor="project-create-instructions">{t("projectWorkspace.settings.instructions")}</label>
      <textarea id="project-create-instructions" className="pw-textarea" rows={4} maxLength={PROJECT_UI_LIMITS.maxInstructionsLength} value={form.instructions} onChange={(event) => set("instructions", event.currentTarget.value)} />
      <p className="pw-muted">{t("projectWorkspace.settings.instructionsHint")}</p>
      <label className="pw-check"><input type="checkbox" checked={form.contextEnabled} onChange={(event) => set("contextEnabled", event.currentTarget.checked)} />
        <span><strong>{t("projectWorkspace.settings.contextEnabled")}</strong><small>{t(form.contextEnabled ? "projectWorkspace.create.contextOnHint" : "projectWorkspace.create.contextOffHint")}</small></span></label>
      {form.contextEnabled && <>
        <label className="pw-check"><input type="checkbox" checked={form.includePersonalMemory} onChange={(event) => set("includePersonalMemory", event.currentTarget.checked)} />
          <span><strong>{t("projectWorkspace.settings.personalMemory")}</strong><small>{t("projectWorkspace.settings.personalMemoryHint")}</small></span></label>
        <label className="pw-check"><input type="checkbox" checked={form.autoMemoryEnabled} onChange={(event) => set("autoMemoryEnabled", event.currentTarget.checked)} />
          <span><strong>{t("projectWorkspace.settings.autoMemory")}</strong><small>{t("projectWorkspace.settings.autoMemoryHint")}</small></span></label>
      </>}
      {failure ? <ErrorLine error={failure} copy={copy} /> : null}
      <div className="pw-actions">
        <button type="submit" className="primary" data-testid="project-create-submit" disabled={busy || !projectNameValid(form.name)}>
          {busy ? <Loader2 size={15} className="pw-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />} {t("projectWorkspace.create.submit")}
        </button>
        <button type="button" className="soft" disabled={busy} onClick={() => onRoute(null)}>{t("projectWorkspace.cancel")}</button>
      </div>
    </form>
  </div></div></div>;
}

/** What a chat inside a project answers with, shown above its composer. Renders nothing until the project is read. */
export function ProjectComposerBar({ projectId, language, onOpen }: { projectId: string; language: Language; onOpen: () => void }) {
  const copy = useProjectCopy(language);
  const client = desktopProjectClient();
  const resource = useProjectResource<ProjectSummary>(() => client.detail(projectId), `composer-project:${projectId}`);
  const project = resource.data;
  if (!project) return null;
  return <div className="pw-composer-bar" data-testid="project-composer-bar" data-project-id={projectId}>
    <strong className="pw-grow pw-strong">{project.name}</strong>
    <span className={project.archivedAt ? "pw-chip pw-chip-warn" : project.contextEnabled ? "pw-chip pw-chip-good" : "pw-chip"}>{copy.t(projectStatusLabelKey(project))}</span>
    <button type="button" className="soft" data-testid="project-composer-open" onClick={onOpen}>{copy.t("projectWorkspace.composer.open")}</button>
  </div>;
}
