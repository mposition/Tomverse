"use client";

import { useEffect, type RefObject } from "react";

/**
 * UX-010. The focus contract every `aria-modal="true"` surface owes its users.
 *
 * `aria-modal="true"` is a promise to assistive technology that the rest of the
 * page is inert. Most of this app's modals declared it without keeping it: focus
 * stayed on the trigger behind the overlay, Tab walked the obscured page, and
 * nothing was announced on open. This is that contract, extracted verbatim from
 * the two surfaces that already implemented it correctly -- `UsageLimitModal`
 * and `CreditPackPurchaseButton` -- so the behaviour has one home instead of
 * being reimplemented per dialog.
 *
 * What it guarantees while `open`:
 *
 * - **Initial focus** moves into the dialog on the next frame (after the
 *   portal has painted), preferring `initialFocusRef` and falling back to the
 *   first focusable element in the panel.
 * - **Tab and Shift+Tab cycle** within the panel, including when focus has
 *   escaped to the document.
 * - **Escape closes**, via `onClose`.
 * - **Background scroll is locked** and restored exactly to its previous value.
 * - **Focus returns** to whatever was focused before opening, if it is still in
 *   the document.
 * - **Nested modals own their own keys.** Ownership is decided by the event
 *   target's nearest `[role="dialog"][aria-modal="true"]` ancestor, not by DOM
 *   order: a portal can render before or after the dialog that opened it, so
 *   position is not a reliable signal. Escape inside a nested dialog must close
 *   that one, never the one underneath.
 */
export function useModalDialog({
  open,
  onClose,
  dialogRef,
  panelRef,
  initialFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  /** The element carrying `role="dialog"` and `aria-modal="true"`. */
  dialogRef: RefObject<HTMLElement | null>;
  /** The focusable region; usually the visible panel inside the overlay. */
  panelRef: RefObject<HTMLElement | null>;
  /** Preferred initial focus target. Falls back to the first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!open) return;

    const returnTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusableWithin = (panel: HTMLElement) =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        // `offsetParent === null` also covers `display: none` ancestors, which is
        // what a collapsed section inside an open dialog looks like.
      ).filter((element) => element.offsetParent !== null);

    const focusFrame = requestAnimationFrame(() => {
      const preferred = initialFocusRef?.current;
      if (preferred?.isConnected) {
        preferred.focus();
        return;
      }
      const panel = panelRef.current;
      if (!panel) return;
      focusableWithin(panel)[0]?.focus();
    });

    const ownsEvent = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !panelRef.current) return false;

      const eventOwner =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[role="dialog"][aria-modal="true"]')
          : null;
      if (eventOwner && eventOwner !== dialog) return false;
      const modalDialogs = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
      );
      return modalDialogs.at(-1) === dialog;
    };

    // Escape listens in the *bubble* phase on purpose. A dismissible surface
    // nested inside a dialog -- a popover, a combobox -- cancels itself on
    // Escape and calls `stopPropagation()` from a capture listener so the
    // dialog around it stays open (see SourceGroundingBadge). Listening in
    // capture here would beat that listener on registration order and close the
    // whole dialog instead, which is a silent loss of the user's place.
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ownsEvent(event)) return;
      event.preventDefault();
      onClose();
    };

    // Tab stays in capture: the trap has to run before any handler that might
    // move focus itself, or focus can leave the dialog for a frame.
    const handleKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key !== "Tab" || !ownsEvent(event)) return;

      const focusable = focusableWithin(panel);
      if (focusable.length === 0) {
        // Nothing to cycle to; swallowing Tab keeps focus from escaping into
        // the inert background.
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keydown", handleEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = previousOverflow;
      requestAnimationFrame(() => {
        // The trigger can be gone by now (a row that was just deleted, a menu
        // that closed with the dialog); focusing a detached node would silently
        // drop focus to <body>.
        if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
      });
    };
  }, [open, onClose, dialogRef, panelRef, initialFocusRef]);
}
