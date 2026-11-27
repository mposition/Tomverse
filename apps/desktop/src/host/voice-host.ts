import type { VoiceBody, VoiceReply, VoiceRequestInput, VoiceStreamEvent } from "../voice-contract";

const MAX_LIVE_REQUESTS = 8;
const MAX_REPLY_CHARACTERS = 64_000;
/** How long a press of Start stays good: first to open the microphone, then to send the session's start. */
const PRESS_SECONDS = 15;
const refused = (code: string, status = 403): VoiceReply => ({ status, body: JSON.stringify({ code }) });

/**
 * The Chat voice conversation's side of the main process. The sign-in token never reaches the window: the window
 * hands over one of the server's five voice actions, this sends it, and a session's event stream is passed back
 * piece by piece. A session is paid by the minute, so it starts only behind a fresh press of Start, and this
 * process ends it itself when the computer sleeps, the window closes or the account goes.
 */
export function createVoiceHost(deps: {
  /** A signed-in account on a server that offers the voice conversation, and the computer is awake. */
  allowed(): boolean;
  /** Sends one action with the account's token. It rejects when there is no account or the account changed. */
  send(body: VoiceBody, signal: AbortSignal): Promise<Response>;
  emit(event: VoiceStreamEvent): void;
  /** Tells the window to end its session (sign-out, sleep, the server withdrew the feature). */
  notifyStop(): void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let grant: { expiry: number; microphone: boolean } | undefined;
  let session: { id: string; reservation?: string } | undefined;
  const live = new Map<string, AbortController>();
  const fresh = () => Boolean(grant && now() < grant.expiry);

  async function pump(id: string, response: Response, controller: AbortController) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let head = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        // The session's own name, from its first event: it is what this process ends the session by.
        if (session?.id === id && !session.reservation && head.length < 16_000) {
          head += chunk;
          const named = /"reservationId"\s*:\s*"([A-Za-z0-9_:.-]{1,200})"/.exec(head);
          if (named) session.reservation = named[1];
        }
        deps.emit({ id, chunk });
      }
      deps.emit({ id, end: "done" });
    } catch {
      deps.emit({ id, end: "error" });
    } finally {
      reader.releaseLock();
      if (live.get(id) === controller) live.delete(id);
      if (session?.id === id) session = undefined;
    }
  }

  return {
    /** The person pressed Start: the next microphone request from the main window is theirs, for a few seconds. */
    arm() {
      if (!deps.allowed() || session) return false;
      grant = { expiry: now() + PRESS_SECONDS * 1_000, microphone: false };
      return true;
    },
    /** The press led nowhere (the window closed the conversation, or it failed): it starts nothing later. */
    disarm() { grant = undefined; },
    mayOpenMicrophone: () => Boolean(deps.allowed() && grant && !grant.microphone && fresh()),
    microphoneOpened() {
      if (!grant) return;
      grant.microphone = true;
      grant.expiry = now() + PRESS_SECONDS * 1_000;
    },
    /** Whether a session's event stream is open. */
    active: () => session !== undefined,

    async request({ id, body }: VoiceRequestInput): Promise<VoiceReply> {
      // Ending a session and reading what it cost stay possible after the feature is withdrawn, as on the server.
      if (body.action !== "stop" && body.action !== "status" && !deps.allowed()) return refused("VOICE_CONVERSATION_DISABLED", 503);
      if (body.action === "start") {
        // A session starts only behind the microphone the person just opened for it, once, and one at a time.
        const pressed = Boolean(grant?.microphone && fresh());
        grant = undefined;
        if (!pressed || session) return refused("VOICE_SESSION_REFUSED");
        session = { id };
      }
      if (live.has(id) || live.size >= MAX_LIVE_REQUESTS) {
        if (session?.id === id) session = undefined;
        return refused("VOICE_RATE_LIMITED", 429);
      }
      const controller = new AbortController();
      live.set(id, controller);
      let streaming = false;
      try {
        const response = await deps.send(body, controller.signal);
        if (response.ok && response.body && body.action === "start" &&
            (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
          streaming = true;
          void pump(id, response, controller);
          return { status: response.status, stream: true };
        }
        return { status: response.status, body: (await response.text()).slice(0, MAX_REPLY_CHARACTERS) };
      } catch {
        return { status: 0 };
      } finally {
        if (!streaming) {
          if (live.get(id) === controller) live.delete(id);
          if (session?.id === id) session = undefined;
        }
      }
    },
    abort(id: string) { live.get(id)?.abort(); },
    /** The server no longer offers the conversation: the window is told, and ends its own session in the ordinary way. */
    withdraw() {
      const had = grant !== undefined || live.size > 0;
      grant = undefined;
      if (had) deps.notifyStop();
    },
    /**
     * Ends the session from this process, without waiting for the window: for sleep, a closing window, quitting and
     * an account that is going, where the window may never get to act. The open requests are closed at once, and the
     * server is asked to stop the session. It resolves when the server has answered, or after three seconds, so the
     * caller can hold a sign-out or a quit until then. `send` is for a sign-out, whose token is about to go.
     */
    async end(send: (body: VoiceBody, signal: AbortSignal) => Promise<Response> = deps.send) {
      const had = grant !== undefined || live.size > 0;
      grant = undefined;
      const reservation = session?.reservation;
      session = undefined;
      const asked = reservation
        ? send({ action: "stop", reservationId: reservation }, AbortSignal.timeout(3_000))
          .then((response) => response.body?.cancel()).catch(() => { /* The closed stream ends it on the server as well. */ })
        : undefined;
      for (const controller of live.values()) controller.abort();
      if (had) deps.notifyStop();
      await asked;
    },
  };
}
