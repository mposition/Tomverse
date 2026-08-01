"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isLocalTurnstileBypassHost,
  loadTurnstile,
} from "@/components/chat/turnstileScript";
import {
  GuestVerificationError,
  type GuestVerificationFailure,
} from "@/components/chat/guestVerificationFailure";

/**
 * The standalone-form Turnstile hook: one widget, owned by one form, rendered
 * wherever that form puts its container (sign-in, support request, the chat
 * feedback modal).
 *
 * The chat page's *message* flow does NOT use this. A chat shell has several
 * model panels and several guest-only endpoints sharing one verification
 * surface, so it goes through GuestVerificationProvider instead -- see
 * components/chat/GuestVerificationProvider.tsx. What the two share is their
 * vocabulary: both settle into a `GuestVerificationFailure`, and both render it
 * through guestVerificationCopy.ts, so no surface can invent its own wording
 * for a cancelled, expired or unavailable check.
 *
 * `phase` exists because a form has to *show* the widget when Cloudflare asks
 * for a real interaction. A `display: none` container cannot host a challenge,
 * so callers keep the container mounted at all times and use
 * `isChallengeVisible` to decide whether it takes up space.
 *
 * `siteKeyOverride` exists for the same reason GuestVerificationProvider takes
 * one: NEXT_PUBLIC_* is inlined when the client bundle is compiled, so a
 * deployment (or the E2E server) that supplies the key at request time has no
 * way to reach a hook that reads `process.env` directly. Callers inside the
 * chat page pass the value the page resolved; everyone else falls back to the
 * build-time variable, exactly as before.
 */

export type TurnstileFormPhase =
  /** Nothing to verify. */
  | "idle"
  /** Running; if it passes on its own the user never sees a thing. */
  | "verifying"
  /** Cloudflare asked for a real interaction: the widget must be on screen. */
  | "interactive"
  | "succeeded"
  | "failed";

/** How long the script and widget get to become usable. */
const WIDGET_READY_TIMEOUT_MS = 10_000;
/** How long an automatic (no-interaction) pass gets before it is given up on. */
const SILENT_VERIFICATION_TIMEOUT_MS = 20_000;

export function useTurnstile(
  enabled: boolean,
  action = "guest_chat",
  siteKeyOverride?: string
) {
  const siteKey = siteKeyOverride || process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const pendingRef = useRef<{
    resolve: (token: string) => void;
    reject: (error: GuestVerificationError) => void;
  } | null>(null);
  const silentTimerRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<TurnstileFormPhase>("idle");
  const [failure, setFailure] = useState<GuestVerificationFailure | null>(null);

  const clearSilentTimer = useCallback(() => {
    if (silentTimerRef.current !== null) {
      window.clearTimeout(silentTimerRef.current);
      silentTimerRef.current = null;
    }
  }, []);

  /** Terminal transition. A callback for an already-settled run is ignored. */
  const settle = useCallback(
    (result: { token?: string; failure?: GuestVerificationFailure }) => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      clearSilentTimer();

      if (result.token) {
        setFailure(null);
        setPhase("succeeded");
        pending?.resolve(result.token);
        return;
      }
      const kind = result.failure ?? "failed";
      setFailure(kind);
      setPhase("failed");
      pending?.reject(new GuestVerificationError(kind));
    },
    [clearSilentTimer]
  );

  useEffect(() => {
    if (!enabled || !siteKey || isLocalTurnstileBypassHost()) return;
    let cancelled = false;

    void loadTurnstile()
      .then(() => {
        if (
          cancelled ||
          !window.turnstile ||
          !containerRef.current ||
          widgetIdRef.current
        ) {
          return;
        }
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          execution: "execute",
          appearance: "interaction-only",
          theme: "auto",
          "response-field": false,
          callback: (token: string) => settle({ token }),
          "before-interactive-callback": () => {
            // Someone solving a challenge must never be cancelled out from
            // under themselves, so the silent budget stops here and
            // Cloudflare's own terminal callbacks take over.
            clearSilentTimer();
            setPhase((current) =>
              current === "verifying" ? "interactive" : current
            );
          },
          "error-callback": () => settle({ failure: "failed" }),
          "expired-callback": () => settle({ failure: "expired" }),
          "timeout-callback": () => settle({ failure: "timeout" }),
          "unsupported-callback": () => settle({ failure: "unavailable" }),
        });
      })
      .catch(() => {
        if (cancelled) return;
        settle({ failure: "unavailable" });
      });

    return () => {
      cancelled = true;
      clearSilentTimer();
      const pending = pendingRef.current;
      pendingRef.current = null;
      pending?.reject(new GuestVerificationError("cancelled"));
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Already removed by Cloudflare; nothing left to clean up.
        }
      }
      widgetIdRef.current = null;
    };
  }, [action, clearSilentTimer, enabled, settle, siteKey]);

  /** Ends the challenge on screen at the user's request. */
  const cancel = useCallback(() => {
    if (!pendingRef.current) {
      setPhase("idle");
      setFailure(null);
      return;
    }
    settle({ failure: "cancelled" });
  }, [settle]);

  const getToken = useCallback(async () => {
    if (!enabled) return undefined;
    if (isLocalTurnstileBypassHost()) return undefined;
    if (!siteKey) {
      if (process.env.NODE_ENV !== "production") return undefined;
      throw new GuestVerificationError("unavailable");
    }

    setFailure(null);
    setPhase("verifying");

    const deadline = Date.now() + WIDGET_READY_TIMEOUT_MS;
    while (!widgetIdRef.current || !window.turnstile) {
      if (Date.now() >= deadline) {
        settle({ failure: "unavailable" });
        throw new GuestVerificationError("unavailable");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return await new Promise<string>((resolve, reject) => {
      pendingRef.current = { resolve, reject };
      silentTimerRef.current = window.setTimeout(() => {
        settle({ failure: "timeout" });
      }, SILENT_VERIFICATION_TIMEOUT_MS);
      window.turnstile!.reset(widgetIdRef.current!);
      window.turnstile!.execute(widgetIdRef.current!);
    });
  }, [enabled, settle, siteKey]);

  return {
    containerRef,
    getToken,
    cancel,
    phase,
    failure,
    /** True while a real challenge (or its error) belongs on screen. */
    isChallengeVisible:
      enabled &&
      (phase === "interactive" ||
        (phase === "failed" && failure !== "cancelled")),
  };
}
