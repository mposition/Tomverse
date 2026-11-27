/**
 * How long a chat request may stay silent before the client gives up on it,
 * and what that silence is called when it does.
 *
 * ## The failure this replaces
 *
 * `components/chat/ChatApp.tsx` used to hold one 90s timer, armed before
 * `fetch` and reset by the response headers and by every body chunk. Three
 * different waits shared it:
 *
 *   * the server reading and extracting an attachment (a PPTX is parsed
 *     before the provider is called at all, so it lands entirely inside the
 *     pre-header window),
 *   * the provider's time to its first visible token -- which for
 *     `claude-fable-5` is adaptive thinking at `effort: "high"`
 *     (lib/modelGenerationCompatibility.ts), i.e. minutes of legitimate work
 *     with nothing on the wire, and
 *   * a genuinely stalled stream.
 *
 * When that timer fired it called `controller.abort()`, which is the same
 * `AbortError` the stop button raises, so a model that was still thinking was
 * reported to the user as "Response generation was stopped." -- a sentence
 * about something the user did.
 *
 * Raising the number again is not the fix and is explicitly out of bounds: the
 * previous change already took it from 30s to 90s, and any single number has
 * to be simultaneously longer than the slowest honest first token and shorter
 * than the shortest stall worth ending. Those are different budgets, so this
 * module makes them different budgets.
 *
 * ## The three phases
 *
 *   `pre_headers`   fetch issued, response headers not yet seen. Server-side
 *                   admission, attachment extraction and provider dispatch.
 *   `first_response` headers seen, no visible token yet. The provider is
 *                   thinking.
 *   `mid_stream`    at least one visible token has arrived.
 *
 * `pre_headers` and `first_response` share **one absolute deadline measured
 * from the moment the request was issued** (`firstResponseMs`). They are not
 * given a budget each: a client cannot tell "the server is still extracting a
 * deck" from "the provider is still thinking" -- both are the same wait from
 * the user's side -- and two chained budgets would silently double the worst
 * case. Headers move the phase (which is what the diagnostics record) and
 * deliberately do not extend the deadline.
 *
 * ## Silence once the headers are in
 *
 * From the headers on, a second watchdog measures *silence*: time with
 * neither visible text nor a server keepalive (nor any other out-of-band
 * chunk) on the wire. `idleMs` is that budget, stretched to
 * `CHAT_LIVENESS_MISSED_KEEPALIVES` server intervals when the server says its
 * interval is longer. It applies in `first_response` and `mid_stream` alike:
 * a server that has stopped writing is a dead connection whether or not the
 * answer had started, and waiting out the absolute ten-minute deadline to
 * notice one is what made a dropped connection before the first token look
 * like a model that was still thinking.
 *
 * Before this, `mid_stream` counted only visible text. A turn that wrote a
 * preamble and then spent two minutes writing a tool input (a document
 * specification) or reasoning between tool steps was ended as idle while the
 * provider was working. The server now keeps writing keepalives after the
 * first token -- but only while the provider stream is delivering parts, see
 * lib/chatStreamKeepalive.ts -- and those reset the silence clock.
 *
 * ## Why keepalives still do not extend the first-response deadline
 *
 * The server sends out-of-band keepalive chunks while it waits for the
 * provider's first token (lib/chatStreamKeepalive.ts), because the deployment
 * sits behind a proxy whose read timeout is far shorter than this budget.
 * Before the first token those chunks are written on a timer, so they prove
 * the transport is alive and say nothing about the provider. If they reset
 * the absolute deadline, a provider that has permanently stopped would be
 * hidden for as long as the server kept writing them -- which is the one
 * thing a keepalive must never buy. So they feed only the silence watchdog,
 * and the absolute deadline stands.
 *
 * Everything here is pure: no timers of its own, no `Date`, no DOM. The
 * watchdog takes its clock and its scheduler as arguments so a test can drive
 * ten minutes in a millisecond.
 */

/**
 * Why an in-flight chat request was aborted.
 *
 * Recorded per run rather than in a module-level boolean: three panels stream
 * at once in a comparison, and a shared flag would let one panel's timeout
 * describe another panel's stop. It is stored beside the `AbortController`
 * itself, in `lib/chatStreamRuntime.ts`, because that is where the controller
 * lives -- a panel that remounts adopts the run that is already going, and it
 * has to adopt the reason with it.
 */
export type ChatAbortCause =
  /** The per-panel "stop this response" button. */
  | "user_stop"
  /** The shell's "stop all responses" button. */
  | "user_stop_all"
  /** No visible token inside `firstResponseMs`. */
  | "first_response_timeout"
  /** Headers arrived, then nothing at all -- no text, no keepalive -- for the silence budget. */
  | "stream_idle_timeout"
  /**
   * The tab moved into another identity namespace -- signing in, signing out,
   * switching accounts -- and runs started under the previous one were
   * dropped (docs/policy/chat-concurrency-and-identity.md §5).
   */
  | "identity_released";

export type ChatLivenessPhase = "pre_headers" | "first_response" | "mid_stream";

export type ChatTimeoutErrorCode =
  | "CHAT_FIRST_RESPONSE_TIMEOUT"
  | "CHAT_STREAM_IDLE_TIMEOUT";

/** The timeout cause each error code belongs to, and nothing else. */
export const CHAT_TIMEOUT_ERROR_CODES = {
  first_response_timeout: "CHAT_FIRST_RESPONSE_TIMEOUT",
  stream_idle_timeout: "CHAT_STREAM_IDLE_TIMEOUT",
} as const satisfies Record<string, ChatTimeoutErrorCode>;

/**
 * How often the server writes a keepalive chunk while no token has been seen.
 *
 * The constraint is Cloudflare, which fronts this deployment's origin on
 * Railway. Its Proxy Read Timeout is 125 seconds by default and is adjustable
 * only on Enterprise zones; an origin that sends nothing for longer gets the
 * connection closed with a 524. docs/policy/image-generation.md section 7
 * records the same limit -- it is why image generation is claim-based rather
 * than a synchronous handler.
 *
 * 20s leaves room for several consecutive lost or delayed writes before that
 * limit is approached, and is small enough that the interval itself never
 * becomes the thing being measured. Nothing else in the chain binds sooner:
 * Cloudflare's Proxy Idle Timeout is 900s, and a stream written to every 20s
 * is never idle.
 */
export const CHAT_STREAM_KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * When the server stops waiting for a provider's first token.
 *
 * app/api/chat/route.ts renews its own concurrency lease on a heartbeat
 * precisely so that "a legit ten-minute answer is as safe as a ten-second
 * one". A server-side deadline shorter than that would contradict the
 * lifetime the lease was designed to permit, so this sits just inside ten
 * minutes rather than under it.
 */
export const CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS = 540_000;

/**
 * The grace the client leaves the server to end a stall on its own terms.
 *
 * The server's deadline has cleanup attached -- cancel the provider reader,
 * settle the reservation, release the lease, discard artifacts -- and it
 * announces the outcome in the stream so the client can label it. The client
 * bound has to sit *behind* that, or it would abort the connection first and
 * the classified answer would never arrive. One minute covers the settlement
 * transaction and the write.
 */
export const CHAT_CLIENT_FIRST_RESPONSE_GRACE_MS = 60_000;

export type ChatLivenessBudgets = {
  /**
   * Request issued -> first visible token. Absolute: headers and keepalives
   * move the phase, never the deadline.
   */
  firstResponseMs: number;
  /**
   * Headers seen -> the longest silence allowed: no visible chunk and no
   * keepalive. The floor of the silence budget; see
   * `CHAT_LIVENESS_MISSED_KEEPALIVES`.
   */
  idleMs: number;
};

/**
 * How many consecutive server keepalive intervals may go missing before the
 * connection is called dead, when the server reports an interval long enough
 * for that to exceed `idleMs`. At the default 20s interval the 90s floor is
 * the larger of the two and decides.
 */
export const CHAT_LIVENESS_MISSED_KEEPALIVES = 3;

/**
 * Bytes buffered while a page was frozen are delivered when it wakes, and the
 * order of that delivery against a late timer is not specified. A silence
 * verdict reached on a clock that jumped (a backgrounded tab, a locked phone)
 * waits this long for those bytes before it is acted on.
 */
export const CHAT_LIVENESS_RESUME_GRACE_MS = 3_000;
/** How late a timer has to fire to count as the page having been suspended. */
const SUSPENDED_TIMER_LATENESS_MS = 5_000;

export const CHAT_LIVENESS_BUDGETS: ChatLivenessBudgets = {
  firstResponseMs:
    CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS + CHAT_CLIENT_FIRST_RESPONSE_GRACE_MS,
  /**
   * Unchanged from the timer this replaces, and deliberately below the 125s
   * proxy read timeout above: a stall should be ended by this app, with this
   * app's own wording and this app's own trace, rather than by an edge that
   * can only produce a broken connection. At the server's 20s keepalive
   * interval this is four missed keepalives.
   */
  idleMs: 90_000,
};

/**
 * What an abort means once it has happened.
 *
 * A stop is a `cancelled` message and keeps the copy it always had. A timeout
 * is an error with its own code, because the two are different events and the
 * old code reported both as the first one.
 */
export type ChatAbortOutcome =
  | { kind: "cancelled" }
  | { kind: "timeout"; errorCode: ChatTimeoutErrorCode };

/**
 * `null` -- an abort with no recorded cause -- classifies as a stop.
 *
 * That is the conservative direction. An abort this app did not raise (a
 * navigation, a browser tearing down the fetch) is far closer to "the user
 * left" than to "the model stalled", and reporting it as a timeout would put
 * a diagnosable-looking error code on something nothing here diagnosed.
 */
export const classifyChatAbort = (
  cause: ChatAbortCause | null | undefined
): ChatAbortOutcome => {
  if (cause === "first_response_timeout" || cause === "stream_idle_timeout") {
    return { kind: "timeout", errorCode: CHAT_TIMEOUT_ERROR_CODES[cause] };
  }
  return { kind: "cancelled" };
};

/** True for the codes this module owns, so a caller can switch on one place. */
export const isChatTimeoutErrorCode = (
  code: string
): code is ChatTimeoutErrorCode =>
  code === "CHAT_FIRST_RESPONSE_TIMEOUT" || code === "CHAT_STREAM_IDLE_TIMEOUT";

/* -------------------------------------------------------------------------- */
/* The watchdog                                                                */
/* -------------------------------------------------------------------------- */

export type ChatLivenessTimers = {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
};

/** The browser's own, as a default so callers do not have to pass one. */
export const browserLivenessTimers: ChatLivenessTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type ChatLivenessExpiry = {
  cause: Extract<
    ChatAbortCause,
    "first_response_timeout" | "stream_idle_timeout"
  >;
  /** Where the request was when it ran out of budget. */
  phase: ChatLivenessPhase;
  /** Since the request was issued. */
  elapsedMs: number;
  /**
   * For `stream_idle_timeout`, the silence that ended it: since the last
   * thing the server wrote. For `first_response_timeout`, equal to
   * `elapsedMs`, because nothing visible has happened yet.
   */
  idleMs: number;
};

export type ChatLivenessSnapshot = {
  phase: ChatLivenessPhase;
  elapsedMs: number;
  idleMs: number;
  /** Keepalive chunks seen. Diagnostics only -- never a deadline input. */
  keepalives: number;
  stopped: boolean;
};

export type ChatLivenessWatchdog = {
  /** Response headers arrived: `pre_headers` -> `first_response`. */
  noteHeaders: () => void;
  /**
   * A server keepalive arrived. Resets the silence clock and never the
   * absolute first-response deadline -- see the module comment. The
   * interval, when the server reported one, sizes the silence budget.
   */
  noteKeepalive: (serverIntervalMs?: number) => void;
  /**
   * Any other out-of-band chunk the server wrote (a routing notice, a
   * progress marker, the trailer). The server is writing, so the silence
   * clock resets; nothing visible happened, so the phase does not move.
   */
  noteServerSignal: () => void;
  /**
   * A chunk the user can actually see. The first one enters `mid_stream`;
   * every one resets the silence clock.
   */
  noteVisibleChunk: () => void;
  /**
   * The page came back (visible again, or back online). Timers in a frozen
   * page fire late or not at all, so the deadlines are checked against the
   * clock now; a silence verdict still waits
   * `CHAT_LIVENESS_RESUME_GRACE_MS` for bytes buffered while suspended.
   */
  checkNow: () => void;
  /**
   * The request settled (or handed itself to a poller). Cancels the pending
   * timer; the watchdog can never fire afterwards.
   */
  stop: () => void;
  snapshot: () => ChatLivenessSnapshot;
};

export const createChatLivenessWatchdog = (input: {
  onExpire: (expiry: ChatLivenessExpiry) => void;
  budgets?: ChatLivenessBudgets;
  timers?: ChatLivenessTimers;
}): ChatLivenessWatchdog => {
  const budgets = input.budgets ?? CHAT_LIVENESS_BUDGETS;
  const timers = input.timers ?? browserLivenessTimers;

  const startedAt = timers.now();
  let phase: ChatLivenessPhase = "pre_headers";
  let lastVisibleAt = startedAt;
  // The last thing the server wrote: headers, a keepalive, any chunk.
  let lastSignalAt = startedAt;
  let silenceBudgetMs = budgets.idleMs;
  // Set while a silence verdict waits out the resume grace. Any server signal
  // clears it, which is the point of waiting.
  let graceUntil: number | null = null;
  let keepalives = 0;
  let stopped = false;
  let handle: unknown = null;
  let dueAt = 0;

  const clear = () => {
    if (handle === null) return;
    timers.clearTimeout(handle);
    handle = null;
  };

  const expire = (
    cause: ChatLivenessExpiry["cause"],
    referenceAt: number
  ) => {
    if (stopped) return;
    stopped = true;
    clear();
    const now = timers.now();
    input.onExpire({
      cause,
      phase,
      elapsedMs: now - startedAt,
      idleMs: now - referenceAt,
    });
  };

  /*
    One timer for whichever deadline is nearer.

    The first-response deadline is measured from the start, not from now: it
    is absolute, and re-arming it with the full budget on every phase change
    is exactly the chained-budget mistake the module comment rules out. The
    silence deadline is measured from the last server signal, and exists only
    once there could have been one.
  */
  const firstResponseDueAt = () =>
    phase === "mid_stream" ? Infinity : startedAt + budgets.firstResponseMs;
  const silenceDueAt = () =>
    phase === "pre_headers"
      ? Infinity
      : (graceUntil ?? lastSignalAt + silenceBudgetMs);

  const arm = () => {
    clear();
    if (stopped) return;
    dueAt = Math.min(firstResponseDueAt(), silenceDueAt());
    if (!Number.isFinite(dueAt)) return;
    handle = timers.setTimeout(
      () => evaluate(false),
      Math.max(0, dueAt - timers.now())
    );
  };

  const evaluate = (resumed: boolean) => {
    handle = null;
    if (stopped) return;
    const now = timers.now();
    if (now >= firstResponseDueAt()) {
      expire("first_response_timeout", startedAt);
      return;
    }
    if (now >= lastSignalAt + silenceBudgetMs && phase !== "pre_headers") {
      const suspended =
        resumed || now - dueAt > SUSPENDED_TIMER_LATENESS_MS;
      if (graceUntil === null && suspended) {
        // The clock jumped. Whatever the server wrote meanwhile may still be
        // in the socket's buffer, about to be read.
        graceUntil = now + CHAT_LIVENESS_RESUME_GRACE_MS;
      } else if (graceUntil === null || now >= graceUntil) {
        expire("stream_idle_timeout", lastSignalAt);
        return;
      }
    }
    arm();
  };

  const noteSignal = () => {
    lastSignalAt = timers.now();
    graceUntil = null;
    arm();
  };

  arm();

  return {
    noteHeaders: () => {
      if (stopped || phase !== "pre_headers") return;
      phase = "first_response";
      noteSignal();
    },
    noteKeepalive: (serverIntervalMs?: number) => {
      if (stopped) return;
      keepalives += 1;
      if (
        typeof serverIntervalMs === "number" &&
        Number.isFinite(serverIntervalMs) &&
        serverIntervalMs > 0
      ) {
        silenceBudgetMs = Math.max(
          budgets.idleMs,
          CHAT_LIVENESS_MISSED_KEEPALIVES * serverIntervalMs
        );
      }
      noteSignal();
    },
    noteServerSignal: () => {
      if (stopped) return;
      noteSignal();
    },
    noteVisibleChunk: () => {
      if (stopped) return;
      phase = "mid_stream";
      lastVisibleAt = timers.now();
      noteSignal();
    },
    checkNow: () => {
      if (stopped) return;
      clear();
      evaluate(true);
    },
    stop: () => {
      stopped = true;
      clear();
    },
    snapshot: () => {
      const now = timers.now();
      return {
        phase,
        elapsedMs: now - startedAt,
        idleMs: now - lastVisibleAt,
        keepalives,
        stopped,
      };
    },
  };
};
