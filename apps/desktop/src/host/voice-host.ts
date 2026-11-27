import type { VoiceBody, VoiceReply, VoiceRequestInput, VoiceStreamEvent } from "../voice-contract";

const MAX_LIVE_REQUESTS = 8;
const MAX_REPLY_CHARACTERS = 64_000;
const refused = (code: string, status = 403): VoiceReply => ({ status, body: JSON.stringify({ code }) });

/**
 * The Chat voice conversation's side of the main process. The sign-in token never reaches the window: the window
 * hands over one of the server's five voice actions, this sends it, and a session's event stream is passed back
 * piece by piece. The microphone is opened once per press of Start, for the main window only.
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
  let session: string | undefined;
  const live = new Map<string, AbortController>();

  async function pump(id: string, response: Response, controller: AbortController) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) deps.emit({ id, chunk });
      }
      deps.emit({ id, end: "done" });
    } catch {
      deps.emit({ id, end: "error" });
    } finally {
      reader.releaseLock();
      if (live.get(id) === controller) live.delete(id);
      if (session === id) session = undefined;
    }
  }

  return {
    /** The person pressed Start: the next microphone request from the main window is theirs, for a few seconds. */
    arm() {
      if (!deps.allowed() || session) return false;
      grant = { expiry: now() + 15_000, microphone: false };
      return true;
    },
    mayOpenMicrophone: () => Boolean(deps.allowed() && grant && !grant.microphone && now() < grant.expiry),
    microphoneOpened() { if (grant) grant.microphone = true; },
    /** Whether a session's event stream is open. */
    active: () => session !== undefined,

    async request({ id, body }: VoiceRequestInput): Promise<VoiceReply> {
      // Ending a session and reading what it cost stay possible after the feature is withdrawn, as on the server.
      if (body.action !== "stop" && body.action !== "status" && !deps.allowed()) return refused("VOICE_CONVERSATION_DISABLED", 503);
      if (body.action === "start") {
        // A session starts only behind the microphone the person opened for it, and one at a time.
        if (!grant?.microphone || session) return refused("VOICE_SESSION_REFUSED");
        grant = undefined;
        session = id;
      }
      if (live.has(id) || live.size >= MAX_LIVE_REQUESTS) {
        if (session === id) session = undefined;
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
          if (session === id) session = undefined;
        }
      }
    },
    abort(id: string) { live.get(id)?.abort(); },
    /**
     * Ends what this account's window had open. The window is told to close its session, which also ends it on the
     * server; with `cut` the open requests end here too, for an account that is gone.
     */
    stop(cut: boolean) {
      const had = grant !== undefined || live.size > 0;
      grant = undefined;
      if (cut) for (const controller of live.values()) controller.abort();
      if (had) deps.notifyStop();
    },
  };
}
