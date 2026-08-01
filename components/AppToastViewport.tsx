"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { APP_TOAST_EVENT, type AppToastEventDetail } from "@/lib/appToast";
import {
  appendAppToast,
  appToastDurationMs,
  appToastPoliteness,
  appToastRole,
  dismissAppToast,
  type AppToastItem,
} from "@/lib/appToastViewportCore";

/**
 * Renders `dispatchAppToast()` events.
 *
 * `lib/appToast.ts` only dispatches a window event; something has to listen.
 * The chat shell has always had its own listener, so every toast raised from a
 * chat route was shown -- and every toast raised from the admin console was
 * dispatched into nothing. Input validation, 400/409/428/500 bodies and success
 * confirmations all vanished silently.
 *
 * This viewport is mounted once per shell that needs it -- the admin console
 * (AdminConsoleShell) and the marketing shell (MarketingShell) -- rather than
 * in the shared `(application)` layout, because mounting it there would double
 * every toast on `/chat`, which already renders its own listener.
 *
 * UX-006. The marketing mount is what makes checkout, promotion and support
 * failures visible: `UpgradeInterestButton` and `SupportPageContent` report
 * every outcome through `dispatchAppToast()`, and on `/pricing` and `/support`
 * there was nothing listening, so a failed checkout left a dead button and no
 * message at all. The three shells never render together, so exactly one
 * listener handles any given event.
 */
let toastSequence = 0;

export function AppToastViewport() {
  // Every shell that mounts this viewport sits inside a LanguageProvider: the
  // admin console and the application both inherit one from
  // app/(site)/(application)/layout.tsx, and the marketing shell mounts the
  // viewport inside MarketingProviders for the same reason.
  const { t } = useLanguage();
  const [toasts, setToasts] = useState<AppToastItem[]>([]);
  // Exposed as `data-ready` below. The listener is registered in an effect, so
  // an event dispatched between first paint and hydration is genuinely lost --
  // tests have to wait for this rather than for the element, or they race.
  const [isListening, setIsListening] = useState(false);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => dismissAppToast(current, id));
  }, []);

  useEffect(() => {
    const timers = timersRef.current;

    const handleToast = (event: Event) => {
      const detail = (event as CustomEvent<AppToastEventDetail>).detail;
      const message = detail?.message?.trim();
      if (!message) return;
      const tone = detail.tone ?? "info";
      toastSequence += 1;
      const id = `app-toast-${toastSequence}`;

      setToasts((current) => appendAppToast(current, { id, message, tone }));
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setToasts((current) => dismissAppToast(current, id));
        }, appToastDurationMs(tone))
      );
    };

    window.addEventListener(APP_TOAST_EVENT, handleToast);
    setIsListening(true);
    return () => {
      setIsListening(false);
      window.removeEventListener(APP_TOAST_EVENT, handleToast);
      // A shell can unmount mid-flight (navigation, sign-out). Leaving timers
      // armed would call setState on an unmounted tree.
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return (
    // The container never takes pointer events, so a toast that happens to sit
    // over a control only blocks the rectangle it actually occupies -- and it
    // is bottom-anchored and right-aligned from `sm` up, clear of the console's
    // primary actions. `w-[min(...)]` keeps it inside a 320px viewport.
    <div
      data-testid="app-toast-viewport"
      data-ready={isListening ? "true" : "false"}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[95] flex flex-col items-center gap-2 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] empty:hidden sm:items-end sm:px-6"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={appToastRole(toast.tone)}
          aria-live={appToastPoliteness(toast.tone)}
          data-testid="app-toast"
          data-tone={toast.tone}
          // `pointer-events-none` on the surface, `auto` on the dismiss button
          // only. A toast is bottom-anchored over a scrollable console, so on a
          // short viewport it can land on top of a control; letting clicks pass
          // straight through means it can never take one. Verified from each
          // control's own centre point with `elementFromPoint` in
          // tests/e2e/admin-narrow-width.spec.ts.
          className={`pointer-events-none flex w-[min(26rem,100%)] items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-2xl shadow-black/40 ${
            toast.tone === "success"
              ? "border-emerald-500/40 bg-emerald-950 text-emerald-50"
              : toast.tone === "error"
                ? "border-red-500/40 bg-red-950 text-red-50"
                : "border-zinc-700 bg-zinc-900 text-zinc-100"
          }`}
        >
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-xl ${
              toast.tone === "success"
                ? "bg-emerald-500/15 text-emerald-300"
                : toast.tone === "error"
                  ? "bg-red-500/15 text-red-300"
                  : "bg-blue-500/15 text-blue-300"
            }`}
          >
            {toast.tone === "success" ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            ) : toast.tone === "error" ? (
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Info className="h-4 w-4" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-line break-words">
            {toast.message}
          </span>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            aria-label={t("notifications.dismiss")}
            className="pointer-events-auto -mr-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-current opacity-70 transition hover:opacity-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
