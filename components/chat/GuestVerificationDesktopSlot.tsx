"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useGuestVerification } from "@/components/chat/GuestVerificationProvider";
import { guestVerificationFailureKey } from "@/components/chat/guestVerificationCopy";
import type { TurnstileWidgetSize } from "@/components/chat/turnstileScript";

/**
 * The desktop home for the real Cloudflare widget.
 *
 * `variant="rail"` renders it as the last item of the comparison rail's action
 * row -- immediately to the right of the AI cross-review action, and after it
 * in DOM/screen-reader order. `variant="fallback"` is the shared slot used when
 * the rail is not on screen at all (a single-model conversation), so the
 * verification surface never disappears just because there is nothing to
 * compare yet.
 *
 * Two rules drive the geometry:
 *  - nothing is rendered while there is nothing to verify (no placeholder box,
 *    no chip, no reserved gap);
 *  - when the row cannot spare ~300px the widget takes a full-width row of its
 *    own above the composer instead of squeezing itself or the actions.
 */

/** Cloudflare's `normal` widget is 300px wide; below that it must not go inline. */
const MIN_INLINE_WIDGET_WIDTH = 310;
/** Under this, only the `compact` (150px) widget fits without clipping. */
const MIN_FLEXIBLE_WIDGET_WIDTH = 300;

type Variant = "rail" | "fallback";

export function GuestVerificationDesktopSlot({
  variant,
}: {
  variant: Variant;
}) {
  const { t } = useLanguage();
  const {
    isEnabled,
    phase,
    failure,
    isChallengeVisible,
    registerHost,
    setHostSize,
  } = useGuestVerification();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [isStacked, setIsStacked] = useState(variant === "fallback");
  const [measuredWidth, setMeasuredWidth] = useState(0);

  // Mounted for the whole verification, not just the visible part: the widget
  // has to exist (and run silently) before Cloudflare can decide an
  // interaction is needed.
  const isMounted = isEnabled && phase !== "idle";

  const measure = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    if (variant === "fallback") {
      const parent = wrapper.parentElement;
      setMeasuredWidth(parent?.clientWidth ?? 0);
      setIsStacked(true);
      return;
    }

    const row = wrapper.parentElement;
    if (!row) return;
    const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
    let used = 0;
    for (const child of Array.from(row.children)) {
      if (child === wrapper) continue;
      used += child.getBoundingClientRect().width + gap;
    }
    const rowWidth = row.clientWidth;
    const available = rowWidth - used;
    const stacked = available < MIN_INLINE_WIDGET_WIDTH;
    setIsStacked(stacked);
    setMeasuredWidth(stacked ? rowWidth : available);
  }, [variant]);

  useEffect(() => {
    if (!isMounted) return;
    const wrapper = wrapperRef.current;
    const parent = wrapper?.parentElement;
    if (!parent) return;

    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(parent);
    // Sibling actions can reflow (a credit badge appearing, a label
    // truncating) without the row itself changing size.
    for (const child of Array.from(parent.children)) {
      if (child !== wrapper) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [isMounted, measure]);

  const size: TurnstileWidgetSize = !isStacked
    ? "normal"
    : measuredWidth >= MIN_FLEXIBLE_WIDGET_WIDTH
      ? "flexible"
      : "compact";

  useEffect(() => {
    if (!isMounted) return;
    setHostSize(size);
  }, [isMounted, setHostSize, size]);

  if (!isMounted) return null;

  const isVisible = isChallengeVisible;
  const wrapperClassName = isVisible
    ? isStacked
      ? "mt-2 flex w-full min-w-0 basis-full flex-col items-start gap-1"
      : "ml-auto flex min-w-0 flex-col items-end gap-1"
    : // Silent verification: the widget must exist and run, but it may not
      // reserve a single pixel of the rail. Taken out of flow rather than
      // display:none so the iframe keeps running.
      "pointer-events-none fixed left-0 top-0 h-px w-px overflow-hidden opacity-0";

  const wrapper = (
    <div
      ref={wrapperRef}
      data-testid="desktop-guest-verification"
      data-phase={phase}
      data-layout={isStacked ? "stacked" : "inline"}
      data-visible={isVisible ? "true" : "false"}
      aria-hidden={isVisible ? undefined : true}
      {...(isVisible
        ? { role: "group", "aria-label": t("chat.guestVerificationTitle") }
        : {})}
      className={wrapperClassName}
    >
      <div
        ref={registerHost}
        data-testid="guest-verification-widget"
        className="flex min-w-0 items-center"
      />
      {isVisible && failure ? (
        <p
          role="alert"
          data-testid="guest-verification-error"
          className="max-w-full text-[11px] font-semibold leading-4 text-red-600 dark:text-red-400"
        >
          {t(guestVerificationFailureKey(failure))}
        </p>
      ) : null}
    </div>
  );

  if (variant === "rail") return wrapper;

  return (
    <div className="w-full shrink-0 px-4 md:px-6">
      <div className="mx-auto w-full max-w-4xl">{wrapper}</div>
    </div>
  );
}
