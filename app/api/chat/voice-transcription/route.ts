export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { isVoiceInputEnabled } from "@/lib/appSettings";
import { inspectVoiceClip } from "@/lib/voiceClipDuration";
import {
  VOICE_CLIP_MAX_BYTES,
  VOICE_CLIP_MIN_BYTES,
  VOICE_CLIP_REFUSAL_SECONDS,
  VOICE_TRANSCRIPT_MAX_CHARACTERS,
  voiceClipFormatFor,
} from "@/lib/voiceInputFormats";
import {
  releaseVoiceSeconds,
  reserveVoiceSeconds,
  settleVoiceSeconds,
  voiceReservationSeconds,
  VoiceBudgetError,
} from "@/lib/voiceInputBudget";
import { resolveVoiceGuardrails } from "@/lib/voiceInputGuardrails";
import {
  voiceTranscriptionKeySource,
  voiceTranscriptionProvider,
} from "@/lib/voiceTranscriptionPort";
import { normalizeVoiceTranscript } from "@/lib/voiceTranscript";

/**
 * Speech to text for the chat composer.
 *
 * Contract: docs/policy/voice-input.md.
 *
 * ## What this endpoint is, in one line
 *
 * Bytes in, text out, nothing kept.
 *
 * There is no upload preparation step, no object key, no row and no `GET`.
 * The clip exists as a buffer inside one request and is unreachable once that
 * request ends — not deleted later by a sweeper, but never stored in the first
 * place (docs/policy/voice-input.md §11.1). That is the property the whole
 * design is arranged around, and it is why this looks like
 * `/api/chat/guest-attachment` in shape (one request carrying the bytes,
 * validated before anything else happens) rather than like the signed-in
 * attachment flow it sits next to.
 *
 * ## What is never logged
 *
 * Not the audio. Not the transcript, nor its length in characters, nor a
 * prefix of it. Not the API key, nor any provider response body. The
 * structured event at the end of a request carries the outcome, the duration,
 * the format and how the duration was obtained — enough to run the feature,
 * and nothing that reconstructs what the user said
 * (docs/policy/voice-input.md §11.2). `tests/voiceInputPrivacy.test.mjs`
 * reads this file and fails if that changes.
 *
 * ## Signed-in only
 *
 * docs/policy/voice-input.md §4, decided in `lib/voiceInputAccess.ts`. A guest
 * reaching this endpoint gets 401 with its own code, so the composer can offer
 * the one action that changes the answer rather than a generic failure.
 */

const jsonError = (code: string, status: number, retryAfter?: number) =>
  Response.json(
    // A code and a status. No sentence: the client owns the wording, in seven
    // locales (`lib/voiceInputErrorCopy.ts`), and a server-authored English
    // string would be the one part of this flow that never got translated.
    { code },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
      },
    }
  );

/**
 * Reads the body with a hard ceiling, refusing both by the declared length and
 * by what actually arrives. A `Content-Length` is a claim, not a fact — the
 * same reasoning as the guest attachment endpoint.
 */
const readBoundedBody = async (
  request: Request
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; code: string }> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > VOICE_CLIP_MAX_BYTES) {
    return { ok: false, code: "VOICE_CLIP_TOO_LARGE" };
  }
  if (!request.body) return { ok: false, code: "VOICE_CLIP_EMPTY" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > VOICE_CLIP_MAX_BYTES) {
        await reader.cancel();
        return { ok: false, code: "VOICE_CLIP_TOO_LARGE" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total < VOICE_CLIP_MIN_BYTES) return { ok: false, code: "VOICE_CLIP_EMPTY" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
};

/** Provider failure -> the code the composer explains. */
const PROVIDER_FAILURE_CODES: Record<string, string> = {
  provider_not_configured: "VOICE_PROVIDER_UNAVAILABLE",
  provider_rejected_credentials: "VOICE_PROVIDER_UNAVAILABLE",
  provider_unavailable: "VOICE_PROVIDER_UNAVAILABLE",
  provider_unreachable: "VOICE_PROVIDER_UNAVAILABLE",
  provider_rejected_audio: "VOICE_TRANSCRIPTION_FAILED",
  provider_response_unreadable: "VOICE_TRANSCRIPTION_FAILED",
};

/**
 * One line per request, and only these fields.
 *
 * Every value here is either a code this file chose or a number measured from
 * the container. Nothing derived from the audio or the transcript appears,
 * which is the property `tests/voiceInputPrivacy.test.mjs` enforces.
 */
const report = (fields: {
  outcome: string;
  mediaType?: string;
  durationSource?: string;
  durationSeconds?: number | null;
  reservedSeconds?: number;
  providerFailure?: string;
  providerStatus?: number | null;
}) => {
  const line = JSON.stringify({
    event: "voice_transcription",
    keySource: voiceTranscriptionKeySource(),
    ...fields,
  });
  if (fields.outcome === "succeeded") console.log(line);
  else console.warn(line);
};

export async function POST(request: Request) {
  let reservation: { userId: string; reservedSeconds: number } | null = null;
  try {
    // Order matters and is the fail-closed one: the feature flag is consulted
    // before the session, so a request to a disabled feature never touches the
    // session store, and before the body is read, so a disabled feature never
    // spends bandwidth on audio it will refuse.
    if (!(await isVoiceInputEnabled())) {
      report({ outcome: "refused_disabled" });
      return jsonError("VOICE_INPUT_DISABLED", 503);
    }

    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) {
      report({ outcome: "refused_unauthenticated" });
      return jsonError("VOICE_AUTHENTICATION_REQUIRED", 401);
    }

    const { limits } = resolveVoiceGuardrails(process.env);
    // Request *count* is ordinary abuse protection and shares the mechanism
    // every other endpoint uses. The seconds budget below is the cost
    // guardrail and deliberately does not (docs/policy/voice-input.md §7).
    await consumeApiRateLimit(request, userId, "voice-transcription", {
      minute: limits.requestsPerMinute,
      day: limits.requestsPerDay,
    });

    const declaredMediaType = (request.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!voiceClipFormatFor(declaredMediaType)) {
      report({ outcome: "refused_unsupported_type" });
      return jsonError("VOICE_CLIP_UNSUPPORTED_TYPE", 415);
    }

    const body = await readBoundedBody(request);
    if (!body.ok) {
      report({ outcome: "refused_body", providerFailure: body.code });
      return jsonError(body.code, body.code === "VOICE_CLIP_TOO_LARGE" ? 413 : 400);
    }

    // The declaration only had to agree with the bytes; the bytes decide.
    const inspection = inspectVoiceClip({
      bytes: body.bytes,
      declaredMediaType,
    });
    if (!inspection.ok) {
      report({ outcome: "refused_container", providerFailure: inspection.code });
      return jsonError(inspection.code, 400);
    }

    if (
      inspection.durationSeconds !== null &&
      inspection.durationSeconds > VOICE_CLIP_REFUSAL_SECONDS
    ) {
      report({
        outcome: "refused_too_long",
        mediaType: inspection.format.mediaType,
        durationSource: inspection.durationSource,
        durationSeconds: inspection.durationSeconds,
      });
      return jsonError("VOICE_CLIP_TOO_LONG", 413);
    }

    // Reserved before the provider call, on the honest basis: the container's
    // own length when it declared one, the per-clip ceiling when it did not.
    const reservedSeconds = voiceReservationSeconds(inspection.durationSeconds);
    await reserveVoiceSeconds({ userId, seconds: reservedSeconds });
    reservation = { userId, reservedSeconds };

    const result = await voiceTranscriptionProvider().transcribe({
      audio: body.bytes,
      mediaType: inspection.format.mediaType,
      extension: inspection.format.extension,
      // Automatic detection. docs/policy/voice-input.md §12: Korean and
      // English are the languages this is built for, and pinning one of them
      // would transcribe the wrong language for a bilingual speaker rather
      // than detect the right one.
      languageHint: null,
    });

    if (!result.ok) {
      // The provider did not bill for a call it refused, so the reservation
      // goes back rather than spending the user's day on our outage.
      await releaseVoiceSeconds(reservation);
      reservation = null;
      report({
        outcome: "provider_failed",
        mediaType: inspection.format.mediaType,
        durationSource: inspection.durationSource,
        durationSeconds: inspection.durationSeconds,
        providerFailure: result.code,
        providerStatus: result.status,
      });
      return jsonError(
        PROVIDER_FAILURE_CODES[result.code] || "VOICE_TRANSCRIPTION_FAILED",
        result.code === "provider_rejected_audio" ? 422 : 502
      );
    }

    // Settled to what the provider says it processed, which is what it bills.
    await settleVoiceSeconds({
      userId,
      reservedSeconds,
      actualSeconds: result.durationSeconds,
    });
    reservation = null;

    const transcript = normalizeVoiceTranscript(result.text, {
      maxCharacters: VOICE_TRANSCRIPT_MAX_CHARACTERS,
    });
    if (!transcript) {
      // The request succeeded and the answer is that there was no speech. Its
      // own code, because "try again" is right here and wrong for most of the
      // other failures on this endpoint.
      report({
        outcome: "empty_transcript",
        mediaType: inspection.format.mediaType,
        durationSource: inspection.durationSource,
        durationSeconds: result.durationSeconds ?? inspection.durationSeconds,
      });
      return jsonError("VOICE_TRANSCRIPT_EMPTY", 422);
    }

    report({
      outcome: "succeeded",
      mediaType: inspection.format.mediaType,
      durationSource: inspection.durationSource,
      durationSeconds: result.durationSeconds ?? inspection.durationSeconds,
      reservedSeconds,
    });

    return Response.json(
      { transcript },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (reservation) {
      // Whatever went wrong, the user does not owe their daily budget for it.
      await releaseVoiceSeconds(reservation).catch(() => undefined);
    }
    if (error instanceof VoiceBudgetError) {
      report({ outcome: "refused_budget" });
      return jsonError(error.code, error.status, error.retryAfter);
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) {
      report({ outcome: "refused_rate_limit" });
      return securityResponse;
    }
    // The error is reported by *name* only. A transcription failure's message
    // can carry the request that caused it, and the request is the audio.
    report({
      outcome: "failed",
      providerFailure: error instanceof Error ? error.name : "UnknownError",
    });
    return jsonError("VOICE_TRANSCRIPTION_FAILED", 500);
  }
}
