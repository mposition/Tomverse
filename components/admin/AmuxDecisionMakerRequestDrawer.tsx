"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  AmuxDecisionMakerRequestDetailPanel,
  type DmAdminRequestDetailView,
} from "@/components/admin/AmuxDecisionMakerRequestDetailPanel";
import { adminAmuxDecisionMakerAttentionMessages } from "@/lib/adminMessages/amuxDecisionMaker";

const FOCUSABLE = "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

/**
 * One Decision Maker request as a side panel over AMUX › Execution. The panel
 * is the page's `?dmRequest=` state, so it survives a reload and closes by
 * navigating to `closeHref`: the scrim, the close link and Escape all go there.
 * It is modal while open: focus moves into it and Tab stays inside.
 */
export function AmuxDecisionMakerRequestDrawer({ view, closeHref }: { view: DmAdminRequestDetailView; closeHref: string }) {
  const d = useAdminMessages(adminAmuxDecisionMakerAttentionMessages);
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const title = view.kind === "detail" ? d.dialog(view.detail.row.cardId, view.detail.row.questionRevision) : d.close;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div className="fixed inset-0 z-[110] flex justify-end" data-testid="amux-dm-drawer">
      <Link href={closeHref} scroll={false} aria-label={d.close} tabIndex={-1} className="absolute inset-0 bg-black/60" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-[40rem] flex-col border-l border-zinc-700 bg-zinc-900 shadow-2xl outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            router.push(closeHref, { scroll: false });
            return;
          }
          if (event.key !== "Tab") return;
          const items = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
          if (items.length === 0) return;
          const first = items[0]!;
          const last = items[items.length - 1]!;
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <AmuxDecisionMakerRequestDetailPanel view={view} close={{ href: closeHref, label: d.close }} />
      </div>
    </div>
  );
}
