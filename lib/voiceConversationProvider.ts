import "server-only";
import WebSocket from "ws";
import { VOICE_CONVERSATION_INSTRUCTIONS, VOICE_CONVERSATION_MODEL } from "@/lib/voiceConversationCore";

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
  if (typeof result.session?.id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.session.id) ||
      typeof result.transport?.sdp !== "string" || result.transport.sdp.length > 128_000) {
    throw new Error("Invalid voice provider response.");
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
  if (!response.ok) throw new Error("Voice hangup was not confirmed.");
}

/** One trusted command owner. No provider key or client-supplied answer reaches the browser. */
export async function sendVoiceProviderResult(sessionId: string, delegationId: string, content: string) {
  const socket = attachVoiceProviderSession(sessionId);
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const pieces: string[] = [];
    let part = "";
    for (const char of content.slice(0, 12_000)) {
      if (Buffer.byteLength(part + char, "utf8") > 480) { pieces.push(part); part = ""; }
      part += char;
    }
    if (part) pieces.push(part);
    for (const [index, piece] of pieces.entries()) {
      const eventId = `result_${delegationId}_${index}`;
      const acknowledged = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("Voice result acknowledgment timed out.")); }, 10_000);
        function onMessage(data: WebSocket.RawData) {
          let event; try { event = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
          const error = event.error as Record<string, unknown> | undefined;
          if (event.client_event_id !== eventId && error?.client_event_id !== eventId) return;
          clearTimeout(timer); socket.off("message", onMessage);
          if (event.type === "error") reject(new Error("Voice result was rejected.")); else resolve();
        }
        socket.on("message", onMessage);
      });
      socket.send(JSON.stringify({ type: "session.commentary.append", event_id: eventId, delegation_id: delegationId, content: piece }));
      await acknowledged;
    }
  } finally { socket.close(); }
}
