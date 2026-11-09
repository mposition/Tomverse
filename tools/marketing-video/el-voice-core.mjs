// One narration line through the ElevenLabs text-to-speech API, for the
// creative short job. Deterministic: a model wrote the line; it never runs this
// and never chooses the voice.
//
// The voice is fixed per locale (owner 2026-11-09, after listening):
//   en Killian, ko Apollo, zh-Hant 阿夢 (Taiwan Mandarin), zh-Hans Qiao Feng.
// Spending is capped like Higgsfield's (higgsfield-cap.mjs, one ledger per
// Brisbane day, job/creative-voice-ledger-<yyyymmdd>.json): ElevenLabs bills
// characters, so an entry's cost is the line's length, and the day's total may
// not pass MARKETING_CREATIVE_SHORT_DAILY_VOICE_CHARS (unset or 0 refuses
// every call). The entry is written before the request leaves. A request with
// no answer (network error, timeout, 5xx) may have been charged and cannot be
// looked up, so it stays unknown and refuses every later line that day until a
// person has checked the ElevenLabs history. A 4xx is ElevenLabs refusing it,
// not charged, and settles as failed.
//
// The key is ELEVENLABS_API_KEY in the box's env file; it is sent only to
// api.elevenlabs.io and never printed.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { admit, brisbaneDay, settle } from "./higgsfield-cap.mjs";
import { isMedia } from "./hf-media-core.mjs";

export const VOICE_CAP_ENV = "MARKETING_CREATIVE_SHORT_DAILY_VOICE_CHARS";
export const VOICE_MODEL = "eleven_v4";
export const VOICES = Object.freeze({
  en: "Whez8hBysHW6IVGRgjGA",
  ko: "xsfFw9plbX0VhNMhHgl1",
  "zh-Hant": "6nHtrY0bdH4FDasnUelr",
  "zh-Hans": "ZJsn5HnrE3eUbep2ia8D",
});
export const MAX_LINE_CHARS = 300;
const API = "https://api.elevenlabs.io/v1/text-to-speech";

export const voiceLedgerPath = (jobDir, day) => path.join(jobDir, `creative-voice-ledger-${day}.json`);

/** Why a request may not be sent, or null: the fixed model, a fixed voice, one short line. */
export function voiceRequestProblem(request) {
  if (!request || typeof request !== "object") return "request_not_an_object";
  if (request.model !== VOICE_MODEL) return "model_not_allowed";
  if (!Object.values(VOICES).includes(request.voice_id)) return "voice_not_allowed";
  for (const key of Object.keys(request)) if (!["model", "voice_id", "text"].includes(key)) return `field_not_allowed:${key}`;
  if (typeof request.text !== "string" || request.text.trim().length === 0 || request.text.length > MAX_LINE_CHARS) return "text_missing_or_too_long";
  return null;
}

const POLICY = Object.freeze({ problem: voiceRequestProblem, minCost: 1, capEnv: VOICE_CAP_ENV });

/**
 * Speaks one line in the locale's voice and writes the MP3 to `out`.
 * @returns {Promise<{ok: true, requestId: string|null, chars: number, out: string} | {ok: false, reason: string, detail?: object}>}
 */
export async function speakLine({ locale, text, out, jobDir, label, env = process.env, fetchImpl = fetch, day = brisbaneDay(), timeoutMs = 120_000 }) {
  const voice = Object.hasOwn(VOICES, locale) ? VOICES[locale] : null;
  if (!voice) return { ok: false, reason: "locale_has_no_voice" };
  const key = env.ELEVENLABS_API_KEY;
  if (typeof key !== "string" || key.trim() === "") return { ok: false, reason: "no_api_key" };
  const request = { model: VOICE_MODEL, voice_id: voice, text };
  const file = voiceLedgerPath(jobDir, day);
  const admitted = admit({ jobDir, day, env, request, label, cost: text.length, policy: POLICY, file });
  if (!admitted.ok) return admitted;
  const { entry } = admitted;

  let response;
  try {
    response = await fetchImpl(`${API}/${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: VOICE_MODEL }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    settle(file, entry.id, { status: "unknown" });
    return { ok: false, reason: "outcome_unknown" };
  }
  const requestId = response.headers?.get?.("request-id") ?? null;
  if (response.status >= 400 && response.status < 500) {
    settle(file, entry.id, { status: "failed", jobId: requestId });
    return { ok: false, reason: "refused_by_elevenlabs", detail: { status: response.status } };
  }
  if (response.status !== 200) {
    settle(file, entry.id, { status: "unknown", jobId: requestId });
    return { ok: false, reason: "outcome_unknown", detail: { status: response.status } };
  }
  let bytes = null;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    bytes = null;
  }
  // Answered 200: charged, whatever the body turned out to be.
  settle(file, entry.id, { status: "done", jobId: requestId });
  if (!isMedia(bytes, "audio")) return { ok: false, reason: "result_not_audio", detail: { requestId } };
  writeFileSync(out, bytes);
  return { ok: true, requestId, chars: text.length, out };
}
