import "server-only";

import { ChatAccessError } from "@/lib/chatSecurity";
import {
    audioTranscriptEntry,
    CHAT_AUDIO_TRANSCRIPTION_TIMEOUT_MS,
    chatAudioAttachmentSwitchOn,
} from "@/lib/chatAudioAttachmentCore";
import {
    releaseVoiceBudgets,
    reserveVoiceBudgets,
    settleVoiceBudgets,
    type VoiceBudgetReservation,
} from "@/lib/voiceBudgetReservation";
import { VoiceBudgetError } from "@/lib/voiceInputBudget";
import type { VoiceSettlementBasis } from "@/lib/voiceInputGuardrails";
import { voiceModelPriceRefusal } from "@/lib/voiceInputPricing";
import {
    voiceTranscriptionKeySource,
    voiceTranscriptionProvider,
} from "@/lib/voiceTranscriptionPort";
import { resolveVoiceTranscriptionModel } from "@/lib/voiceTranscriptionPortCore";

/**
 * A recording attached to a chat message, turned into text for the model.
 *
 * Contract: docs/policy/chat-attachment-formats.md section 2.4.
 *
 * ## What it costs, and who pays
 *
 * Nobody's credits. The transcript is bought from voice input's provider,
 * model and seconds budget, under voice input's pricing decision: no user
 * charge, an operational guardrail instead (docs/policy/voice-input.md section
 * 6.1). The same two bookings are made -- the caller's own seconds for the day
 * and the deployment's provider seconds -- so a recording and a dictated
 * message draw from one allowance and one bill. OCR is the other precedent and
 * it agrees: a backend conversion that never consumes user credits.
 *
 * ## Fail-closed
 *
 * Offered only while `CHAT_AUDIO_ATTACHMENT_ENABLED` is `"true"` and the
 * configured transcription model has an observed price
 * (docs/policy/voice-input.md section 6.1.4). The second condition is the one
 * voice input's readiness enforces; it is checked here too because this switch
 * can be on while voice input is off.
 */
export const chatAudioAttachmentEnabled = (
    env: Readonly<Record<string, string | undefined>> = process.env
) =>
    chatAudioAttachmentSwitchOn(env) &&
    voiceModelPriceRefusal({ modelId: resolveVoiceTranscriptionModel(env) }) === null;

/**
 * One line per transcription, and only these fields: codes this file chose
 * and numbers measured from the container. Never the transcript, its length,
 * the file name or the provider's body (docs/policy/voice-input.md section 11.2).
 */
const report = (fields: Record<string, string | number | null | undefined>) => {
    const line = JSON.stringify({
        event: "chat_audio_attachment_transcription",
        keySource: voiceTranscriptionKeySource(),
        ...fields,
    });
    if (fields.outcome === "succeeded") console.log(line);
    else console.warn(line);
};

/**
 * Transcribes one attachment, booked against the seconds budget, or refuses.
 *
 * `durationSeconds` is the length `inspectAudioAttachment` read from the bytes;
 * the caller has already refused a file without one.
 */
type AudioTranscriptionDeps = {
    reserve: typeof reserveVoiceBudgets;
    settle: typeof settleVoiceBudgets;
    release: typeof releaseVoiceBudgets;
    transcribe: ReturnType<typeof voiceTranscriptionProvider>["transcribe"];
};

const defaultDeps = (): AudioTranscriptionDeps => ({
    reserve: reserveVoiceBudgets,
    settle: settleVoiceBudgets,
    release: releaseVoiceBudgets,
    transcribe: (request) => voiceTranscriptionProvider().transcribe(request),
});

export const transcribeAudioAttachment = async (
    input: {
        bytes: Uint8Array;
        mediaType: string;
        extension: string;
        durationSeconds: number;
        subjectKey: string;
        traceId: string;
    },
    /** Replaced in tests; the ledgers and the provider otherwise. */
    deps: AudioTranscriptionDeps = defaultDeps()
): Promise<{ kind: string; text: string }> => {
    const { reserve, settle, release, transcribe } = deps;
    const reservedSeconds = Math.max(1, Math.ceil(input.durationSeconds));
    let reservation: VoiceBudgetReservation;
    try {
        reservation = await reserve({
            subjectKey: input.subjectKey,
            seconds: reservedSeconds,
        });
    } catch (error) {
        if (error instanceof VoiceBudgetError) {
            report({ outcome: "refused_budget", traceId: input.traceId, reservedSeconds });
            throw new ChatAccessError(
                429,
                "AUDIO_TRANSCRIPTION_LIMIT_REACHED",
                "Today's audio transcription allowance has been used. Try again tomorrow or attach a shorter recording.",
                error.retryAfter
            );
        }
        throw error;
    }

    let settled = false;
    try {
        const result = await transcribe({
            audio: input.bytes,
            mediaType: input.mediaType,
            extension: input.extension,
            languageHint: null,
            timeoutMs: CHAT_AUDIO_TRANSCRIPTION_TIMEOUT_MS,
        });
        if (!result.ok) {
            // The voice route's rule (docs/policy/voice-input.md section 7.2):
            // a call whose outcome is unknown keeps its reservation, one the
            // provider refused or that was never sent gives it all back.
            const basis: VoiceSettlementBasis =
                result.disposition === "indeterminate"
                    ? { kind: "reservation" }
                    : { kind: "not_billed" };
            settled = true;
            await settle({ reservation, basis });
            report({
                outcome: "provider_failed",
                traceId: input.traceId,
                mediaType: input.mediaType,
                reservedSeconds,
                settlementBasis: basis.kind,
                disposition: result.disposition,
                providerFailure: result.code,
                providerStatus: result.status,
            });
            throw new ChatAccessError(
                502,
                "AUDIO_TRANSCRIPTION_UNAVAILABLE",
                "The recording could not be transcribed right now. Try again shortly."
            );
        }

        const basis: VoiceSettlementBasis =
            result.usage.kind === "duration"
                ? { kind: "provider_seconds", seconds: result.usage.seconds }
                : { kind: "measured_clip", seconds: input.durationSeconds };
        settled = true;
        const settlement = await settle({ reservation, basis });

        const entry = audioTranscriptEntry({
            text: result.text,
            outputTokens: result.usage.kind === "tokens" ? result.usage.outputTokens : null,
        });
        report({
            outcome: entry ? "succeeded" : "empty_transcript",
            traceId: input.traceId,
            mediaType: input.mediaType,
            durationSeconds: input.durationSeconds,
            reservedSeconds,
            releasedSeconds: settlement.releasedSeconds,
            settlementBasis: basis.kind,
            usageKind: result.usage.kind,
            mayBeIncomplete: entry ? Number(entry.kind !== "audio transcript") : null,
        });
        if (!entry) {
            throw new ChatAccessError(
                422,
                "ATTACHMENT_NO_TEXT",
                "The attached recording contains no speech that could be transcribed."
            );
        }
        return entry;
    } finally {
        // Reached unsettled only when something threw before the provider
        // answered, so nothing was billed.
        if (!settled) await release(reservation).catch(() => undefined);
    }
};
