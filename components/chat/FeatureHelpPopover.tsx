"use client";

import Link from "next/link";
import { ExternalLink, Info, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { trackProductEvent } from "@/lib/productAnalyticsClient";

export type UiHelpTopic =
  | "project"
  | "label"
  | "locked"
  | "shared"
  | "private"
  | "ai_review"
  | "credits";

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
  const id = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const openedForInteractionRef = useRef(false);

  const renderAsSheet = mobile || narrowViewport;

  const openPopover = useCallback(() => {
    setOpen(true);
    if (!openedForInteractionRef.current) {
      openedForInteractionRef.current = true;
      trackProductEvent("ui_help_opened", 0, { help_topic: topic });
    }
  }, [topic]);

  const closePopover = useCallback(() => {
    setOpen(false);
    openedForInteractionRef.current = false;
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setNarrowViewport(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePopover();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!renderAsSheet && !rootRef.current?.contains(event.target as Node)) {
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

  return (
    <span
      ref={rootRef}
      className={`relative inline-flex shrink-0 ${className}`}
      onMouseEnter={() => {
        if (!renderAsSheet) openPopover();
      }}
      onMouseLeave={() => {
        if (!renderAsSheet) closePopover();
      }}
      onFocusCapture={() => {
        if (!renderAsSheet) openPopover();
      }}
      onBlurCapture={(event) => {
        if (!renderAsSheet && !event.currentTarget.contains(event.relatedTarget)) {
          closePopover();
        }
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

      {open && renderAsSheet ? (
        <span
          className="fixed inset-0 z-[95] flex items-end bg-black/55"
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
            className="block w-full rounded-t-3xl border border-zinc-200 bg-white px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-5 text-left shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
          >
            {content}
          </span>
        </span>
      ) : null}

      {open && !renderAsSheet ? (
        <span
          id={id}
          role="tooltip"
          className={`absolute top-full z-[70] mt-1 block w-72 rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
