import "server-only";
import WebSocket from "ws";
import { VOICE_CONVERSATION_INSTRUCTIONS, VOICE_CONVERSATION_MODEL } from "@tomverse/chat-core";

const endpoint = "https://api.openai.com/v1/live/sessions";
const headers = () => ({ Authorization: `Bearer ${process.env.VOICE_CONVERSATION_API_KEY}`, "Content-Type": "application/json" });

export async function createVoiceProviderSession(sdp: string, history: Array<{ role: "user" | "assistant"; content: string }>) {
  const response = await fetch(endpoint, {
    method: "POST", headers: headers(), signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      session: {
        model: VOICE_CONVERSATION_MODEL, instructions: VOICE_CONVERSATION_INSTRUCTIONS,
        store: false, delegation: { type: "client" },
        input: history.map(m => ({ type: "message", role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] })),
      },
      // The untrusted frontend cannot change configuration, invoke Responses, or supply results.
      client: { data_channel: { allowed_client_events: [], allowed_server_events: ["session.started", "session.closed"] } },
      transport: { type: "webrtc", sdp },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false as const, rejected: response.status >= 400 && response.status < 500 };
  }
  const body: unknown = await response.json();
  const result = body as { session?: { id?: unknown }; transport?: { sdp?: unknown } };
  if (typeof result.session?.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.session.id)) {
    throw new Error("Invalid voice provider response.");
  }
  if (typeof result.transport?.sdp !== "string" || !result.transport.sdp.trim() || result.transport.sdp.length > 128_000) {
    // The caller durably records this identity before installing a closing receiver.
    return { ok: false as const, rejected: false, sessionId: result.session.id };
  }
  return { ok: true as const, sessionId: result.session.id, sdp: result.transport.sdp };
}

export function attachVoiceProviderSession(sessionId: string) {
  return new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`, {
    headers: headers(), handshakeTimeout: 10_000, maxPayload: 512 * 1024,
  });
}

export async function hangupVoiceProviderSession(sessionId: string) {
  const response = await fetch(`${endpoint}/${encodeURIComponent(sessionId)}/hangup`, {
    method: "POST", headers: headers(), signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new Error("Voice hangup was not confirmed.");
}

/** A recovery receiver is installed before closure; no new paid session is created. */
export async function closeVoiceProviderSession(sessionId: string, timeoutMs = 12_000): Promise<number | null> {
  const socket = attachVoiceProviderSession(sessionId);
  try {
    return await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => done(null), timeoutMs);
      let complete = false;
      function done(seconds: number | null) { if (complete) return; complete = true; clearTimeout(timer); resolve(seconds); }
      socket.on("message", data => {
        let event; try { event = JSON.parse(data.toString()); } catch { return; }
        if (event.type === "session.closed") {
          const seconds = event.usage?.seconds;
          done(typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : null);
        }
      });
      socket.once("open", () => socket.send(JSON.stringify({ type: "session.close" })));
      socket.once("error", () => done(null));
      socket.once("close", () => done(null));
    });
  } finally { socket.close(); }
}

/** One trusted command owner. No provider key or client-supplied answer reaches the browser. */
export async function sendVoiceProviderResult(socket: WebSocket, delegationId: string, content: string) {
    if (socket.readyState !== socket.OPEN) throw new Error("Voice session is disconnected.");
    const pieces: string[] = [];
    let part = "";
    for (const char of content.slice(0, 12_000)) {
      if (Buffer.byteLength(part + char, "utf8") > 480) { pieces.push(part); part = ""; }
      part += char;
    }
    if (part) pieces.push(part);
    for (const [index, piece] of pieces.entries()) {
      const eventId = `result_${delegationId}_${index}`;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("Voice result acknowledgment timed out.")); }, 10_000);
        function onMessage(data: WebSocket.RawData) {
          let event; try { event = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
          const error = event.error as Record<string, unknown> | undefined;
          if (event.client_event_id !== eventId && error?.client_event_id !== eventId) return;
          clearTimeout(timer); socket.off("message", onMessage);
          if (event.type === "error") reject(new Error("Voice result was rejected.")); else resolve();
        }
        socket.on("message", onMessage);
        try { socket.send(JSON.stringify({ type: "session.commentary.append", event_id: eventId, delegation_id: delegationId, content: piece })); }
        catch (error) { clearTimeout(timer); socket.off("message", onMessage); reject(error); }
      });
    }
}
