import { READOUT_MODEL_ID, READOUT_RESPONSE_FORMAT, READOUT_VOICE } from "@/lib/chatReadoutAccess";
import type { ReadoutDisposition } from "@/lib/chatReadoutBudgetCore";
import { VOICE_TRANSCRIPTION_OPENAI_BASE_URL } from "@/lib/voiceTranscriptionPortCore";

/**
 * One speech request: text in, audio out, and an honest account of what
 * happened when it did not work.
 *
 * Contract: docs/policy/voice-input.md §6.4. The failure split is voice
 * input's (§7.4): `not_sent` and `refused` give the booking back, while
 * `indeterminate` -- sent, outcome unknown -- keeps it, because the provider
 * may have billed it. Nothing here retries: an unknown outcome of a paid call
 * is never sent again.
 *
 * Same host as voice input (`VOICE_TRANSCRIPTION_OPENAI_BASE_URL`), so the one
 * file that answers "where does voice data go" answers it for both.
 */

export const READOUT_PROVIDER_TIMEOUT_MS = 60_000;
/** A 1,500-character piece is about two minutes of MP3; anything far above is not a normal answer. */
export const READOUT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export const readoutSpeechEndpoint = (baseUrl: string = VOICE_TRANSCRIPTION_OPENAI_BASE_URL) =>
  `${baseUrl.replace(/\/+$/, "")}/v1/audio/speech`;

export type ReadoutSpeechResult =
  | { ok: true; disposition: "billed"; audio: Uint8Array<ArrayBuffer>; contentType: string }
  | {
      ok: false;
      disposition: Exclude<ReadoutDisposition, "billed">;
      /** The provider's HTTP status, or null when there was none. */
      status: number | null;
      /** A short closed-vocabulary code for logs; never provider text. */
      code: "provider_not_configured" | "provider_refused" | "provider_unavailable" | "provider_unreadable";
    };

export async function synthesizeReadoutSpeech(input: {
  text: string;
  apiKey: string | null | undefined;
  fetchImpl: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<ReadoutSpeechResult> {
  if (!input.apiKey) {
    return { ok: false, disposition: "not_sent", status: null, code: "provider_not_configured" };
  }
  const signal = AbortSignal.timeout(input.timeoutMs ?? READOUT_PROVIDER_TIMEOUT_MS);
  let response: Response;
  try {
    response = await input.fetchImpl(readoutSpeechEndpoint(input.baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: READOUT_MODEL_ID,
        voice: READOUT_VOICE,
        input: input.text,
        response_format: READOUT_RESPONSE_FORMAT,
      }),
      signal,
    });
  } catch {
    // Timeout or a dropped connection: the request may have reached the
    // provider and been billed. Unknown, so the booking stays.
    return { ok: false, disposition: "indeterminate", status: null, code: "provider_unavailable" };
  }
  if (!response.ok) {
    // A 4xx (429 included) is the provider declining to start; a 5xx says
    // nothing about whether it did the work.
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 400 && response.status < 500
      ? { ok: false, disposition: "refused", status: response.status, code: "provider_refused" }
      : { ok: false, disposition: "indeterminate", status: response.status, code: "provider_unavailable" };
  }
  let audio: Uint8Array<ArrayBuffer>;
  try {
    audio = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, disposition: "indeterminate", status: response.status, code: "provider_unreadable" };
  }
  if (audio.byteLength === 0 || audio.byteLength > (input.maxBytes ?? READOUT_MAX_AUDIO_BYTES)) {
    return { ok: false, disposition: "indeterminate", status: response.status, code: "provider_unreadable" };
  }
  const declared = response.headers.get("content-type") ?? "";
  return {
    ok: true,
    disposition: "billed",
    audio,
    contentType: declared.startsWith("audio/") ? declared.split(";")[0] : "audio/mpeg",
  };
}
