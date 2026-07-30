"use client";

import { Info } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { SourceGrounding } from "@/lib/sourceGrounding";

export type SourceGroundingLabels = {
  /** Scope-qualified metric name, e.g. "Overall source grounding". */
  label: string;
  /** Shown instead of a number when nothing was quoted -- never "0%". */
  unavailable: string;
  /** "{matched}/{total} quotes matched" */
  quotesMatched: string;
  /** What the number is, and the three things it is not. */
  description: string;
  /** Accessible name for the info button. */
  infoLabel: string;
};

type SourceGroundingBadgeProps = {
  grounding: SourceGrounding;
  labels: SourceGroundingLabels;
  testId?: string;
  className?: string;
};

const FLOATING_GAP = 6;
const VIEWPORT_MARGIN = 8;
const POPOVER_WIDTH = 288;

type FloatingPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

export const formatSourceGroundingValue = (
  grounding: SourceGrounding,
  labels: Pick<SourceGroundingLabels, "unavailable" | "quotesMatched">
) => {
  if (!grounding.available || grounding.percent === null) {
    return labels.unavailable;
  }
  const quotes = labels.quotesMatched
    .replace("{matched}", String(grounding.matchedQuotes))
    .replace("{total}", String(grounding.totalQuotes));
  return `${grounding.percent}% · ${quotes}`;
};

export function SourceGroundingBadge({
  grounding,
  labels,
  testId,
  className = "",
}: SourceGroundingBadgeProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const id = useId();
  const descriptionId = `${id}-description`;
  const popoverId = `${id}-popover`;
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A press focuses the button before it clicks it, and the focus alone
  // already opens the bubble. Without remembering the state from before the
  // press, the click would immediately toggle shut whatever the focus just
  // opened -- which is exactly what a tap looks like on a touch screen.
  const pointerPressRef = useRef(false);
  const openBeforePressRef = useRef(false);

  const clearCloseTimer = useCallback(() => {
    if (!closeTimerRef.current) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const openPopover = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  const closePopover = useCallback(() => {
    clearCloseTimer();
    setOpen(false);
    setPosition(null);
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), 100);
  }, [clearCloseTimer]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  // Fixed positioning against the viewport: both callers render the badge
  // inside a scrolling dialog body, so an absolutely positioned bubble would
  // be clipped by the overflow container long before it left the screen.
  const updatePosition = useCallback(() => {
    const anchor = rootRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const anchorRect = anchor.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const width = Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2);
    const naturalHeight = popover.scrollHeight;
    const spaceBelow =
      viewportHeight - anchorRect.bottom - FLOATING_GAP - VIEWPORT_MARGIN;
    const spaceAbove = anchorRect.top - FLOATING_GAP - VIEWPORT_MARGIN;
    const placeAbove = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(96, placeAbove ? spaceAbove : spaceBelow);
    const renderedHeight = Math.min(naturalHeight, maxHeight);
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, anchorRect.left),
      Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN)
    );
    const preferredTop = placeAbove
      ? anchorRect.top - FLOATING_GAP - renderedHeight
      : anchorRect.bottom + FLOATING_GAP;
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, preferredTop),
      Math.max(VIEWPORT_MARGIN, viewportHeight - renderedHeight - VIEWPORT_MARGIN)
    );
    const next = {
      top: Math.round(top),
      left: Math.round(left),
      width: Math.round(width),
      maxHeight: Math.round(maxHeight),
    };
    setPosition((current) =>
      current &&
      current.top === next.top &&
      current.left === next.left &&
      current.width === next.width &&
      current.maxHeight === next.maxHeight
        ? current
        : next
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const resizeObserver = new ResizeObserver(updatePosition);
    if (rootRef.current) resizeObserver.observe(rootRef.current);
    if (popoverRef.current) resizeObserver.observe(popoverRef.current);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closePopover();
      // Only pull focus back when it was already inside the badge. Calling
      // focus() from a hover-opened bubble would fire a fresh focus event and
      // immediately reopen what Escape just dismissed.
      const active = document.activeElement;
      if (active && rootRef.current?.contains(active)) buttonRef.current?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        closePopover();
      }
    };
    // Capture phase: both callers sit inside a modal that closes itself on
    // Escape, and dismissing the explanation must not also close the dialog.
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [closePopover, open]);

  const valueText = formatSourceGroundingValue(grounding, labels);

  const popoverLayer =
    open && typeof document !== "undefined"
      ? createPortal(
          <span
            ref={popoverRef}
            id={popoverId}
            data-testid={testId ? `${testId}-popover` : undefined}
            // The same copy is already wired to the value through
            // aria-describedby, so the visual bubble stays out of the
            // accessibility tree instead of being announced twice.
            aria-hidden="true"
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") clearCloseTimer();
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") scheduleClose();
            }}
            className="fixed z-[130] block overflow-y-auto overscroll-contain whitespace-pre-line rounded-2xl border border-zinc-200 bg-white p-3 text-left text-xs font-medium leading-5 text-zinc-600 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              width: position?.width ?? POPOVER_WIDTH,
              maxHeight: position?.maxHeight ?? "calc(100dvh - 1rem)",
              visibility: position ? "visible" : "hidden",
            }}
          >
            {labels.description}
          </span>,
          document.body
        )
      : null;

  return (
    <span
      ref={rootRef}
      data-testid={testId}
      className={`inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-100 py-1 pl-3 pr-1 text-xs font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 ${className}`}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") openPopover();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") scheduleClose();
      }}
      onFocusCapture={openPopover}
      onBlurCapture={() => {
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active && rootRef.current?.contains(active)) return;
          closePopover();
        });
      }}
    >
      <span
        data-testid={testId ? `${testId}-value` : undefined}
        aria-describedby={descriptionId}
      >
        {labels.label}: {valueText}
      </span>
      <button
        ref={buttonRef}
        type="button"
        aria-label={labels.infoLabel}
        aria-expanded={open}
        aria-controls={popoverId}
        data-testid={testId ? `${testId}-info` : undefined}
        onPointerDown={() => {
          pointerPressRef.current = true;
          openBeforePressRef.current = open;
        }}
        onClick={(event) => {
          event.stopPropagation();
          // Keyboard activation has no preceding press, so it toggles the
          // state it can actually see.
          const shouldClose = pointerPressRef.current
            ? openBeforePressRef.current
            : open;
          pointerPressRef.current = false;
          if (shouldClose) closePopover();
          else openPopover();
        }}
        // The circle stays badge-sized, but the ::after box gives every
        // pointer -- including a thumb on the smallest supported screen -- a
        // 44x44 target without stretching the row it sits in.
        className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-zinc-500 transition after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] hover:bg-zinc-200 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {/* Always in the DOM so the description resolves for a screen reader
          whether or not the bubble happens to be open. */}
      <span id={descriptionId} className="sr-only">
        {labels.description}
      </span>
      {popoverLayer}
    </span>
  );
}
