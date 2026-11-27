import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, Cloud, Folder, GitBranch, Plus, Search, Server, Settings, Star, Terminal, Check } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopCodeProjectsCopy, type DesktopCodeProjectsCopy } from "../../../../locales/desktopCodeProjects";
import { desktopRemoteCopy } from "../../../../locales/desktopRemoteProject";
import {
  buildEnvironmentGroups, pickerOrder,
  type CodeProject, type CodeProjectInput, type CodeProjectLocation, type CodeProjectReply, type CodeProjectsView, type CodeWslState,
  type EnvironmentDisabledReason, type EnvironmentRow,
} from "../code-project-contract";
import type { RemoteRecent } from "../remote-contract";
import type { CodeGitWorkspace, CodeWorktreeChoice } from "../contract";
import { RemoteProjectPanel } from "./RemoteProject";
import "./code-projects.css";

type Copy = DesktopCodeProjectsCopy;

const reasonText = (copy: Copy, reason: EnvironmentDisabledReason) => ({
  "cloud-not-offered": copy.reasonCloudNotOffered, "cloud-no-project": copy.reasonCloudNoProject, "cloud-remote-project": copy.reasonCloudRemote,
  "cloud-not-git": copy.reasonCloudNotGit, "wsl-not-windows": copy.reasonWslNoSupport, "wsl-unavailable": copy.reasonWslUnavailable,
  "wsl-no-support": copy.reasonWslNoSupport, "ssh-off": copy.reasonSshOff,
} as const)[reason];

const failureText = (copy: Copy, reply: CodeProjectReply) => !reply.result.ok ? copy.failure[reply.result.failure] : "";

/** Closes a popover on a press outside it or on Escape, and hands the focus back to the button that opened it. */
export function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return undefined;
    const press = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      event.preventDefault();
      close();
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", press);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", press); document.removeEventListener("keydown", key); };
  }, [open, close, root, trigger]);
}

function moveFocus(event: ReactKeyboardEvent<HTMLElement>, selector: string) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)].filter((item) => !item.hasAttribute("disabled"));
  if (!items.length) return false;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
  event.preventDefault();
  items[next]!.focus();
  return true;
}

/** The two ways to make a project, and the small form a new folder needs. Used in the Create project menu and in the picker's "New environment". */
export function CreateProjectPanel({ language, disabled, run, onDone, onMessage }: {
  language: Language; disabled: boolean;
  run: (input: CodeProjectInput) => Promise<CodeProjectReply>;
  onDone: (changed: boolean) => void; onMessage: (text: string) => void;
}) {
  const copy = desktopCodeProjectsCopy[language];
  const [form, setForm] = useState(false);
  const [name, setName] = useState("");
  const [initGit, setInitGit] = useState(true);
  const [working, setWorking] = useState(false);

  async function go(input: CodeProjectInput) {
    setWorking(true);
    onMessage("");
    try {
      const reply = await run(input);
      if (reply.result.ok) {
        if (reply.result.gitInit === "failed") onMessage(copy.gitInitFailed);
        onDone(reply.result.changed !== false);
      } else onMessage(failureText(copy, reply));
    } catch {
      onMessage(copy.failure.failed);
    } finally { setWorking(false); }
  }

  if (form) {
    const submit = () => { if (name.trim() && !disabled && !working) void go({ action: "create-new", name: name.trim(), initGit }); };
    // Not a <form>: the picker sits inside the composer's form, and a nested submit would send the request.
    return <div className="project-new-form" role="group" aria-label={copy.newFolderTitle} data-testid="project-new-form" onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setForm(false); }
      else if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "text") { event.preventDefault(); submit(); }
    }}>
      <strong>{copy.newFolderTitle}</strong>
      <label>{copy.projectName}
        <input data-testid="project-new-name" autoFocus value={name} maxLength={80} spellCheck={false} autoComplete="off"
          onChange={(event) => setName(event.currentTarget.value)} aria-describedby="project-new-hint" />
      </label>
      <small id="project-new-hint">{copy.projectNameHint} {copy.parentHint}</small>
      <label className="project-check"><input type="checkbox" data-testid="project-new-git" checked={initGit} onChange={(event) => setInitGit(event.currentTarget.checked)} /> {copy.initGit}</label>
      <div className="project-actions">
        <button className="soft" type="button" onClick={() => setForm(false)}>{copy.cancel}</button>
        <button className="primary" type="button" data-testid="project-new-submit" disabled={disabled || working || !name.trim()} onClick={submit}>{copy.chooseParent}</button>
      </div>
    </div>;
  }
  return <div className="project-menu-items" role="menu" aria-label={copy.createProject} onKeyDown={(event) => moveFocus(event, "[role=menuitem]")}>
    <button type="button" role="menuitem" data-testid="project-new-folder" disabled={disabled || working} onClick={() => setForm(true)}><Plus size={15} /> {copy.newFolder}</button>
    <button type="button" role="menuitem" data-testid="project-existing-folder" disabled={disabled || working} onClick={() => void go({ action: "add-existing" })}><Folder size={15} /> {copy.existingFolder}</button>
  </div>;
}

const runProjects = (input: CodeProjectInput) => window.desktop.codeProjects(input);

/** "Create project ▾": on the Code start screen and at the bottom of the history column. */
export function CreateProjectMenu({ language, disabled, variant, onOpened }: {
  language: Language; disabled: boolean; variant: "welcome" | "sidebar"; onOpened: (changed: boolean) => void;
}) {
  const copy = desktopCodeProjectsCopy[language];
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), root, trigger);
  return <div className={`project-create project-create--${variant}`} ref={root}>
    <button ref={trigger} type="button" className={variant === "sidebar" ? "soft open-folder" : "soft"} data-testid={`create-project-${variant}`} disabled={disabled}
      aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open); setMessage(""); }}>
      {variant === "welcome" && <Folder size={19} />} {copy.createProject} {variant === "welcome" && <ChevronDown size={14} />}
    </button>
    {open && <div className="project-popover" data-testid="create-project-popover">
      <CreateProjectPanel language={language} disabled={disabled} run={runProjects} onMessage={setMessage}
        onDone={(changed) => { setOpen(false); onOpened(changed); trigger.current?.focus(); }} />
    </div>}
    {message && <p role="alert" className="project-message" data-testid="project-message">{message}</p>}
  </div>;
}

function ProjectSettings({ project, language, cloudOffered, onBack, onChanged, setMessage }: {
  project: CodeProject; language: Language; cloudOffered: boolean; onBack: () => void; onChanged: () => void; setMessage: (text: string) => void;
}) {
  const copy = desktopCodeProjectsCopy[language];
  const [name, setName] = useState(project.name);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  async function call(input: CodeProjectInput) {
    setWorking(true);
    setMessage("");
    try {
      const reply = await runProjects(input);
      if (!reply.result.ok && reply.result.failure !== "cancelled") setMessage(failureText(copy, reply));
      return reply.result.ok;
    } catch { setMessage(copy.failure.failed); return false; } finally { setWorking(false); }
  }
  const save = async () => { const next = name.trim(); if (next && next !== project.name) await call({ action: "rename", id: project.id, name: next }); };
  return <div className="project-settings" role="group" aria-label={copy.settingsFor.replace("{name}", () => project.name)} data-testid="project-settings"
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onBack(); }
      else if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); void save().then(onBack); }
    }}>
    <strong>{copy.settingsTitle}</strong>
    <label>{copy.settingsName}
      <input data-testid="project-settings-name" autoFocus value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} onBlur={() => void save()} />
    </label>
    <div className="project-folder-row">
      <span>{copy.settingsFolder}</span><code title={project.folder}>{project.folder}</code>
      <button className="soft" type="button" disabled={working} onClick={() => void call({ action: "relocate", id: project.id }).then(onChanged)}>{copy.settingsChangeFolder}</button>
    </div>
    <label>{copy.settingsLocation}
      <select data-testid="project-settings-location" value={project.defaultLocation} disabled={working}
        onChange={(event) => void call({ action: "set-location", id: project.id, location: event.currentTarget.value as CodeProjectLocation })}>
        <option value="local">{copy.locationLocal}</option>
        <option value="cloud" disabled={!cloudOffered}>{copy.locationCloud}</option>
        <option value="ssh" disabled>{copy.locationSsh}</option>
      </select>
    </label>
    {confirming
      ? <div className="project-confirm" role="alertdialog" aria-label={copy.remove} data-testid="project-remove-confirm">
        <p>{copy.removeConfirm.replace("{name}", () => project.name)}</p>
        <div className="project-actions">
          <button className="soft" type="button" onClick={() => setConfirming(false)}>{copy.cancel}</button>
          <button className="soft danger" type="button" data-testid="project-remove-accept" disabled={working}
            onClick={() => void call({ action: "remove", id: project.id }).then((ok) => { if (ok) { onChanged(); onBack(); } })}>{copy.removeAccept}</button>
        </div>
      </div>
      : <div className="project-actions">
        <button className="soft danger" type="button" data-testid="project-remove" onClick={() => setConfirming(true)}>{copy.remove}</button>
        <button className="primary" type="button" data-testid="project-settings-done" onClick={() => void save().then(onBack)}>{copy.settingsDone}</button>
      </div>}
  </div>;
}

type PickerProps = {
  language: Language;
  view: CodeProjectsView | undefined;
  /** The open project's name, as the window shows it (a folder name, or a remote target). */
  label: string | null;
  disabled: boolean;
  /** A conversation is open: choosing another project starts a new one. */
  hasTask: boolean;
  cloudOffered: boolean;
  /** Whether the open project is a Git repository with a commit (null: no folder project is open). */
  openIsGit: boolean | null;
  remoteOpen: boolean;
  remoteEnabled: boolean;
  onOpened: (changed: boolean) => void;
  onOpenCloud: () => void;
};

/** The "<project> ▾" button under the composer and its environment list: Local projects, Cloud, WSL and SSH. */
export function CodeProjectPicker(props: PickerProps) {
  const { language, view, label, disabled, hasTask, cloudOffered, openIsGit, remoteOpen, remoteEnabled, onOpened, onOpenCloud } = props;
  const copy = desktopCodeProjectsCopy[language];
  const remoteCopy = desktopRemoteCopy[language];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [newEnvironment, setNewEnvironment] = useState<"closed" | "project" | "ssh">("closed");
  const [wsl, setWsl] = useState<CodeWslState | null>(null);
  const [recent, setRecent] = useState<RemoteRecent[]>([]);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const close = () => { setOpen(false); setSettingsId(null); setNewEnvironment("closed"); setQuery(""); };
  useDismiss(open, close, root, trigger);

  // The WSL list and the SSH targets are read when the list opens, not on every window update.
  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    void window.desktop.codeProjects({ action: "wsl" }).then((reply) => { if (current && reply.wsl) setWsl(reply.wsl); }, () => { if (current) setWsl({ state: "unavailable" }); });
    if (remoteEnabled) void window.desktop.remoteProject({ action: "read" }).then((reply) => { if (current) setRecent(reply.view.recent); }, () => {});
    return () => { current = false; };
  }, [open, remoteEnabled]);

  const projects = useMemo(() => view?.items ?? [], [view]);
  const groups = useMemo(() => buildEnvironmentGroups({
    platform: view?.platform ?? "", projects, selectedId: view?.selectedId ?? null, query, cloudOffered, selectedIsGit: openIsGit, remoteOpen, wsl,
    remoteEnabled, remoteRecent: recent,
    names: { cloudAuto: copy.cloudAuto, cloudDefault: copy.cloudDefault, local: copy.groupLocal, cloud: copy.groupCloud, wsl: copy.groupWsl, ssh: copy.groupSsh },
  }), [view, projects, query, cloudOffered, openIsGit, remoteOpen, wsl, remoteEnabled, recent, copy]);
  const order = pickerOrder(groups);
  const activeRow = order[Math.min(active, order.length - 1)];
  const rowId = (row: EnvironmentRow) => `${listId}-${row.kind}-${row.id}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const settingsProject = settingsId ? projects.find((project) => project.id === settingsId) : undefined;

  async function choose(row: EnvironmentRow) {
    setMessage("");
    if (row.kind === "cloud") { if (!row.disabled) { close(); onOpenCloud(); } return; }
    if (row.kind === "wsl") return;
    setWorking(true);
    try {
      if (row.kind === "project") {
        const reply = await runProjects({ action: "select", id: row.id });
        if (reply.result.ok) { close(); onOpened(reply.result.changed !== false); trigger.current?.focus(); } else setMessage(failureText(copy, reply));
      } else {
        const reply = await window.desktop.remoteProject({ action: "open", target: { destination: row.destination, ...(row.port !== undefined ? { port: row.port } : {}), folder: row.folder } });
        if (reply.result?.ok) { close(); onOpened(true); trigger.current?.focus(); } else setMessage(reply.result ? remoteCopy.failures[reply.result.failure] : copy.failure.failed);
      }
    } catch { setMessage(copy.failure.failed); } finally { setWorking(false); }
  }

  async function favorite(project: CodeProject) {
    try { await runProjects({ action: "favorite", id: project.id, favorite: !project.favorite }); } catch { setMessage(copy.failure.failed); }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || settingsProject || newEnvironment !== "closed") return;
    const target = event.target as HTMLElement;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!order.length) return;
      event.preventDefault();
      setActive((at) => (event.key === "ArrowDown" ? (at + 1) % order.length : (at <= 0 ? order.length - 1 : at - 1)));
      search.current?.focus();
    } else if (event.key === "Enter" && target === search.current && activeRow) {
      event.preventDefault();
      void choose(activeRow);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && target !== search.current && !(target instanceof HTMLInputElement)) {
      // Typing anywhere in the list goes to the search box.
      search.current?.focus();
    }
  }

  const isSelected = (row: EnvironmentRow) => row.kind === "project" && row.selected;
  const rowButton = (row: EnvironmentRow, content: ReactNode, extra?: { disabled?: EnvironmentDisabledReason }) => {
    const off = extra?.disabled;
    return <button type="button" id={rowId(row)} role="option" aria-selected={isSelected(row)} aria-disabled={off ? true : undefined} tabIndex={-1}
      className="project-row-main" data-testid={`environment-${row.kind}-${row.id}`} data-active={activeRow && rowId(activeRow) === rowId(row) ? "true" : undefined}
      disabled={working} onMouseEnter={() => { const at = order.findIndex((item) => rowId(item) === rowId(row)); if (at >= 0) setActive(at); }}
      onClick={() => void choose(row)}>{content}</button>;
  };

  return <div className="project-picker-composer" ref={root}>
    <button ref={trigger} type="button" className="project-picker-button" data-testid="code-project-picker" disabled={disabled}
      aria-haspopup="dialog" aria-expanded={open} aria-label={copy.environmentLabel + (label ? ": " + label : "")}
      title={label ?? undefined} onClick={() => { if (open) close(); else { setOpen(true); setActive(0); setMessage(""); } }}>
      <Folder size={15} aria-hidden="true" /><span className="project-picker-label">{label ?? copy.chooseProject}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="project-popover project-picker-popover" role="dialog" aria-label={copy.environmentLabel} data-testid="code-project-popover" onKeyDown={onKeyDown}
      onSubmit={(event) => event.stopPropagation() /* the SSH form inside must not submit the composer around it */}>
      {settingsProject
        ? <ProjectSettings project={settingsProject} language={language} cloudOffered={cloudOffered} setMessage={setMessage}
          onBack={() => { setSettingsId(null); search.current?.focus(); }} onChanged={() => undefined} />
        : <>
          <label className="project-search"><Search size={14} aria-hidden="true" />
            <input ref={search} autoFocus role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeRow ? rowId(activeRow) : undefined}
              aria-label={copy.searchPlaceholder} placeholder={copy.searchPlaceholder} data-testid="project-search" value={query}
              onChange={(event) => { setQuery(event.currentTarget.value); setActive(0); }} />
          </label>
          {hasTask && <p className="project-note" role="note">{copy.newConversationNote}</p>}
          <div id={listId} role="listbox" aria-label={copy.environmentLabel} className="project-list">
            <section aria-label={copy.groupLocal}>
              <h4>{copy.groupLocal}</h4>
              {groups.local.length === 0 && <p className="project-empty">{query ? copy.noMatches : copy.noLocalProjects}</p>}
              {groups.local.map((row) => <div key={row.id} className="project-row" role="presentation">
                {rowButton(row, <><Folder size={15} aria-hidden="true" /><span className="project-row-name"><strong>{row.project.name}</strong><small title={row.project.folder}>{row.project.folder}</small></span>
                  {row.selected && <Check size={15} aria-label={copy.current} />}</>)}
                <button type="button" className="icon project-star" data-testid={`project-favorite-${row.id}`} aria-pressed={row.project.favorite}
                  aria-label={(row.project.favorite ? copy.unfavorite : copy.favorite).replace("{name}", () => row.project.name)}
                  onClick={() => void favorite(row.project)}><Star size={14} fill={row.project.favorite ? "currentColor" : "none"} /></button>
                <button type="button" className="icon" data-testid={`project-settings-${row.id}`} aria-label={copy.settingsFor.replace("{name}", () => row.project.name)}
                  onClick={() => setSettingsId(row.id)}><Settings size={14} /></button>
              </div>)}
            </section>
            {groups.cloud.length > 0 && <section aria-label={copy.groupCloud}>
              <h4>{copy.groupCloud}</h4>
              {groups.cloud.map((row) => <div key={row.id} className="project-row" role="presentation">
                {rowButton(row, <><Cloud size={15} aria-hidden="true" /><span className="project-row-name"><strong>{row.id === "auto" ? copy.cloudAuto : copy.cloudDefault}</strong>
                  <small>{row.disabled ? reasonText(copy, row.disabled) : row.id === "auto" ? copy.cloudAutoDetail : copy.cloudDefaultDetail}</small></span></>, { disabled: row.disabled })}
              </div>)}
              {groups.cloud.some((row) => !row.disabled) && <p className="project-note">{copy.cloudOpens}</p>}
            </section>}
            {groups.wsl && <section aria-label={copy.groupWsl}>
              <h4>{copy.groupWsl}</h4>
              {wsl === null && <p className="project-empty">{copy.loadingWsl}</p>}
              {wsl !== null && groups.wsl.rows.length === 0 && <p className="project-empty" data-testid="wsl-empty">{wsl.state === "unavailable" ? copy.reasonWslUnavailable : copy.noWsl}</p>}
              {groups.wsl.rows.map((row) => <div key={row.id} className="project-row" role="presentation">
                {rowButton(row, <><Terminal size={15} aria-hidden="true" /><span className="project-row-name"><strong>{row.id}</strong><small>{reasonText(copy, row.disabled)}</small></span></>, { disabled: row.disabled })}
              </div>)}
            </section>}
            {remoteEnabled && <section aria-label={copy.groupSsh}>
              <h4>{copy.groupSsh}</h4>
              {groups.ssh.length === 0 && <p className="project-empty">{query ? copy.noMatches : copy.noSsh}</p>}
              {groups.ssh.map((row) => <div key={row.id} className="project-row" role="presentation">
                {rowButton(row, <><Server size={15} aria-hidden="true" /><span className="project-row-name"><strong>{row.label}{row.port !== undefined ? `:${row.port}` : ""}</strong><small>{row.folder}</small></span></>)}
              </div>)}
            </section>}
          </div>
          <div className="project-new-environment">
            <button type="button" data-testid="project-new-environment" aria-expanded={newEnvironment !== "closed"}
              onClick={() => setNewEnvironment(newEnvironment === "closed" ? "project" : "closed")}><Plus size={14} /> {copy.newEnvironment}</button>
            {newEnvironment !== "closed" && <div className="project-new-environment-body">
              <div className="project-actions">
                <button className={newEnvironment === "project" ? "primary" : "soft"} type="button" onClick={() => setNewEnvironment("project")}>{copy.newProject}</button>
                <button className={newEnvironment === "ssh" ? "primary" : "soft"} type="button" data-testid="project-add-ssh" onClick={() => setNewEnvironment("ssh")}>{copy.addSsh}</button>
              </div>
              {newEnvironment === "project" && <CreateProjectPanel language={language} disabled={disabled} run={runProjects} onMessage={setMessage}
                onDone={(changed) => { close(); onOpened(changed); trigger.current?.focus(); }} />}
              {newEnvironment === "ssh" && <RemoteProjectPanel language={language} onChanged={() => { close(); onOpened(true); }} />}
            </div>}
          </div>
        </>}
      {message && <p role="alert" className="project-message" data-testid="project-picker-message">{message}</p>}
    </div>}
  </div>;
}

/** The Worktree box next to the picker: on, the next task runs in a separate Git worktree of the project. */
export function WorktreeToggle({ language, git, choice, select, disabled, reason, onRemember }: {
  language: Language;
  git: CodeGitWorkspace | undefined;
  choice: CodeWorktreeChoice | undefined;
  select: (choice: CodeWorktreeChoice) => void;
  disabled: boolean;
  /** Why the box is off although the project could use it (Read only, a provider CLI), or null. */
  reason: "readOnly" | "apiOnly" | null;
  onRemember: (on: boolean) => void;
}) {
  const copy = desktopCodeProjectsCopy[language];
  const usable = git?.kind === "git";
  const checked = usable && choice?.kind === "worktree";
  const why = reason === "readOnly" ? copy.worktreeReadOnly : reason === "apiOnly" ? copy.worktreeApiOnly : !usable ? copy.worktreeNotGit : copy.worktreeOn;
  const base = choice?.kind === "worktree" ? choice.base : undefined;
  return <span className="worktree-toggle" data-testid="worktree-toggle" data-worktree-path={git?.kind === "git" ? git.path : undefined}>
    <label title={why}>
      <input type="checkbox" data-testid="worktree-checkbox" checked={checked} disabled={disabled || !usable || reason !== null} aria-describedby="worktree-why"
        onChange={(event) => {
          const on = event.currentTarget.checked;
          if (git?.kind === "git") select(on ? { kind: "worktree", id: git.id, base: git.bases[0]! } : { kind: "local" });
          onRemember(on);
        }} />
      <GitBranch size={14} aria-hidden="true" /> <span className="worktree-label">{copy.worktree}</span>
    </label>
    <span id="worktree-why" className="visually-hidden">{why}</span>
    {checked && git?.kind === "git" && base && git.bases.length > 1 && <select aria-label={copy.worktreeBranch} value={base.ref} disabled={disabled}
      onChange={(event) => { const next = git.bases.find((item) => item.ref === event.currentTarget.value); if (next) select({ kind: "worktree", id: git.id, base: next }); }}>
      {git.bases.map((item) => <option key={item.ref} value={item.ref}>{item.ref.replace(/^refs\/heads\//, "")} · {item.commit.slice(0, 8)}</option>)}
    </select>}
  </span>;
}
