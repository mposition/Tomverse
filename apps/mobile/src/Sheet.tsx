import { useEffect, useRef, type ReactNode } from "react";

export function Sheet({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={dialog} className="native-sheet" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="sheet-handle" aria-hidden="true" />
    <header className="sheet-header"><h2>{title}</h2><button autoFocus aria-label={closeLabel} onClick={onClose}>×</button></header>
    {children}
  </dialog>;
}
