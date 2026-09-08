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
  voiceReservationSeconds,
  VoiceBudgetError,
} from "@/lib/voiceInputBudget";
import {
  releaseVoiceBudgets,
  reserveVoiceBudgets,
  settleVoiceBudgets,
  type VoiceBudgetReservation,
} from "@/lib/voiceBudgetReservation";
import type { VoiceSettlementBasis } from "@/lib/voiceInputGuardrails";
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
  provider_rate_limited: "VOICE_PROVIDER_UNAVAILABLE",
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
  releasedSeconds?: number;
  /** Which of the four §7.2 bases closed the reservation. */
  settlementBasis?: string;
  /**
   * What the provider said it used: "duration", "tokens" or "absent".
   *
   * The *shape*, never the counts. `output_tokens` is a proxy for how long
   * the transcript is, and §11.2 forbids logging the transcript's length as
   * firmly as it forbids logging the transcript. Knowing which unit the
   * provider bills in is what an operator needs here; knowing how much the
   * user said is not.
   */
  usageKind?: string;
  /** `not_sent`, `refused` or `indeterminate`. */
  disposition?: string;
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
  let reservation: VoiceBudgetReservation | null = null;
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
    reservation = await reserveVoiceBudgets({ userId, seconds: reservedSeconds });

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
      /*
        Three outcomes, not one (docs/policy/voice-input.md §7.2).

        The reservation used to be released for every failure. That is right
        only when nothing was billed and we *know* it: no request was made, or
        the provider answered with a refusal. A request that went out and whose
        answer never came back — a timeout, a dropped connection, a 5xx, or a
        2xx we could not parse — is evidence of nothing, and the last of those
        was almost certainly transcribed and paid for. Assuming otherwise makes
        a spending guardrail stop guarding exactly when the provider is unwell.

        So an indeterminate call keeps its reservation. It costs the user part
        of a daily allowance that resets at the next UTC day, and it does not
        charge them anything: there is no user-facing charge for voice input at
        all while §6 is open.
      */
      const basis: VoiceSettlementBasis =
        result.disposition === "indeterminate"
          ? { kind: "reservation" }
          : { kind: "not_billed" };
      const settlement = await settleVoiceBudgets({ reservation, basis });
      report({
        outcome: "provider_failed",
        mediaType: inspection.format.mediaType,
        durationSource: inspection.durationSource,
        durationSeconds: inspection.durationSeconds,
        reservedSeconds,
        releasedSeconds: settlement.releasedSeconds,
        settlementBasis: basis.kind,
        disposition: result.disposition,
        providerFailure: result.code,
        providerStatus: result.status,
      });
      reservation = null;
      return jsonError(
        PROVIDER_FAILURE_CODES[result.code] || "VOICE_TRANSCRIPTION_FAILED",
        result.code === "provider_rejected_audio" ? 422 : 502
      );
    }

    /*
      What the call is settled against, in order of what it actually proves
      (docs/policy/voice-input.md §7.2):

        1. seconds the provider itself reported — the only figure that is a
           statement about the bill;
        2. the length this endpoint measured out of the container — a fact
           about the audio, measured by us;
        3. otherwise the conservative reservation stands.

      A token-billed model — which the configured default is — reports
      `input_tokens`/`output_tokens` and no seconds. Those are recorded and
      never converted: this guardrail counts seconds, and turning tokens into
      seconds would be inventing a rate nobody has approved (§6.1).
    */
    const providerSeconds =
      result.usage.kind === "duration" ? result.usage.seconds : null;
    const basis: VoiceSettlementBasis =
      providerSeconds !== null
        ? { kind: "provider_seconds", seconds: providerSeconds }
        : inspection.durationSeconds !== null
          ? { kind: "measured_clip", seconds: inspection.durationSeconds }
          : { kind: "reservation" };
    const settlement = await settleVoiceBudgets({ reservation, basis });
    const usageFields = {
      usageKind: result.usage.kind,
      settlementBasis: basis.kind,
      releasedSeconds: settlement.releasedSeconds,
    };
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
        durationSeconds: providerSeconds ?? inspection.durationSeconds,
        reservedSeconds,
        ...usageFields,
      });
      return jsonError("VOICE_TRANSCRIPT_EMPTY", 422);
    }

    report({
      outcome: "succeeded",
      mediaType: inspection.format.mediaType,
      durationSource: inspection.durationSource,
      durationSeconds: providerSeconds ?? inspection.durationSeconds,
      reservedSeconds,
      ...usageFields,
    });

    return Response.json(
      { transcript },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (reservation) {
      /*
        An exception here happened *before* the provider was reached, or while
        the request was still being prepared — every path after a successful
        provider call settles and clears the handle first. So nothing was
        billed and the reservation goes back.

        The handle is single-use, so this cannot double-release, and it cannot
        reach another request's booking: `reservation` is a local.
      */
      await releaseVoiceBudgets(reservation).catch(() => undefined);
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
