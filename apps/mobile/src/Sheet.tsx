import { useEffect, useRef, type ReactNode } from "react";
import { MessageSquare, X } from "lucide-react";

export function Sheet({ title, closeLabel, onClose, children, exitLabel, onExit, className = "", maxHeight }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode; exitLabel?: string; onExit?: () => void; className?: string; maxHeight?: number }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={dialog} className={`native-sheet ${className}`.trim()} style={maxHeight === undefined ? undefined : { maxHeight }} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="sheet-handle" aria-hidden="true" />
    <div className={onExit ? "sheet-navigation" : undefined}>
      <header className="sheet-header"><h2>{title}</h2><button autoFocus aria-label={closeLabel} onClick={onClose}><X size={22} aria-hidden="true" /></button></header>
      {onExit && <button type="button" className="workspace-return settings-workspace-return" onClick={onExit}><MessageSquare size={18} aria-hidden="true" />{exitLabel}</button>}
    </div>
    {children}
  </dialog>;
}
