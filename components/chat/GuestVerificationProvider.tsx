"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import {
  isLocalTurnstileBypassHost,
  loadTurnstile,
  type TurnstileWidgetSize,
} from "@/components/chat/turnstileScript";
import {
  GuestVerificationError,
  type GuestVerificationFailure,
  type GuestVerificationOutcome,
} from "@/components/chat/guestVerificationFailure";

/**
 * One guest-verification surface for the whole chat page.
 *
 * The problem this replaces: every ChatApp panel used to own its own Turnstile
 * widget, so whichever model happened to hit TURNSTILE_REQUIRED first showed a
 * Cloudflare checkbox *inside its own answer panel*, and two more background
 * widgets sat in `fixed bottom-2 right-2` containers for the quick-summary and
 * conversation-title endpoints. Verification is a property of the guest
 * session, not of a model panel, so it now lives here:
 *
 *  - exactly one widget can exist at a time, rendered into whichever host the
 *    active shell registered (the desktop rail slot, or the mobile bottom
 *    sheet) -- never inside a model panel;
 *  - requests are serialised, so two actions can never race for one widget;
 *  - tokens are action-bound and single-use, so each request gets its own;
 *  - guest chat keeps the "one panel verifies, the rest wait for its verified
 *    retry, then retry without a token" rule, now as an explicit coordinator
 *    instead of a module-global promise.
 *
 * Nothing here weakens the server side: the client still cannot decide that
 * verification passed. See lib/turnstile.ts.
 */

export type GuestVerificationAction =
  | "guest_chat"
  | "guest_quick_summary"
  // The two guest surfaces opened up alongside the chat itself. Both are
  // user-initiated and both cost real work server-side -- an 8-credit review
  // and a worker-isolated file parse -- so both go through the same challenge
  // the chat already uses rather than inventing an unverified entry point.
  | "guest_ai_review"
  | "guest_attachment";

export type GuestVerificationPhase =
  /** Nothing to verify. No verification UI exists anywhere. */
  | "idle"
  /** Turnstile is running; if it passes on its own the user never sees a thing. */
  | "verifying"
  /** Cloudflare asked for a real interaction: the widget is on screen. */
  | "interactive"
  | "succeeded"
  | "failed";

// Re-exported so existing importers keep working: the definitions themselves
// now live in guestVerificationFailure.ts, which the standalone-form Turnstile
// hook shares (see components/chat/useTurnstile.ts).
export {
  GuestVerificationError,
  type GuestVerificationFailure,
  type GuestVerificationOutcome,
};

/**
 * How long the script + widget get to become usable. This is a *loading*
 * budget, not a human one -- it is cleared the moment the widget renders.
 */
const WIDGET_READY_TIMEOUT_MS = 15_000;
/**
 * How long an automatic (no-interaction) pass gets. Cleared by
 * `before-interactive-callback`, so a person solving a challenge is never
 * cancelled out from under themselves; from that point Cloudflare's own
 * timeout-callback is what ends a stalled challenge.
 */
const SILENT_VERIFICATION_TIMEOUT_MS = 20_000;
/**
 * EXT-REAUDIT-F004. Once `before-interactive-callback` fires, the silent
 * timeout above is cleared on purpose -- a person part-way through a challenge
 * must never be cancelled out from under themselves -- and the app then waits
 * for Cloudflare's terminal callback. On a network that cannot reach
 * Cloudflare, that terminal callback took about 126 seconds to arrive, and the
 * UI said nothing at all for the whole of it.
 *
 * This timer changes nothing about that contract: it does not cancel the
 * challenge, does not touch the token, and does not shorten Cloudflare's own
 * timeout. It only makes the wait legible -- after this long the surface says
 * the check is taking longer than usual and points at the cancel control that
 * was always there. Kept well inside the 40s the audit asked for.
 */
const LONG_WAIT_NOTICE_MS = 25_000;
const SUCCESS_RESET_MS = 800;
/** A failure stays announced long enough to read, then clears itself. */
const FAILURE_RESET_MS = 12_000;

type PendingVerification = {
  id: number;
  action: GuestVerificationAction;
  resolve: (token: string) => void;
  reject: (error: GuestVerificationError) => void;
};

type GuestChatRequestOptions<T> = {
  /** Runs once real verification produced a token (or is not configured). */
  sendWithToken: (token: string | undefined) => Promise<T>;
  /**
   * Runs for the panels that waited: by then the winner's verified retry has
   * already set the server's grant cookie, so these must NOT spend a token.
   */
  sendAfterGrant: () => Promise<T>;
};

type GuestVerificationContextValue = {
  /** Guest session, site key present, and not a local bypass host. */
  isEnabled: boolean;
  /**
   * The site key this page actually resolved, exposed so a surface that owns
   * its own widget -- the feedback modal, which must host the challenge inside
   * its dialog rather than behind it -- uses the same request-time value
   * instead of the one compiled into the client bundle.
   */
  siteKey: string | undefined;
  phase: GuestVerificationPhase;
  failure: GuestVerificationFailure | null;
  lastOutcome: GuestVerificationOutcome | null;
  /** True while a challenge (or its error) should be on screen. */
  isChallengeVisible: boolean;
  /**
   * An interactive challenge has been on screen long enough that the user
   * deserves to be told it is slow. Never implies failure, and never ends the
   * challenge -- Cloudflare's terminal callback still decides the outcome.
   */
  isLongWait: boolean;
  requestToken: (
    action: GuestVerificationAction
  ) => Promise<string | undefined>;
  runGuestChatRequest: <T>(options: GuestChatRequestOptions<T>) => Promise<T>;
  cancel: () => void;
  /** Callback ref for the single element the widget is rendered into. */
  registerHost: (node: HTMLElement | null) => void;
  /** The size the active host can actually accommodate. */
  setHostSize: (size: TurnstileWidgetSize) => void;
};

const GuestVerificationContext =
  createContext<GuestVerificationContextValue | null>(null);

/** The bypass host never changes for the life of a document. */
const subscribeToNothing = () => () => {};
const getServerBypassSnapshot = () => false;

const isVisiblePhase = (
  phase: GuestVerificationPhase,
  failure: GuestVerificationFailure | null
) =>
  phase === "interactive" || (phase === "failed" && failure !== "cancelled");

export function GuestVerificationProvider({
  children,
  siteKey: siteKeyProp,
}: {
  children: ReactNode;
  /**
   * Resolved by the server component that renders this, so a deployment (or
   * the E2E server) can supply it at request time instead of depending on the
   * value that happened to be set when the client bundle was compiled. Falls
   * back to the build-time public variable.
   */
  siteKey?: string;
}) {
  const { data: session, status } = useSession();
  // Mirrors ChatPageClient's own derivation so the two can never disagree
  // about whether this tab is a guest.
  const isGuestMode = status !== "loading" && !session?.user?.id;
  const siteKey = siteKeyProp || process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  // Read through useSyncExternalStore rather than during render: the server
  // has no window, so it reports "not bypassed" and the client corrects it on
  // hydration instead of desynchronising the two.
  const isLocalBypass = useSyncExternalStore(
    subscribeToNothing,
    isLocalTurnstileBypassHost,
    getServerBypassSnapshot
  );

  const isEnabled = isGuestMode && Boolean(siteKey) && !isLocalBypass;

  const [phase, setPhase] = useState<GuestVerificationPhase>("idle");
  const [failure, setFailure] = useState<GuestVerificationFailure | null>(null);
  const [lastOutcome, setLastOutcome] =
    useState<GuestVerificationOutcome | null>(null);
  const [request, setRequest] = useState<{
    id: number;
    action: GuestVerificationAction;
  } | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [appliedSize, setAppliedSize] = useState<TurnstileWidgetSize>("normal");

  const requestedSizeRef = useRef<TurnstileWidgetSize>("normal");
  const pendingRef = useRef<PendingVerification | null>(null);
  const requestIdRef = useRef(0);
  const readyTimerRef = useRef<number | null>(null);
  const silentTimerRef = useRef<number | null>(null);
  /**
   * The request the long-wait notice has been armed for, rather than a bare
   * boolean: a replacement challenge (a shell swap, a second action) gets a
   * fresh id, so it can never inherit the previous request's notice.
   */
  const [longWaitRequestId, setLongWaitRequestId] = useState<number | null>(null);
  // Serialises every verification: a second action never opens a second
  // widget, it queues behind the first.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const guestChatVerificationRef = useRef<Promise<void> | null>(null);

  const clearTimers = useCallback(() => {
    if (readyTimerRef.current !== null) {
      window.clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
    if (silentTimerRef.current !== null) {
      window.clearTimeout(silentTimerRef.current);
      silentTimerRef.current = null;
    }
  }, []);

  /**
   * Terminal transition for one verification. Ignores late callbacks from a
   * widget that has already been settled or replaced, which is what keeps an
   * error arriving after success from resurrecting the UI.
   */
  const finish = useCallback(
    (
      id: number,
      result: { token?: string; failure?: GuestVerificationFailure }
    ) => {
      const pending = pendingRef.current;
      if (!pending || pending.id !== id) return;
      pendingRef.current = null;
      clearTimers();
      setRequest(null);

      if (result.token) {
        setFailure(null);
        setLastOutcome("succeeded");
        setPhase("succeeded");
        pending.resolve(result.token);
        return;
      }

      const kind = result.failure ?? "failed";
      setFailure(kind);
      setLastOutcome(kind);
      setPhase("failed");
      pending.reject(new GuestVerificationError(kind));
    },
    [clearTimers]
  );

  const startVerification = useCallback(
    (action: GuestVerificationAction) =>
      new Promise<string>((resolve, reject) => {
        requestIdRef.current += 1;
        const id = requestIdRef.current;
        pendingRef.current = { id, action, resolve, reject };
        setFailure(null);
        setPhase("verifying");
        setRequest({ id, action });
        readyTimerRef.current = window.setTimeout(() => {
          finish(id, { failure: "unavailable" });
        }, WIDGET_READY_TIMEOUT_MS);
      }),
    [finish]
  );

  const requestToken = useCallback(
    (action: GuestVerificationAction): Promise<string | undefined> => {
      if (!isEnabled) return Promise.resolve(undefined);
      const run = queueRef.current
        .then(
          () => startVerification(action),
          () => startVerification(action)
        );
      // The queue only tracks completion order, never the token itself.
      queueRef.current = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    [isEnabled, startVerification]
  );

  const runGuestChatRequest = useCallback(
    async <T,>({
      sendWithToken,
      sendAfterGrant,
    }: GuestChatRequestOptions<T>): Promise<T> => {
      const inFlight = guestChatVerificationRef.current;
      if (inFlight) {
        // Another panel is already running the challenge. Wait for its full
        // verified retry -- not just for the token -- because only a completed
        // retry proves the server issued the grant cookie this panel relies on.
        await inFlight.catch(() => {});
        return sendAfterGrant();
      }

      const verifyAndRetry = (async () => {
        const token = await requestToken("guest_chat");
        return sendWithToken(token);
      })();
      guestChatVerificationRef.current = verifyAndRetry.then(
        () => undefined,
        () => undefined
      );
      try {
        return await verifyAndRetry;
      } finally {
        guestChatVerificationRef.current = null;
      }
    },
    [requestToken]
  );

  const cancel = useCallback(() => {
    const pending = pendingRef.current;
    if (pending) {
      finish(pending.id, { failure: "cancelled" });
      return;
    }
    setPhase("idle");
    setFailure(null);
  }, [finish]);

  const registerHost = useCallback((node: HTMLElement | null) => {
    setHost((current) => {
      if (node) return node;
      // A detaching slot must not drop a host another slot has already
      // claimed -- React commits deletions before insertions, but a stale
      // cleanup should still be harmless.
      return current && current.isConnected ? current : null;
    });
  }, []);

  const setHostSize = useCallback((size: TurnstileWidgetSize) => {
    requestedSizeRef.current = size;
    setAppliedSize((current) => {
      // Re-sizing means re-rendering the widget, which would throw away a
      // challenge the user is in the middle of solving.
      if (pendingRef.current && current !== size) {
        return current;
      }
      return size;
    });
  }, []);

  // Adopt a size that was requested while a challenge was on screen.
  useEffect(() => {
    if (phase === "verifying" || phase === "interactive") return;
    setAppliedSize((current) =>
      current === requestedSizeRef.current ? current : requestedSizeRef.current
    );
  }, [phase]);

  // The single widget. Keyed on the active request and the host it belongs to,
  // so a shell swap (desktop <-> mobile) or a slot move tears the old widget
  // down and re-runs the challenge in the new place rather than leaving an
  // orphan behind or stalling the caller's promise.
  useEffect(() => {
    if (!request || !host || !siteKey) return;

    const requestId = request.id;
    let cancelled = false;
    let widgetId: string | null = null;

    void loadTurnstile()
      .then(() => {
        if (cancelled) return;
        const api = window.turnstile;
        if (!api) {
          finish(requestId, { failure: "unavailable" });
          return;
        }

        // A re-run means the host moved (a shell swap, or the rail appearing):
        // the replacement widget starts from the silent phase again rather
        // than inheriting the previous one's "interactive" surface.
        setPhase((current) => (current === "interactive" ? "verifying" : current));

        widgetId = api.render(host, {
          sitekey: siteKey,
          action: request.action,
          execution: "execute",
          appearance: "interaction-only",
          theme: "auto",
          size: appliedSize,
          "response-field": false,
          callback: (token: string) => finish(requestId, { token }),
          "before-interactive-callback": () => {
            if (silentTimerRef.current !== null) {
              window.clearTimeout(silentTimerRef.current);
              silentTimerRef.current = null;
            }
            setPhase((current) =>
              current === "verifying" ? "interactive" : current
            );
          },
          "after-interactive-callback": () => {
            // The challenge surface stays up until a terminal callback; this
            // hook exists so Cloudflare's lifecycle is fully accounted for.
          },
          "error-callback": () => finish(requestId, { failure: "failed" }),
          "expired-callback": () => finish(requestId, { failure: "expired" }),
          "timeout-callback": () => finish(requestId, { failure: "timeout" }),
          "unsupported-callback": () =>
            finish(requestId, { failure: "unavailable" }),
        });

        if (readyTimerRef.current !== null) {
          window.clearTimeout(readyTimerRef.current);
          readyTimerRef.current = null;
        }
        silentTimerRef.current = window.setTimeout(() => {
          finish(requestId, { failure: "timeout" });
        }, SILENT_VERIFICATION_TIMEOUT_MS);

        api.execute(widgetId);
      })
      .catch(() => {
        if (cancelled) return;
        finish(requestId, { failure: "unavailable" });
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // Already removed by Cloudflare; nothing left to clean up.
        }
      }
    };
  }, [appliedSize, finish, host, request, siteKey]);

  // Success leaves no UI behind; a failure stays readable for a while and then
  // clears itself, so no error can strand the rail or the sheet permanently.
  useEffect(() => {
    if (phase !== "succeeded" && phase !== "failed") return;
    const timer = window.setTimeout(
      () => {
        setPhase("idle");
        setFailure(null);
      },
      phase === "succeeded" ? SUCCESS_RESET_MS : FAILURE_RESET_MS
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  // EXT-REAUDIT-F004: purely an announcement timer. It starts when Cloudflare
  // puts a real challenge on screen and is torn down the moment the phase
  // changes -- so a solved, cancelled, failed or re-run challenge clears it,
  // and it can never outlive the surface it describes.
  useEffect(() => {
    if (phase !== "interactive" || !request) return;
    const armedFor = request.id;
    const timer = window.setTimeout(
      () => setLongWaitRequestId(armedFor),
      LONG_WAIT_NOTICE_MS
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [phase, request]);

  // Leaving the chat page mid-challenge must not strand an awaiting caller.
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (readyTimerRef.current !== null) {
        window.clearTimeout(readyTimerRef.current);
      }
      if (silentTimerRef.current !== null) {
        window.clearTimeout(silentTimerRef.current);
      }
      pending?.reject(new GuestVerificationError("cancelled"));
    },
    []
  );

  const value = useMemo<GuestVerificationContextValue>(
    () => ({
      isEnabled,
      siteKey,
      phase,
      failure,
      lastOutcome,
      isChallengeVisible: isEnabled && isVisiblePhase(phase, failure),
      isLongWait:
        isEnabled &&
        phase === "interactive" &&
        longWaitRequestId !== null &&
        longWaitRequestId === request?.id,
      requestToken,
      runGuestChatRequest,
      cancel,
      registerHost,
      setHostSize,
    }),
    [
      cancel,
      failure,
      isEnabled,
      siteKey,
      longWaitRequestId,
      lastOutcome,
      phase,
      request,
      registerHost,
      requestToken,
      runGuestChatRequest,
      setHostSize,
    ]
  );

  return (
    <GuestVerificationContext.Provider value={value}>
      {children}
    </GuestVerificationContext.Provider>
  );
}

/**
 * Falls back to a disabled coordinator when no provider is mounted, so a
 * component tree rendered outside the chat page (tests, storybook-style
 * harnesses) behaves exactly like a signed-in user: no widget, no token.
 */
const DISABLED_VALUE: GuestVerificationContextValue = {
  isEnabled: false,
  siteKey: undefined,
  phase: "idle",
  failure: null,
  lastOutcome: null,
  isChallengeVisible: false,
  isLongWait: false,
  requestToken: () => Promise.resolve(undefined),
  runGuestChatRequest: ({ sendWithToken }) => sendWithToken(undefined),
  cancel: () => {},
  registerHost: () => {},
  setHostSize: () => {},
};

export function useGuestVerification(): GuestVerificationContextValue {
  return useContext(GuestVerificationContext) ?? DISABLED_VALUE;
}
