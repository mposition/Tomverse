import { appendVoiceCaption, isVoiceTranscriptEvent, type VoiceCaption } from "@tomverse/chat-core";

export type VoiceAnswerReceipt = { sourceUserMessageId: string; conversationId: string };
export type VoiceConversationView = {
  status: "idle" | "connecting" | "listening" | "closing" | "ended" | "error";
  captions: VoiceCaption[]; seconds: number; credits: number;
  muted: boolean; audioBlocked: boolean; confirmed: boolean; billingPending: boolean; error: string | null;
  inputLevel?: number; outputLevel?: number; working?: boolean;
};

export type VoiceConversationDeps = {
  getMicrophone: () => Promise<MediaStream>;
  createPeer: () => RTCPeerConnection;
  createAudio: () => HTMLAudioElement;
  fetch: typeof fetch;
  monitorLevels?: (stream: MediaStream, onLevel: (level: number) => void) => () => void;
};

const initialView = (): VoiceConversationView => ({ status: "idle", captions: [], seconds: 0, credits: 0, muted: false, audioBlocked: false, confirmed: false, billingPending: false, error: null });

/** Transport owns every resource; React only renders its state. Also usable by a bundled WebView. */
export function createVoiceConversationClient(options: {
  deps: VoiceConversationDeps;
  onChange: (state: VoiceConversationView) => void;
  onRequest: (text: string) => Promise<VoiceAnswerReceipt>;
}) {
  let view = initialView();
  let peer: RTCPeerConnection | null = null;
  let microphone: MediaStream | null = null;
  let audio: HTMLAudioElement | null = null;
  let controller: AbortController | null = null;
  let reservationId: string | null = null;
  let startRequestId: string | null = null;
  let epoch = 0;
  let closeTimeout: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let lastEventAt = 0;
  const levelMonitors: (() => void)[] = [];
  let queue = Promise.resolve();
  const seen = new Set<string>();
  const patch = (value: Partial<VoiceConversationView>) => { view = { ...view, ...value }; options.onChange(view); };
  const cleanup = () => {
    clearTimeout(closeTimeout);
    clearInterval(heartbeatTimer); clearTimeout(durationTimer);
    levelMonitors.splice(0).forEach(dispose => dispose());
    for (const track of microphone?.getTracks() ?? []) { try { track.stop(); } catch {} }
    microphone = null;
    try { peer?.close(); } catch {} peer = null;
    if (audio) { audio.pause(); audio.srcObject = null; } audio = null;
    controller?.abort(); controller = null;
  };
  async function post(body: unknown, signal?: AbortSignal) {
    const response = await options.deps.fetch("/api/chat/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      if (typeof data?.reservationId === "string") reservationId = data.reservationId;
      const code = typeof data?.code === "string" && /^[A-Z_]{1,80}$/.test(data.code) ? data.code : "VOICE_REQUEST_FAILED";
      if ((body as { action?: string }).action === "start" && code !== "VOICE_START_OUTCOME_UNKNOWN") patch({ billingPending: false });
      throw new Error(code);
    }
    return response;
  }
  async function recoverBilling(owner: number) {
    if ((!reservationId && !startRequestId) || !view.billingPending) return;
    for (let attempt = 0; attempt < 72; attempt++) {
      const delay = [0, 3_000, 6_000, 12_000][attempt] ?? 15_000;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (owner !== epoch) return;
      try {
        const response = await post({ action: "status", ...(reservationId ? { reservationId } : { requestId: startRequestId }) }, AbortSignal.timeout(8_000));
        const status = await response.json();
        if (owner !== epoch) return;
        if (status.settled === true && typeof status.credits === "number" && Number.isFinite(status.credits) && status.credits >= 0) {
          patch({ billingPending: false, confirmed: status.confirmed === true, credits: status.credits,
            ...(typeof status.seconds === "number" && Number.isFinite(status.seconds) && status.seconds >= 0 ? { seconds: status.seconds } : {}) });
          return;
        }
      } catch { /* The independent worker continues; reopening Chat reads the saved summary. */ }
    }
  }
  async function stop() {
    if (view.status !== "connecting" && view.status !== "listening") return;
    patch({ status: "closing" });
    for (const track of microphone?.getTracks() ?? []) track.stop();
    if (audio) audio.muted = true;
    if (reservationId) void post({ action: "stop", reservationId }).then(r => r.body?.cancel()).catch(() => { /* The streaming connection also owns closure. */ });
    else controller?.abort();
    const owner = epoch;
    closeTimeout = setTimeout(() => { cleanup(); patch({ status: "ended", confirmed: false }); void recoverBilling(owner); }, 16_000);
  }
  async function handle(event: Record<string, unknown>, owner: number) {
    if (owner !== epoch) return;
    if (event.type === "ready" && typeof event.sdp === "string" && typeof event.reservationId === "string") {
      reservationId = event.reservationId;
      await peer?.setRemoteDescription({ type: "answer", sdp: event.sdp });
      const seconds = typeof event.maxSeconds === "number" && event.maxSeconds >= 15 && event.maxSeconds <= 900 ? event.maxSeconds : 300;
      durationTimer = setTimeout(() => { void stop(); }, seconds * 1_000);
    } else if (event.type === "started") {
      patch({ status: "listening" });
    } else if (event.type === "transcript" && isVoiceTranscriptEvent(event.event)) {
      const fragment = event.event;
      if (seen.has(fragment.event_id)) return; seen.add(fragment.event_id);
      patch({ captions: appendVoiceCaption(view.captions, fragment) });
    } else if (event.type === "usage" && typeof event.seconds === "number" && typeof event.credits === "number") {
      patch({ seconds: event.seconds, credits: event.credits });
    } else if (event.type === "delegation" && typeof event.delegationId === "string" && typeof event.text === "string") {
      const delegationId = event.delegationId;
      if (seen.has(delegationId)) return; seen.add(delegationId);
      const text = event.text;
      queue = queue.then(async () => {
        if (epoch !== owner || view.status !== "listening") return;
        patch({ working: true });
        let receipt: VoiceAnswerReceipt;
        try { receipt = await options.onRequest(text); }
        finally { if (epoch === owner) patch({ working: false }); }
        if (epoch !== owner || view.status !== "listening" || !reservationId) return;
        const response = await post({ action: "result", reservationId, delegationId, ...receipt }, controller?.signal);
        await response.body?.cancel();
      }).catch(error => {
        if (owner === epoch && view.status === "listening") {
          patch({ error: "VOICE_ANSWER_FAILED" });
          if (error instanceof Error && /CREDIT|ENTITLEMENT|PLAN_DAILY/.test(error.message)) void stop();
        }
      });
    } else if (event.type === "closed") {
      cleanup();
      patch({ status: "ended", confirmed: event.confirmed === true, billingPending: event.settled !== true && event.confirmed !== true,
        ...(typeof event.seconds === "number" ? { seconds: event.seconds } : {}), ...(typeof event.credits === "number" ? { credits: event.credits } : {}) });
      if (view.billingPending) void recoverBilling(owner);
    } else if (event.type === "error") {
      patch({ error: typeof event.code === "string" ? event.code : "VOICE_CONNECTION_LOST" });
    }
  }
  async function start(conversationId: string | null) {
    if (view.status === "connecting" || view.status === "listening" || view.status === "closing") return;
    cleanup(); const owner = ++epoch; seen.clear(); reservationId = null; startRequestId = null; queue = Promise.resolve();
    view = initialView(); patch({ status: "connecting" });
    const abort = new AbortController(); controller = abort;
    try {
      const stream = await options.deps.getMicrophone();
      if (owner !== epoch || abort.signal.aborted) { stream.getTracks().forEach(t => t.stop()); return; }
      microphone = stream;
      const monitor = options.deps.monitorLevels?.(stream, inputLevel => { if (owner === epoch) patch({ inputLevel }); });
      if (monitor) levelMonitors.push(monitor);
      peer = options.deps.createPeer(); audio = options.deps.createAudio(); audio.autoplay = true;
      const connection = peer; const player = audio;
      connection.ontrack = event => {
        if (owner !== epoch) return;
        player.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        const monitor = options.deps.monitorLevels?.(player.srcObject as MediaStream, outputLevel => { if (owner === epoch) patch({ outputLevel }); });
        if (monitor) levelMonitors.push(monitor);
        void player.play().catch(() => { if (owner === epoch) patch({ audioBlocked: true }); });
      };
      connection.onconnectionstatechange = () => { if (connection.connectionState === "failed") void stop(); };
      stream.getAudioTracks().forEach(track => connection.addTrack(track, stream));
      connection.createDataChannel("oai-events");
      await connection.setLocalDescription(await connection.createOffer());
      if (connection.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error("VOICE_ICE_TIMEOUT")), 10_000);
        function onState() { if (connection.iceGatheringState === "complete") finish(); }
        function onAbort() { finish(new Error("VOICE_START_CANCELLED")); }
        function finish(error?: Error) { clearTimeout(timeout); connection.removeEventListener("icegatheringstatechange", onState); abort.signal.removeEventListener("abort", onAbort); if (error) reject(error); else resolve(); }
        connection.addEventListener("icegatheringstatechange", onState); abort.signal.addEventListener("abort", onAbort, { once: true }); onState();
      });
      if (!connection.localDescription?.sdp || abort.signal.aborted) throw new Error("VOICE_START_CANCELLED");
      patch({ billingPending: true });
      lastEventAt = Date.now();
      heartbeatTimer = setInterval(() => {
        if (owner !== epoch || Date.now() - lastEventAt <= 35_000) return;
        void stop(); cleanup(); patch({ status: "ended", confirmed: false, error: "VOICE_CONNECTION_LOST" });
        void recoverBilling(owner);
      }, 5_000);
      startRequestId = crypto.randomUUID();
      const response = await post({ action: "start", requestId: startRequestId, conversationId, sdp: connection.localDescription.sdp }, abort.signal);
      if (!response.body) throw new Error("VOICE_STREAM_MISSING");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          lastEventAt = Date.now();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 128_000) throw new Error("VOICE_EVENT_TOO_LARGE");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const part = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            for (const line of part.split("\n")) if (line.startsWith("data: ")) await handle(JSON.parse(line.slice(6)), owner);
          }
        }
      } finally { reader.releaseLock(); }
      if (owner === epoch && view.status !== "ended") { cleanup(); patch({ status: "ended", confirmed: false }); void recoverBilling(owner); }
    } catch (error) {
      if (owner !== epoch) return;
      if (view.status === "ended") return;
      const wasClosing = view.status === "closing";
      cleanup(); patch({ status: wasClosing ? "ended" : "error", error: wasClosing ? null : error instanceof Error && error.name === "NotAllowedError" ? "NotAllowedError" : error instanceof Error ? error.message : "VOICE_CONNECTION_LOST" });
      void recoverBilling(owner);
    }
  }
  return {
    start, stop,
    getReservationId: () => reservationId,
    toggleMicrophone() { const muted = !view.muted; microphone?.getAudioTracks().forEach(t => { t.enabled = !muted; }); patch({ muted }); },
    async resumeAudio() { try { await audio?.play(); patch({ audioBlocked: false }); } catch { patch({ audioBlocked: true }); } },
    destroy() { void stop(); ++epoch; cleanup(); },
  };
}
