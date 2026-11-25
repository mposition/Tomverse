import { useEffect, useRef, useState } from "react";
import type { Language } from "../../../../lib/language";
import { desktopControlsCopy } from "../../../../locales/desktopControls";
import { desktopEvidenceCopy } from "../../../../locales/desktopEvidence";
import { desktopNativeCopy } from "../../../../locales/desktopNative";
import { desktopShellCopy } from "../../../../locales/desktopShell";
import type { Change, ChangeInspection, UndoChangeResult } from "../contract";
import { summarizeDiff, visibleDiff } from "./diffSummary";
import { formatEvidence } from "./evidence-copy";

const undoLabels = {
  undone: "fileUndone", cancelled: null, conflict: "undoConflict", unavailable: "undoUnavailable", unconfirmed: "undoUnconfirmed",
} as const satisfies Record<UndoChangeResult, keyof typeof desktopEvidenceCopy.en | null>;

export function DiffPanel({ changes, language }: { changes: Change[]; language: Language }) {
  const revision = useRef(0);
  const undoButton = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState("");
  const [diff, setDiff] = useState<{ id: string; inspection: ChangeInspection | null } | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoResult, setUndoResult] = useState<UndoChangeResult | null>(null);
  const inspection = diff && diff.id === selected ? diff.inspection : undefined;
  const selectedDiff = inspection?.text;
  const stat = selectedDiff ? summarizeDiff(selectedDiff) : null;
  const preview = selectedDiff ? visibleDiff(selectedDiff) : null;
  const copy = desktopEvidenceCopy[language];
  const shellCopy = desktopShellCopy[language];
  const controls = desktopControlsCopy[language];
  const changeLabels: Record<string, string> = {
    applied: copy.applied, as_written: copy.applied, changed_since: copy.changedSince,
    missing: copy.missing, undone: copy.undone, writing: shellCopy.unconfirmed, failed: shellCopy.failed,
    not_applied: copy.notApplied, not_attempted: copy.notAttempted, outside: copy.outside,
  };
  const undoLabel = undoResult && undoLabels[undoResult];
  useEffect(() => {
    if (!undoing && undoResult === "cancelled") undoButton.current?.focus();
  }, [undoing, undoResult]);

  function inspect(id: string) {
    setSelected(id);
    setDiff(null);
    setShowFull(false);
    setUndoResult(null);
    const current = ++revision.current;
    const received = (inspection: ChangeInspection | null) => { if (revision.current === current) setDiff({ id, inspection }); };
    void window.desktop.readChange(id).then(received, () => received(null));
  }

  async function undo(id: string) {
    setUndoing(true);
    const result = await window.desktop.undoChange(id).catch((): UndoChangeResult => "unconfirmed");
    if (result !== "cancelled") inspect(id);
    setUndoResult(result);
    setUndoing(false);
  }

  return <details><summary>{formatEvidence(copy.changes, language, { count: changes.length })}</summary>
    <ul>{changes.map((file) => {
      const state = selected === file.id && inspection ? inspection.current : file.current;
      const kind = file.kind === "create" || file.kind === "update" || file.kind === "delete" ? controls[file.kind] : file.kind;
      return <li key={file.id}>
        {["applied", "undone"].includes(file.current) ? <button className="soft" type="button" disabled={undoing}
          aria-pressed={selected === file.id} onClick={() => inspect(file.id)}><code>{file.path}</code></button> : <code>{file.path}</code>}
        <span> · {kind} · {Object.hasOwn(changeLabels, state) ? changeLabels[state] : state}</span>
      </li>;
    })}</ul>
    {undoLabel && <p role="status">{copy[undoLabel]}</p>}
    {selected && (inspection === undefined ? <p role="status">{copy.loadingChange}</p> :
      !selectedDiff ? <p role="status">{copy.diffUnavailable}</p> :
      <div>
        {stat && <p>+{stat.added} / −{stat.removed}</p>}
        <pre role="region" aria-label={copy.recordedDiff} tabIndex={0}>{showFull ? selectedDiff : preview?.text}</pre>
        {preview && preview.hidden > 0 && !showFull && <button className="soft" type="button" onClick={() => setShowFull(true)}>
          {formatEvidence(copy.moreLines, language, { count: preview.hidden })}
        </button>}
      </div>)}
    {inspection?.canUndo && <button ref={undoButton} className="soft" type="button" disabled={undoing} onClick={() => void undo(selected)}>
      {undoing ? copy.undoing : desktopNativeCopy[language].undoAccept}
    </button>}
  </details>;
}
