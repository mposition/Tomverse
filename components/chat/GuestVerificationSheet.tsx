"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useGuestVerification } from "@/components/chat/GuestVerificationProvider";
import { guestVerificationFailureKey } from "@/components/chat/guestVerificationCopy";
import type { TurnstileWidgetSize } from "@/components/chat/turnstileScript";

/**
 * The mobile home for the real Cloudflare widget: a modal bottom sheet that
 * only exists as a modal once Cloudflare actually asks for an interaction.
 *
 * It is portalled to <body>, so it can never take part in the composer's
 * height calculation, never sits inside the message list, and never competes
 * with the textarea's row (docs/ui-contracts/mobile-chat-composer.md). While
 * verification is running silently the same DOM stays mounted -- the widget
 * has to exist for Cloudflare to run it -- but as a zero-height, out-of-flow,
 * pointer-transparent container that consumes no layout at all.
 *
 * There is deliberately no "security check needed" chip and no "start
 * verification" button: the sheet opens straight onto the widget.
 */

/** Below this the `compact` widget is the only one that fits without clipping. */
const MIN_FLEXIBLE_WIDGET_WIDTH = 300;

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** The portal target never changes; the server simply has none. */
const subscribeToNothing = () => () => {};
const getPortalContainer = () => document.body;
const getServerPortalContainer = () => null;

export function GuestVerificationSheet() {
  const { t } = useLanguage();
  const {
    isEnabled,
    phase,
    failure,
    lastOutcome,
    isChallengeVisible,
    isLongWait,
    cancel,
    registerHost,
    setHostSize,
  } = useGuestVerification();

  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  const container = useSyncExternalStore<HTMLElement | null>(
    subscribeToNothing,
    getPortalContainer,
    getServerPortalContainer
  );
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [isRaised, setIsRaised] = useState(false);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  /** Distance from the viewport bottom to the composer's top edge. */
  const [bottomOffset, setBottomOffset] = useState(0);

  const isOpen = isChallengeVisible;

  // Size follows the sheet's own measured width, which is why the closed
  // container keeps full width instead of collapsing to 0: the widget has to
  // be rendered at a size that will fit before the challenge appears.
  useEffect(() => {
    if (!isEnabled) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const measure = () => {
      const style = getComputedStyle(sheet);
      // The width the widget actually gets: the sheet minus its own padding.
      setMeasuredWidth(
        sheet.clientWidth -
          (Number.parseFloat(style.paddingLeft) || 0) -
          (Number.parseFloat(style.paddingRight) || 0)
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [isEnabled, container]);

  const size: TurnstileWidgetSize =
    measuredWidth >= MIN_FLEXIBLE_WIDGET_WIDTH ? "flexible" : "compact";

  useEffect(() => {
    if (!isEnabled) return;
    setHostSize(size);
  }, [isEnabled, setHostSize, size]);

  // The sheet stops at the composer's top edge instead of sitting on top of
  // it. The composer contract is explicit that nothing may cover the textarea
  // or its controls, and it is also the safer read: the user can still see the
  // message they are about to send while they verify. The dimmed backdrop
  // still covers the whole screen, and the shell behind it is inert either
  // way, so the composer is visible but not usable.
  //
  // Measured in a layout effect, so the sheet's very first painted frame
  // already clears the composer -- an ordinary effect would flash one frame of
  // an overlapping sheet.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const measure = () => {
      const composer = document.querySelector<HTMLElement>(
        '[data-testid="chat-input"]'
      );
      const viewportHeight = window.innerHeight;
      if (!composer) {
        setBottomOffset(0);
        return;
      }
      const composerTop = composer.getBoundingClientRect().top;
      setBottomOffset(
        Math.round(
          Math.max(0, Math.min(viewportHeight - composerTop, viewportHeight * 0.6))
        )
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isOpen]);

  // Runs before the browser paints the open sheet: the on-screen keyboard is
  // dismissed first, so the sheet is not opening behind it.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      returnFocusRef.current = active;
      active.blur();
    }
  }, [isOpen]);

  // Focus moves into the dialog only for a real interactive challenge, and
  // lands on the close control rather than inside Cloudflare's iframe.
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  // One frame after opening the sheet settles into place. Under
  // prefers-reduced-motion the `motion-safe:` classes never apply, so this
  // resolves to no movement and no transition at all.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setIsRaised(isOpen));
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  const getFocusableElements = useCallback(() => {
    const sheet = sheetRef.current;
    if (!sheet) return [] as HTMLElement[];
    return Array.from(
      sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((element) => element.offsetParent !== null);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [cancel, getFocusableElements, isOpen]);

  // Cancelling or failing hands focus back to whatever the user was using.
  // Succeeding deliberately does not: the original request just continues, and
  // re-focusing the textarea would pop the keyboard open for no reason.
  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;

    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (lastOutcome === "succeeded") return;

    // The control the user came from is usually the send button, which the
    // still-unwinding send attempt can leave disabled for a frame or two --
    // and a disabled element silently swallows focus(). So this retries, for a
    // bounded moment, until focus is genuinely back inside the composer,
    // falling back to the textarea when the original control never recovers.
    let timer: number | null = null;
    let attempts = 0;
    const isFocusInComposer = () =>
      Boolean(
        document
          .querySelector('[data-testid="chat-input"]')
          ?.contains(document.activeElement)
      );
    const restoreFocus = () => {
      attempts += 1;
      if (isFocusInComposer()) return;
      if (
        target &&
        target.isConnected &&
        !(target as HTMLButtonElement).disabled
      ) {
        target.focus();
      }
      if (!isFocusInComposer()) {
        const textarea = document.querySelector<HTMLTextAreaElement>(
          '[data-testid="chat-textarea"]'
        );
        if (textarea && !textarea.disabled) textarea.focus();
      }
      if (!isFocusInComposer() && attempts < 20) {
        timer = window.setTimeout(restoreFocus, 50);
      }
    };
    timer = window.setTimeout(restoreFocus, 0);

    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isOpen, lastOutcome]);

  if (!isEnabled || !container) return null;

  return createPortal(
    <div
      data-testid="guest-verification-sheet-layer"
      data-state={isOpen ? "open" : "closed"}
      data-phase={phase}
      aria-hidden={isOpen ? undefined : true}
      className={
        isOpen
          ? "fixed inset-0 z-[95]"
          : // Closed: out of flow, zero height, invisible and untouchable --
            // but still full width, so the widget can be sized for the sheet
            // it will appear in.
            "pointer-events-none fixed bottom-0 left-0 right-0 h-0 overflow-hidden opacity-0"
      }
    >
      {isOpen ? (
        <button
          type="button"
          data-testid="guest-verification-backdrop"
          aria-label={t("chat.guestVerificationClose")}
          onClick={cancel}
          className="absolute inset-0 h-full w-full cursor-default bg-black/50 backdrop-blur-sm motion-reduce:backdrop-blur-none"
        />
      ) : null}
      <div
        ref={sheetRef}
        data-testid="guest-verification-sheet"
        {...(isOpen
          ? {
              role: "dialog",
              "aria-modal": true,
              "aria-labelledby": titleId,
              "aria-describedby": descriptionId,
            }
          : {})}
        style={
          isOpen
            ? {
                bottom: `${bottomOffset}px`,
                maxHeight: `calc(100% - ${bottomOffset + 8}px)`,
              }
            : undefined
        }
        className={
          isOpen
            ? `absolute left-0 right-0 z-10 mx-auto w-full max-w-md overflow-y-auto rounded-t-3xl border-t border-zinc-200 bg-white px-4 pb-4 pt-3 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 motion-safe:transition-transform motion-safe:duration-200 ${
                isRaised ? "translate-y-0" : "motion-safe:translate-y-6"
              }`
            : "w-full px-4"
        }
      >
        <div className={isOpen ? "mb-3 flex items-start gap-2" : "hidden"}>
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              data-testid="guest-verification-title"
              className="text-sm font-bold text-zinc-900 break-keep dark:text-zinc-100"
            >
              {t("chat.guestVerificationTitle")}
            </h2>
            <p
              id={descriptionId}
              className="mt-1 text-[11px] font-medium leading-4 text-zinc-500 break-keep dark:text-zinc-400"
            >
              {t("chat.guestVerificationDescription")}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="guest-verification-close"
            onClick={cancel}
            aria-label={t("chat.guestVerificationClose")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div
          ref={registerHost}
          data-testid="guest-verification-widget"
          className="flex w-full min-w-0 justify-center"
        />
        {/*
          EXT-REAUDIT-F004. Announced, not alerting: this is not a failure and
          must not read like one, so it is role="status" (polite) rather than
          role="alert". The challenge stays live underneath it -- the escape
          route it points at is the close control that was already there.
        */}
        {isOpen && isLongWait && !failure ? (
          <p
            role="status"
            data-testid="guest-verification-long-wait"
            className="mt-3 text-[11px] font-semibold leading-4 text-zinc-600 break-keep dark:text-zinc-300"
          >
            {t("chat.guestVerificationLongWait")}
          </p>
        ) : null}
        {isOpen && failure ? (
          <p
            role="alert"
            data-testid="guest-verification-error"
            className="mt-3 text-[11px] font-semibold leading-4 text-red-600 break-keep dark:text-red-400"
          >
            {t(guestVerificationFailureKey(failure))}
          </p>
        ) : null}
      </div>
    </div>,
    container
  );
}
