import "server-only";

import { randomUUID } from "node:crypto";

import {
    claimAttachmentTextCache,
    readAttachmentTranscriptOutcome,
    readInheritedTranscriptOutcome,
    releaseAttachmentTextClaim,
    renewAttachmentTextClaim,
    writeAttachmentNoTextOutcome,
    writeAudioTranscript,
    type AudioTranscriptOutcome,
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

/**
 * What the caller learns about the one paid call this transcription may make.
 *
 * `mayHaveBeenPaid` turns true immediately before the provider is asked and
 * turns false again only when the port answers with a failure it classifies
 * as costing nothing -- `not_sent` or `refused`, the voice route's own
 * classification (`dispositionFor` in lib/voiceTranscriptionPortCore.ts,
 * docs/policy/voice-input.md section 7.2). Every other way out of the call --
 * a transcript, no speech, an indeterminate failure, a throw, a settlement that
 * failed after the answer -- leaves it true.
 */
export type PaidCall = {
    mayHaveBeenPaid: boolean;
    /** Runs once the seconds are booked, just before the call; a throw stops it. */
    beforeProviderCall?: () => Promise<void>;
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
    deps: AudioTranscriptionDeps = defaultDeps(),
    call: PaidCall = { mayHaveBeenPaid: false }
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
        await call.beforeProviderCall?.();
        call.mayHaveBeenPaid = true;
        // A throw from the call is an outcome nobody knows: the port reports
        // what it can classify, and anything else is treated as the
        // indeterminate failure it is -- seconds kept, nothing claimed back.
        const result = await transcribe({
            audio: input.bytes,
            mediaType: input.mediaType,
            extension: input.extension,
            languageHint: null,
            timeoutMs: CHAT_AUDIO_TRANSCRIPTION_TIMEOUT_MS,
        }).catch(() => ({
            ok: false as const,
            code: "provider_unreachable" as const,
            status: null,
            disposition: "indeterminate" as const,
        }));
        if (!result.ok) {
            // The voice route's rule (docs/policy/voice-input.md section 7.2):
            // a call whose outcome is unknown keeps its reservation, one the
            // provider refused or that was never sent gives it all back.
            const basis: VoiceSettlementBasis =
                result.disposition === "indeterminate"
                    ? { kind: "reservation" }
                    : { kind: "not_billed" };
            if (basis.kind === "not_billed") call.mayHaveBeenPaid = false;
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
        // Reached unsettled only when something threw before the provider was
        // asked (`beforeProviderCall`), so nothing was billed.
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
 * The window is measured from the renewal just before the call, not from the
 * claim, so slow bookings ahead of it do not eat into it
 * (review r-20261127-122037-b72ce5). A test pins the order of the two numbers.
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
    /** The stored transcript, "no_text" for a recording found to hold no speech, or null. */
    read: (attachmentId: string) => Promise<AudioTranscriptOutcome | null>;
    /** The same, from the attachment this one was copied from (a resend, an edit). */
    readInherited: (attachmentId: string) => Promise<AudioTranscriptOutcome | null>;
    claim: (attachmentId: string, token: string, staleSeconds: number) => Promise<boolean>;
    /** True only while this token still holds the claim; restarts its clock. */
    renew: (attachmentId: string, token: string) => Promise<boolean>;
    /** Resolves true when the transcript is stored. */
    write: (attachmentId: string, entries: readonly CachedAttachmentText[]) => Promise<boolean>;
    /** Resolves true when "no speech" is stored. */
    writeNoText: (attachmentId: string) => Promise<boolean>;
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
    read: readAttachmentTranscriptOutcome,
    readInherited: readInheritedTranscriptOutcome,
    claim: claimAttachmentTextCache,
    renew: renewAttachmentTextClaim,
    write: writeAudioTranscript,
    writeNoText: writeAttachmentNoTextOutcome,
    release: releaseAttachmentTextClaim,
    wait: pause,
    now: Date.now,
});

/**
 * A recording's paid result, its own or its original's, without claiming or
 * paying for anything: what an earlier message reads when a new transcription
 * is not allowed (the audio switch off). Null when none is stored or the
 * store cannot answer.
 */
export const readStoredAudioTranscript = async (
    attachmentId: string,
    store: Pick<AudioTranscriptStore, "read" | "readInherited"> = defaultStore()
): Promise<AudioTranscriptOutcome | null> =>
    (await store.read(attachmentId).catch(() => null)) ??
    (await store.readInherited(attachmentId).catch(() => null));

/** Retryable, and nothing was paid: another request has, or will. */
const transcriptionBusy = () =>
    new ChatAccessError(
        503,
        "AUDIO_TRANSCRIPTION_UNAVAILABLE",
        "The recording could not be transcribed right now. Try again shortly."
    );

const noSpeech = () =>
    new ChatAccessError(
        422,
        "ATTACHMENT_NO_TEXT",
        "The attached recording contains no speech that could be transcribed."
    );

/**
 * The transcript of a bound attachment, paid for by the request that holds
 * its claim and by no other.
 *
 * Several models answering one message are several requests; the first to
 * claim the attachment (`claimAttachmentTextCache`, one statement) books,
 * transcribes and stores the result, and the rest wait for it and read it.
 * A request that cannot take the claim -- the store failed, or the wait ran
 * out -- never pays: it ends in a retryable refusal (the message being
 * answered fails with it, an earlier one leaves the file out).
 *
 * One rule decides whether the claim is given back (review
 * r-20261127-122037-b72ce5): only when nothing can have been paid for.
 * `PaidCall.mayHaveBeenPaid` is set just before the provider is asked and is
 * cleared only by a failure the voice route already classifies as costing
 * nothing; `finally` reads that flag and nothing else. Every way out once the
 * claim is held:
 *
 *   way out                                       paid?          claim
 *   seconds refused, or the booking failed        no call        given back
 *   claim no longer ours at the renewal           no call        given back (a no-op)
 *   provider answered `not_sent` / `refused`      certainly not  given back
 *   provider indeterminate (timeout, 5xx, body)   may have been  kept until stale
 *   the call threw                                may have been  kept until stale
 *   settlement threw after the answer             may have been  kept until stale
 *   transcript, stored (one retry)                yes            replaced by it
 *   transcript, not stored                        yes            kept until stale
 *   no speech, stored / not stored                yes            replaced / kept
 *
 * Just before the call the claim is renewed (`renewAttachmentTextClaim`: still
 * this token's, clock restarted, one statement). A request whose bookings were
 * slow enough for its claim to be taken over learns so before it pays, and
 * the call starts with the whole stale window ahead: the provider deadline,
 * body included, inside it, then 30 seconds for the settlement and the store.
 * Left over: a settlement or store still running past those 30 seconds lets
 * the next request take the stale claim and pay again; and a kept claim
 * makes requests for that recording wait and be refused until it is stale,
 * when the first of them pays again -- at most once per stale window.
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
    /** Stores a paid result, once more on failure; logs when it would not stay. */
    const keep = async (write: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (await write().catch(() => false)) return;
        }
        report({ outcome: "transcript_store_failed", traceId: input.traceId });
    };
    for (let first = true; ; first = false) {
        signal?.throwIfAborted();
        let stored = await store.read(attachmentId).catch(() => null);
        if (!stored && first) {
            // A copy of a recording already paid for (a resend, an edit) takes
            // its original's result instead of paying again, and stores it on
            // this row so the next turn finds it directly.
            stored = await store.readInherited(attachmentId).catch(() => null);
            if (stored) {
                const outcome = stored;
                await (outcome === "no_text"
                    ? store.writeNoText(attachmentId)
                    : store.write(attachmentId, outcome)
                ).catch(() => false);
            }
        }
        if (stored === "no_text") throw noSpeech();
        if (stored) return stored;
        let claimed: boolean;
        try {
            claimed = await store.claim(attachmentId, token, AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS);
        } catch {
            report({ outcome: "claim_unavailable", traceId: input.traceId });
            throw transcriptionBusy();
        }
        if (claimed) {
            const call: PaidCall = {
                mayHaveBeenPaid: false,
                beforeProviderCall: async () => {
                    if (await store.renew(attachmentId, token).catch(() => false)) return;
                    report({ outcome: "claim_lost", traceId: input.traceId });
                    throw transcriptionBusy();
                },
            };
            try {
                let entry: { kind: string; text: string };
                try {
                    entry = await transcribeAudioAttachment(transcription, deps.transcription, call);
                } catch (error) {
                    if ((error as { code?: unknown } | null)?.code === "ATTACHMENT_NO_TEXT") {
                        await keep(() => store.writeNoText(attachmentId));
                    }
                    throw error;
                }
                await keep(() => store.write(attachmentId, [entry]));
                return [entry];
            } finally {
                // The table above: given back only when nothing can have been paid.
                if (!call.mayHaveBeenPaid) await store.release(attachmentId, token).catch(() => undefined);
            }
        }
        if (store.now() > giveUpAt) {
            report({ outcome: "claim_wait_exhausted", traceId: input.traceId });
            throw transcriptionBusy();
        }
        await store.wait(AUDIO_TRANSCRIPT_CLAIM_POLL_MS, signal);
    }
};
