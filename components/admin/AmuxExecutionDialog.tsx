
"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useModalDialog } from "@/components/useModalDialog";
import { useAdminLocale, useAdminMessages } from "./AdminLocaleProvider";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import styles from "./AmuxExecutionWorkspace.module.css";

export function AmuxExecutionDialog({ title, closeLabel, onClose, returnFocusRef, children, actions }: {
  title: string; closeLabel?: string; onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>; children: ReactNode; actions?: ReactNode;
}) {
  const { locale } = useAdminLocale();
  const m = useAdminMessages(adminAmuxExecutionMessages);
  const closeText = closeLabel ?? m.close;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalDialog({ open: true, onClose, dialogRef, panelRef: dialogRef,
    initialFocusRef: closeRef, returnFocusRef });

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement =>
        element instanceof HTMLElement && element !== overlay);
    const previous = siblings.map((element) => element.inert);
    siblings.forEach((element) => { element.inert = true; });
    return () => { siblings.forEach((element, index) => { element.inert = previous[index]; }); };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(<div ref={overlayRef} className={styles.overlay}
    lang={locale} data-locale-root onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
    <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true"
      aria-label={title} data-testid="amux-card-dialog">
      <header className={styles.dialogBar}>
        <span>{title}</span>
        <div className="flex items-center gap-2">
          {actions}
          <button ref={closeRef} type="button" className={styles.iconButton}
            aria-label={closeText} onClick={onClose}><X size={18} aria-hidden="true" /></button>
        </div>
      </header>
      <div className={styles.dialogScroll}>{children}</div>
      <footer className={styles.dialogFooter}>
        <p>{title}</p>
        <button type="button" className={styles.button} onClick={onClose}>{closeText}</button>
      </footer>
    </section>
  </div>, document.body);
}

