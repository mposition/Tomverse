/** Shared voice semantics; platform audio and credentials are injected by each host. */
export const VOICE_CONVERSATION_MODEL = "gpt-live-1";
export const VOICE_CONVERSATION_SOURCE = "voice_conversation";
export const VOICE_CONVERSATION_PRICING_VERSION = "2026-10-23";
// https://developers.openai.com/api/docs/pricing — USD 0.05/min, billed per second.
export const VOICE_CONVERSATION_MICRO_USD_PER_MINUTE = 50_000;
export const VOICE_CONVERSATION_INITIAL_SECONDS = 15;

export function voiceConversationConfig(env: Record<string, string | undefined>) {
  // Owner-approved in chat, 2026-10-23: 36 credits per minute.
  const creditsPerMinute = 36;
  const maxSeconds = Number(env.VOICE_CONVERSATION_MAX_SECONDS ?? "300");
  if (env.VOICE_CONVERSATION_ENABLED !== "true" ||
      env.VOICE_CONVERSATION_KILL_SWITCH || !env.VOICE_CONVERSATION_API_KEY ||
      !Number.isSafeInteger(creditsPerMinute) || creditsPerMinute < 1 || creditsPerMinute > 6_000 ||
      !Number.isSafeInteger(maxSeconds) || maxSeconds < 15 || maxSeconds > 900) return null;
  return { creditsPerMinute, maxSeconds };
}

export function voiceDurationCharge(seconds: number, creditsPerMinute: number) {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(creditsPerMinute) || creditsPerMinute < 1) {
    throw new Error("Invalid voice duration or price.");
  }
  return {
    credits: Math.ceil(seconds * creditsPerMinute / 60),
    costMicroUsd: Math.ceil(seconds * VOICE_CONVERSATION_MICRO_USD_PER_MINUTE / 60),
  };
}

export type VoiceCaption = {
  id: string;
  role: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
};

export type VoiceTranscriptEvent = {
  type: "session.input_transcript.delta" | "session.output_transcript.delta";
  event_id: string;
  delta: string;
  start_ms: number;
  end_ms: number;
};

export function isVoiceTranscriptEvent(value: unknown): value is VoiceTranscriptEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (e.type === "session.input_transcript.delta" || e.type === "session.output_transcript.delta") &&
    typeof e.event_id === "string" && typeof e.delta === "string" && e.delta.length <= 16_384 &&
    typeof e.start_ms === "number" && Number.isFinite(e.start_ms) && e.start_ms >= 0 &&
    typeof e.end_ms === "number" && Number.isFinite(e.end_ms) && e.end_ms >= e.start_ms;
}

/** Keep overlapping speakers independent; never trim or deduplicate spoken words. */
export function appendVoiceCaption(captions: readonly VoiceCaption[], event: VoiceTranscriptEvent): VoiceCaption[] {
  const role = event.type === "session.input_transcript.delta" ? "user" : "assistant";
  const result = [...captions];
  let index = result.length - 1;
  while (index >= 0 && result[index].role !== role) index--;
  const previous = result[index];
  if (previous && event.start_ms >= previous.endMs && event.start_ms - previous.endMs < 1_500) {
    result[index] = { ...previous, text: previous.text + event.delta, endMs: event.end_ms };
  } else {
    result.push({ id: event.event_id, role, text: event.delta, startMs: event.start_ms, endMs: event.end_ms });
  }
  return result.slice(-200);
}

export const VOICE_CONVERSATION_INSTRUCTIONS = [
  "You are Tomverse's voice interface. Speak the user's language and be concise.",
  "Listen while speaking and yield naturally when the user interrupts or corrects you.",
  "Delegate every substantive question, reasoning task, search, or tool request to the client backend.",
  "Create a client delegation when the current request is clear; allow sentence pauses and keep later corrections in context.",
  "The backend uses the user's existing Tomverse model selection and Smart Adaptive settings.",
  "Only produce brief acknowledgments or clarification questions yourself. Never invent a backend result.",
  "Speak the results returned by the backend naturally. Preserve facts, caveats and source attribution.",
  "Do not claim an action succeeded until the backend confirms it. You cannot change billing or permissions.",
].join(" ");
