"use client";

import Link from "next/link";
import { ExternalLink, Info, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { trackProductEvent } from "@/lib/productAnalyticsClient";

export type UiHelpTopic =
  | "project"
  | "label"
  | "locked"
  | "shared"
  | "private"
  | "ai_review"
  | "credits"
  | "guest_trial";

type FeatureHelpPopoverProps = {
  title: string;
  description: string;
  buttonLabel: string;
  learnMoreLabel: string;
  topic: UiHelpTopic;
  href?: string;
  mobile?: boolean;
  align?: "left" | "right";
  testId?: string;
  className?: string;
};

type FloatingPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

const FLOATING_GAP = 6;
const VIEWPORT_MARGIN = 8;
const DESKTOP_POPOVER_WIDTH = 288;

export function FeatureHelpPopover({
  title,
  description,
  buttonLabel,
  learnMoreLabel,
  topic,
  href,
  mobile = false,
  align = "left",
  testId,
  className = "",
}: FeatureHelpPopoverProps) {
  const [open, setOpen] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [floatingPosition, setFloatingPosition] =
    useState<FloatingPosition | null>(null);
  const id = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedForInteractionRef = useRef(false);

  const renderAsSheet = mobile || narrowViewport;

  const openPopover = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
    if (!openedForInteractionRef.current) {
      openedForInteractionRef.current = true;
      trackProductEvent("ui_help_opened", 0, { help_topic: topic });
    }
  }, [topic]);

  const closePopover = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(false);
    setFloatingPosition(null);
    openedForInteractionRef.current = false;
  }, []);

  const scheduleClosePopover = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(closePopover, 100);
  }, [closePopover]);

  const keepPopoverOpen = useCallback(() => {
    if (!closeTimerRef.current) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setNarrowViewport(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    []
  );

  const updateFloatingPosition = useCallback(() => {
    const anchor = rootRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const anchorRect = anchor.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const width = Math.min(
      DESKTOP_POPOVER_WIDTH,
      viewportWidth - VIEWPORT_MARGIN * 2
    );
    const naturalHeight = popover.scrollHeight;
    const spaceBelow =
      viewportHeight - anchorRect.bottom - FLOATING_GAP - VIEWPORT_MARGIN;
    const spaceAbove = anchorRect.top - FLOATING_GAP - VIEWPORT_MARGIN;
    const placeAbove = naturalHeight > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(96, placeAbove ? spaceAbove : spaceBelow);
    const renderedHeight = Math.min(naturalHeight, maxHeight);
    const preferredLeft =
      align === "right" ? anchorRect.right - width : anchorRect.left;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, preferredLeft),
      viewportWidth - width - VIEWPORT_MARGIN
    );
    const preferredTop = placeAbove
      ? anchorRect.top - FLOATING_GAP - renderedHeight
      : anchorRect.bottom + FLOATING_GAP;
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, preferredTop),
      viewportHeight - renderedHeight - VIEWPORT_MARGIN
    );
    const nextPosition = {
      top: Math.round(top),
      left: Math.round(left),
      width: Math.round(width),
      maxHeight: Math.round(maxHeight),
    };

    setFloatingPosition((current) =>
      current &&
      current.top === nextPosition.top &&
      current.left === nextPosition.left &&
      current.width === nextPosition.width &&
      current.maxHeight === nextPosition.maxHeight
        ? current
        : nextPosition
    );
  }, [align]);

  useLayoutEffect(() => {
    if (!open || renderAsSheet) return;

    updateFloatingPosition();
    const resizeObserver = new ResizeObserver(updateFloatingPosition);
    if (rootRef.current) resizeObserver.observe(rootRef.current);
    if (popoverRef.current) resizeObserver.observe(popoverRef.current);
    window.addEventListener("resize", updateFloatingPosition);
    window.addEventListener("scroll", updateFloatingPosition, true);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateFloatingPosition);
      window.removeEventListener("scroll", updateFloatingPosition, true);
    };
  }, [open, renderAsSheet, updateFloatingPosition]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePopover();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !renderAsSheet &&
        !rootRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        closePopover();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [closePopover, open, renderAsSheet]);

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-black text-zinc-950 dark:text-white">
          {title}
        </h3>
        {renderAsSheet ? (
          <button
            type="button"
            onClick={closePopover}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label={buttonLabel}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <p className="mt-2 whitespace-pre-line text-xs font-medium normal-case leading-5 tracking-normal text-zinc-600 dark:text-zinc-300">
        {description}
      </p>
      {href ? (
        <Link
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-black text-blue-600 hover:text-blue-500 dark:text-blue-300"
        >
          {learnMoreLabel}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      ) : null}
    </>
  );

  const floatingLayer =
    open && typeof document !== "undefined"
      ? createPortal(
          renderAsSheet ? (
            <span
              className="fixed inset-0 z-[120] flex items-end bg-black/55"
              role="presentation"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) closePopover();
              }}
            >
              <span
                id={id}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="block max-h-[calc(100dvh-1rem)] w-full overflow-y-auto overscroll-contain rounded-t-3xl border border-zinc-200 bg-white px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-5 text-left shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
              >
                {content}
              </span>
            </span>
          ) : (
            <span
              ref={popoverRef}
              id={id}
              role="tooltip"
              data-testid={testId ? `${testId}-content` : undefined}
              onMouseEnter={keepPopoverOpen}
              onMouseLeave={scheduleClosePopover}
              onFocusCapture={keepPopoverOpen}
              className="fixed z-[120] block overflow-y-auto overscroll-contain rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
              style={{
                top: floatingPosition?.top ?? 0,
                left: floatingPosition?.left ?? 0,
                width: floatingPosition?.width ?? DESKTOP_POPOVER_WIDTH,
                maxHeight: floatingPosition?.maxHeight ?? "calc(100dvh - 1rem)",
                visibility: floatingPosition ? "visible" : "hidden",
              }}
            >
              {content}
            </span>
          ),
          document.body
        )
      : null;

  return (
    <span
      ref={rootRef}
      className={`relative inline-flex shrink-0 ${className}`}
      onMouseEnter={() => {
        if (!renderAsSheet) openPopover();
      }}
      onMouseLeave={() => {
        if (!renderAsSheet) scheduleClosePopover();
      }}
      onFocusCapture={() => {
        if (!renderAsSheet) openPopover();
      }}
      onBlurCapture={() => {
        if (renderAsSheet) return;
        requestAnimationFrame(() => {
          const activeElement = document.activeElement;
          if (
            activeElement &&
            !rootRef.current?.contains(activeElement) &&
            !popoverRef.current?.contains(activeElement)
          ) {
            closePopover();
          }
        });
      }}
    >
      <button
        type="button"
        aria-label={buttonLabel}
        aria-expanded={open}
        aria-controls={id}
        data-testid={testId}
        onClick={(event) => {
          event.stopPropagation();
          if (renderAsSheet && open) closePopover();
          else openPopover();
        }}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-blue-950/50 dark:hover:text-blue-300"
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
      {floatingLayer}
    </span>
  );
}
