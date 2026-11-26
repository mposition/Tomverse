import { useEffect, useState, type KeyboardEvent } from "react";
import type { Language } from "../../../../lib/language";
import { desktopCodeExtensionsCopy } from "../../../../locales/desktopCodeExtensions";
import type { CodeExtensionsImportItem, CodeExtensionsView } from "../contract";
import "./code-extensions.css";

type SlashItem = CodeExtensionsView["slash"][number];

/**
 * The composer's `/` list: the skills and commands of the project and the user's own folders (and `builtins`, for a host that has
 * commands of its own). It only fills the draft; the host expands `/name arguments` when the task starts.
 */
export function useSlashMenu({ draft, setDraft, focus, builtins = [] }: {
  draft: string; setDraft: (value: string) => void; focus: () => void; builtins?: SlashItem[];
}) {
  const [entries, setEntries] = useState<SlashItem[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const typing = /^\/[^\s]*$/.test(draft);
  useEffect(() => {
    if (!typing) return;
    let current = true;
    window.desktop.codeExtensions({ action: "list" }).then((view) => { if (current) setEntries(view.slash); }, () => { if (current) setEntries([]); });
    return () => { current = false; };
  }, [typing]);
  const wanted = draft.slice(1).toLowerCase();
  // Names that start with what was typed come first.
  const items = typing ? [...builtins, ...entries].filter((item) => item.name.toLowerCase().includes(wanted))
    .sort((left, right) => Number(!left.name.toLowerCase().startsWith(wanted)) - Number(!right.name.toLowerCase().startsWith(wanted))).slice(0, 8) : [];
  const visible = items.length > 0 && dismissed !== draft;
  const index = Math.min(active, Math.max(0, items.length - 1));
  function pick(item: SlashItem) {
    setDraft(`/${item.name} `);
    setActive(0);
    focus();
  }
  /** True when the key was used by the list. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!visible || event.nativeEvent.isComposing) return false;
    const chosen = items[index]!;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && draft.slice(1).toLowerCase() !== chosen.name.toLowerCase())) {
      event.preventDefault();
      pick(chosen);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(draft);
      return true;
    }
    return false;
  }
  return { items, index, visible, pick, onKeyDown };
}

export function SlashMenu({ menu, language }: { menu: ReturnType<typeof useSlashMenu>; language: Language }) {
  const copy = desktopCodeExtensionsCopy[language];
  if (!menu.visible) return null;
  return <ul className="slash-menu" role="listbox" aria-label={copy.slashList} data-testid="slash-menu">
    {menu.items.map((item, position) => <li key={`${item.kind}:${item.name}`} role="option" aria-selected={position === menu.index}>
      <button type="button" className={position === menu.index ? "active" : undefined} onMouseDown={(event) => event.preventDefault()}
        onClick={() => menu.pick(item)}>
        <span className="slash-name">/{item.name}{item.argumentHint ? ` ${item.argumentHint}` : ""}</span>
        <span className="slash-kind">{item.kind === "skill" ? copy.slashSkill : copy.slashCommand}</span>
        <small>{item.description}</small>
      </button>
    </li>)}
  </ul>;
}

const statusLabel = (copy: (typeof desktopCodeExtensionsCopy)[Language], status: CodeExtensionsImportItem["status"]) => ({
  "in-use": copy.statusInUse, importable: copy.statusImportable, imported: copy.statusImported, conflict: copy.statusConflict, unsupported: copy.statusUnsupported,
})[status];

const kindOrder = ["instructions", "skill", "command", "agent", "mcp"] as const;

function ImportPanel({ language, onDone }: { language: Language; onDone: () => void }) {
  const copy = desktopCodeExtensionsCopy[language];
  const [items, setItems] = useState<CodeExtensionsImportItem[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [working, setWorking] = useState(false);
  async function preview() {
    setWorking(true);
    try {
      setItems((await window.desktop.codeExtensions({ action: "import-preview" })).importItems ?? []);
      setSelected([]);
      setMessage(null);
    } catch { setMessage({ text: copy.importFailed, failed: true }); }
    setWorking(false);
  }
  async function apply() {
    if (!selected.length) return;
    setWorking(true);
    try {
      const view = await window.desktop.codeExtensions({ action: "import-apply", ids: selected });
      setItems(view.importItems ?? []);
      setSelected([]);
      setMessage({ text: copy.importDone.replace("{count}", String(view.imported?.written.length ?? 0)), failed: false });
      onDone();
    } catch { setMessage({ text: copy.importFailed, failed: true }); }
    setWorking(false);
  }
  const labels = { instructions: copy.kindInstructions, skill: copy.kindSkill, command: copy.kindCommand, agent: copy.kindAgent, mcp: copy.kindMcp } as const;
  return <div className="code-extensions-import">
    <div className="code-extensions-head">
      <div><strong>{copy.importHeading}</strong><small>{copy.importDetail}</small></div>
      <button className="soft" type="button" disabled={working} onClick={() => void preview()} data-testid="import-preview">{copy.importPreview}</button>
    </div>
    {items && <>
      {kindOrder.map((kind) => {
        const rows = items.filter((item) => item.kind === kind);
        if (!rows.length) return null;
        return <section key={kind}>
          <h4>{labels[kind]}</h4>
          <ul>{rows.map((item) => <li key={item.id}>
            <div>
              {item.status === "importable"
                ? <label><input type="checkbox" checked={selected.includes(item.id)} aria-label={copy.selectServer.replace("{name}", item.name)}
                    data-testid={`import-select-${item.name}`}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setSelected((current) => on ? [...current, item.id] : current.filter((id) => id !== item.id));
                    }} /> <strong>{item.name}</strong></label>
                : <strong>{item.name}</strong>}
              <span className="code-extensions-status" data-status={item.status}>{statusLabel(copy, item.status)}</span>
            </div>
            <small>{item.source}</small>
            {item.mcp && <code>{item.mcp.summary}</code>}
            {!!item.mcp?.values.length && <small>{item.mcp.values.map(({ key, value }) => `${key}=${value}`).join("  ")}</small>}
            {item.detail && <small>{item.detail}</small>}
          </li>)}</ul>
        </section>;
      })}
      {items.some((item) => item.mcp) && <small>{copy.importHideValues}</small>}
      <button className="soft" type="button" disabled={working || !selected.length} onClick={() => void apply()} data-testid="import-apply">
        {copy.importSelected.replace("{count}", String(selected.length))}</button>
    </>}
    {message && <p role={message.failed ? "alert" : "status"}>{message.text}</p>}
  </div>;
}

/** Settings: what was read (with where it came from) and the import from Claude Code / Codex. */
export function CodeExtensionsSettings({ language }: { language: Language }) {
  const copy = desktopCodeExtensionsCopy[language];
  const [view, setView] = useState<CodeExtensionsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  async function load() {
    try { setView(await window.desktop.codeExtensions({ action: "list" })); setFailed(false); }
    catch { setFailed(true); }
  }
  useEffect(() => {
    let current = true;
    window.desktop.codeExtensions({ action: "list" }).then((loaded) => { if (current) setView(loaded); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, []);
  const rows = (title: string, entries: Array<{ name: string; description: string; source: string; ignored: string[]; note?: string }>) => <section>
    <h4>{title}</h4>
    {entries.length ? <ul>{entries.map((entry) => <li key={`${entry.source}:${entry.name}`}>
      <strong>{entry.name}</strong> <small>{entry.description}</small>
      <small>{entry.source}</small>
      {entry.note && <small>{entry.note}</small>}
      {!!entry.ignored.length && <small>{copy.notApplied.replace("{fields}", entry.ignored.join(", "))}</small>}
    </li>)}</ul> : <p>{copy.none}</p>}
  </section>;
  return <div className="code-extensions" data-testid="code-extensions">
    <div className="code-extensions-head">
      <div><strong>{copy.heading}</strong><small>{view?.project === false ? copy.noProject : copy.detail}</small></div>
      <button className="soft" type="button" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load(); }}>{open ? "−" : "+"}</button>
    </div>
    {open && view?.project && <>
      {rows(copy.skills, view.skills.map((skill) => ({ ...skill, note: skill.implicit ? undefined : copy.userOnly })))}
      {rows(copy.commands, view.commands.map((command) => ({ ...command, name: `/${command.name}` })))}
      {rows(copy.agents, view.agents.map((agent) => ({ ...agent, note: agent.model ? copy.agentModel.replace("{model}", agent.model) : undefined })))}
      {!!view.issues.length && <section><h4>{copy.notes}</h4><ul>{view.issues.map((issue) => <li key={issue}><small>{issue}</small></li>)}</ul></section>}
      <button className="soft" type="button" onClick={() => void load()}>{copy.refresh}</button>
    </>}
    {view?.project && <ImportPanel language={language} onDone={() => void load()} />}
    {failed && <p role="alert">{copy.importFailed}</p>}
  </div>;
}
