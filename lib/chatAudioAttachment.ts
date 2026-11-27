import "server-only";

import { randomUUID } from "node:crypto";

import {
    claimAttachmentTextCache,
    readAttachmentTextCache,
    releaseAttachmentTextClaim,
    writeAttachmentTextCache,
    type CachedAttachmentText,
} from "@/lib/attachmentTextCache";
import { ChatAccessError } from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";
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
export type AudioTranscriptionDeps = {
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

    // Set before each `settle` is awaited, on purpose. Once the provider has
    // answered, the seconds may have been billed, and a settle that throws has
    // an unknown outcome -- it may have committed. Releasing then would be a
    // second write on the same booking that could hand back seconds the
    // provider charged, so the hold is neither released nor retried: it stays
    // counted in the seconds buckets it was booked in, the conservative side,
    // and the turn fails with the settle's error.
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

// ---------------------------------------------------------------------------
// One paid transcription per recording, however many requests ask at once
// ---------------------------------------------------------------------------

/**
 * How long a claim stands before another request may take it over: the
 * transcription's own deadline, plus room to settle and store its result.
 *
 * Only safe because that deadline is hard. The provider port holds its abort
 * timer until the response body has been read as well as the headers
 * (`transcribeWithOpenAi`), so a claim cannot go stale while the call that
 * holds it is still waiting on the provider (review r-20261127-110354-67c5f8).
 * A test pins the order of the two numbers.
 */
export const AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS =
    Math.ceil(CHAT_AUDIO_TRANSCRIPTION_TIMEOUT_MS / 1000) + 30;

/**
 * The bound attachment row a recording is claimed and stored on, or null.
 *
 * Keyed on the recording, not on how the request named it: a reference by
 * attachment id is that row; a reference by upload id is the row the upload
 * was bound to, when it has been -- same account, same stored object. An
 * upload nothing has bound has no row, and is not transcribed
 * (review r-20261127-110354-67c5f8: two requests naming one unbound upload
 * used to transcribe it twice).
 */
export const resolveRecordingAttachmentId = async (input: {
    userId: string;
    attachmentId: string | null;
    uploadId: string | null;
    objectKey: string;
}): Promise<string | null> => {
    if (input.attachmentId) return input.attachmentId;
    if (!input.uploadId) return null;
    const row = await prisma.messageAttachment.findFirst({
        where: { uploadId: input.uploadId, userId: input.userId, objectKey: input.objectKey },
        select: { id: true },
    });
    return row?.id ?? null;
};
/** How often a waiting request looks again. */
export const AUDIO_TRANSCRIPT_CLAIM_POLL_MS = 500;

export type AudioTranscriptStore = {
    read: (attachmentId: string) => Promise<CachedAttachmentText[] | null>;
    claim: (attachmentId: string, token: string, staleSeconds: number) => Promise<boolean>;
    write: (attachmentId: string, entries: readonly CachedAttachmentText[]) => Promise<unknown>;
    release: (attachmentId: string, token: string) => Promise<unknown>;
    wait: (ms: number, signal?: AbortSignal) => Promise<void>;
    now: () => number;
};

const pause = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });

const defaultStore = (): AudioTranscriptStore => ({
    read: readAttachmentTextCache,
    claim: claimAttachmentTextCache,
    write: writeAttachmentTextCache,
    release: releaseAttachmentTextClaim,
    wait: pause,
    now: Date.now,
});

/**
 * The transcript of a bound attachment, paid for by one request only.
 *
 * Review r-20261127-082100-427572: several models answering the same message
 * are several requests, and each used to miss the cache, transcribe and book
 * the seconds again. Now the first to claim the attachment
 * (`claimAttachmentTextCache`, one statement) transcribes and stores the
 * transcript; the others wait for it and read it. A claim is never extended,
 * so a request that died stops blocking the rest once it is
 * `AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS` old, and the next one takes over.
 *
 * A failed transcription gives its claim back and the next waiter tries in
 * its turn -- one at a time, never side by side. A wait that outlives a stale
 * claim (a store that keeps answering "taken" without a transcript to read)
 * transcribes without the claim, the behaviour before it existed, rather than
 * failing a turn it could answer.
 */
export const transcribeAudioAttachmentOnce = async (
    input: Parameters<typeof transcribeAudioAttachment>[0] & {
        attachmentId: string;
        signal?: AbortSignal;
    },
    deps: { store?: AudioTranscriptStore; transcription?: AudioTranscriptionDeps } = {}
): Promise<CachedAttachmentText[]> => {
    const store = deps.store ?? defaultStore();
    const { attachmentId, signal, ...transcription } = input;
    const token = randomUUID();
    const giveUpAt =
        store.now() + AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS * 1000 + 2 * AUDIO_TRANSCRIPT_CLAIM_POLL_MS;
    for (;;) {
        signal?.throwIfAborted();
        const cached = await store.read(attachmentId);
        if (cached) return cached;
        let claimed: boolean;
        try {
            claimed = await store.claim(attachmentId, token, AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS);
        } catch {
            // The claim is an economy, not a permission: without it the
            // transcription is still booked against the seconds budget.
            report({ outcome: "claim_unavailable", traceId: input.traceId });
            return [await transcribeAudioAttachment(transcription, deps.transcription)];
        }
        if (claimed) {
            try {
                const entry = await transcribeAudioAttachment(transcription, deps.transcription);
                await store.write(attachmentId, [entry]).catch(() => undefined);
                return [entry];
            } finally {
                await store.release(attachmentId, token).catch(() => undefined);
            }
        }
        if (store.now() > giveUpAt) {
            report({ outcome: "claim_wait_exhausted", traceId: input.traceId });
            return [await transcribeAudioAttachment(transcription, deps.transcription)];
        }
        await store.wait(AUDIO_TRANSCRIPT_CLAIM_POLL_MS, signal);
    }
};
