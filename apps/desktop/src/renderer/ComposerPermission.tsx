import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, ShieldAlert, ShieldCheck } from "lucide-react";
import type { Language } from "../../../../lib/language";
import { desktopPermissionsCopy } from "../../../../locales/desktopPermissions";
import { permissionModes, type PermissionModeId, type PermissionsView } from "../permission-contract";
import { useDismiss } from "./CodeProjects";
import "./code-projects.css";

type Copy = (typeof desktopPermissionsCopy)[Language];

const modeText = (copy: Copy, mode: PermissionModeId) => ({
  read_only: [copy.readOnly, copy.readOnlyDetail],
  ask: [copy.ask, copy.askDetail],
  auto_review: [copy.autoReview, copy.autoReviewDetail],
  allow_all: [copy.allowAll, copy.allowAllDetail],
} as const)[mode];

/**
 * The one dropdown under the composer that replaces the old Agent / Ask / Plan select and the permission badge. Its four
 * items are the four permission modes of Settings and share their state: a change here is the same `set-mode` command,
 * saved at once. Read only is what Ask and Plan used to be (read and answer, change nothing, run nothing).
 *
 * Auto review and Allow all work only where the Tomverse API runs the task; on a provider CLI route they stay in the list,
 * switched off, with the reason. Allow all asks for its confirmation here, as it does in Settings.
 */
export function ComposerPermission({ view, language, apiRoute, readOnlyOnly, running, disabled }: {
  view: PermissionsView | undefined; language: Language; apiRoute: boolean;
  /** The route can only read (a provider CLI whose file edits are not offered): Read only is the one mode that holds. */
  readOnlyOnly: boolean; running: boolean; disabled: boolean;
}) {
  const copy = desktopPermissionsCopy[language];
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); setConfirming(false); }, []);

  useDismiss(open, close, root, trigger);
  const mode: PermissionModeId = readOnlyOnly ? "read_only" : view?.mode ?? "ask";
  const reasonFor = (item: PermissionModeId) => readOnlyOnly && item !== "read_only" ? copy.readOnlyRoute
    : (item === "auto_review" || item === "allow_all") && !apiRoute ? copy.apiOnly : null;

  async function send(next: PermissionModeId, confirmed?: boolean) {
    setFailed(false);
    try {
      const result = await window.desktop.permissions({ action: "set-mode", mode: next, ...(confirmed ? { confirmed: true } : {}) });
      if (result.ok) { close(); trigger.current?.focus(); } else setFailed(true);
    } catch { setFailed(true); }
  }

  function choose(next: PermissionModeId) {
    if (reasonFor(next)) return;
    if (next === mode) { close(); trigger.current?.focus(); return; }
    if (next === "allow_all") { setConfirming(true); return; }
    void send(next);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (confirming) setConfirming(false); else { close(); trigger.current?.focus(); }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitemradio]")];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    items[event.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1)]!.focus();
  }

  if (!view) return null;
  const [label] = modeText(copy, mode);
  const Icon = mode === "allow_all" ? ShieldAlert : ShieldCheck;
  return <div className="composer-permission" ref={root} >
    <button ref={trigger} type="button" className="composer-permission-button" data-testid="permission-picker" data-mode={mode} disabled={disabled}
      aria-haspopup="menu" aria-expanded={open} aria-label={`${copy.composerLabel}: ${mode === "allow_all" ? copy.allowAllBadge : label}`}
      onClick={() => { if (open) close(); else { setOpen(true); setFailed(false); } }}>
      <Icon size={15} aria-hidden="true" /> <span className="composer-permission-label">{mode === "allow_all" ? copy.allowAllBadge : label}</span> <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="project-popover composer-permission-popover" data-testid="permission-popover" onKeyDown={onKeyDown}>
      <div role="menu" aria-label={copy.composerLabel} className="composer-permission-list">
        {permissionModes.map((item, index) => {
          const [name, detail] = modeText(copy, item);
          const reason = reasonFor(item);
          return <button key={item} type="button" role="menuitemradio" aria-checked={mode === item} aria-disabled={reason ? true : undefined}
            className="composer-permission-item" data-testid={`permission-item-${item}`} autoFocus={index === Math.max(0, permissionModes.indexOf(mode))}
            onClick={() => choose(item)}>
            <strong>{name}</strong>{mode === item ? <Check size={14} aria-hidden="true" /> : <span />}
            <small>{reason ?? detail}</small>
          </button>;
        })}
      </div>
      {mode === "auto_review" && <p className="project-note" role="note">{copy.autoReviewCost}</p>}
      {confirming && <div className="permission-confirm project-confirm" role="alertdialog" aria-labelledby="composer-allow-all-title" aria-describedby="composer-allow-all-body" data-testid="permission-allow-all-confirm">
        <strong id="composer-allow-all-title">{copy.allowAllConfirmTitle}</strong>
        <p id="composer-allow-all-body">{copy.allowAllConfirmBody}</p>
        <div className="project-actions">
          <button className="soft" type="button" autoFocus onClick={() => setConfirming(false)}>{copy.cancel}</button>
          <button className="soft danger" type="button" data-testid="permission-allow-all-accept" onClick={() => void send("allow_all", true)}>{copy.allowAllConfirm}</button>
        </div>
      </div>}
      <p className="project-note">{running ? copy.appliesNext : copy.projectRemembered}</p>
      {failed && <p role="alert" className="project-message">{copy.saveFailed}</p>}
    </div>}
  </div>;
}
