/**
 * Audio attachments: the switch, the limits and the length check.
 *
 * Contract: docs/policy/chat-attachment-formats.md section 2.4.
 *
 * Pure and framework-free, so every rule here is tested without a network, a
 * database or a provider. The transcription itself, and the seconds budget it
 * is booked against, are `lib/chatAudioAttachment.ts`.
 *
 * ## Why the length is read before anything is paid for
 *
 * The transcript is bought from the same provider, the same model and the same
 * seconds budget as voice input (docs/policy/voice-input.md section 6.1-4), and
 * that budget is denominated in seconds. A recording whose length cannot be
 * read cannot be reserved honestly: voice input reserves an unknown clip at its
 * 120-second ceiling, but an attachment has no such ceiling of its own -- a
 * 25 MB file can hold hours. So an attachment whose length is unknown is
 * refused, not reserved at a guess.
 */

import { inspectVoiceClip } from "@/lib/voiceClipDuration";

export const CHAT_AUDIO_ATTACHMENT_ENV = "CHAT_AUDIO_ATTACHMENT_ENABLED";

/** `"true"` and nothing else, the same reading every default-off switch here takes. */
export const chatAudioAttachmentSwitchOn = (
    env: Readonly<Record<string, string | undefined>>
) => env[CHAT_AUDIO_ATTACHMENT_ENV] === "true";

/**
 * The provider's own per-file ceiling (OpenAI speech-to-text guide, "Files can
 * be up to 25 MB", read 2026-11-27). The chat attachment ceiling still applies
 * when it is lower; the route takes the smaller of the two.
 */
export const CHAT_AUDIO_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The longest recording one transcription is asked to cover.
 *
 * The configured model returns at most 2,000 output tokens
 * (`gpt-4o-mini-transcribe` model page, read 2026-11-27), and the one paid
 * measurement on record spoke 190.6 tokens a minute (docs/policy/voice-input.md
 * section 6.1.3). Ten minutes is about where an ordinary speaker reaches that
 * ceiling, so a longer file would come back cut short while being billed in
 * full. Splitting a recording into several calls needs audio decoding this
 * product does not have.
 */
export const CHAT_AUDIO_ATTACHMENT_MAX_SECONDS = 10 * 60;

/** The documented output ceiling above, as a number the transcript is checked against. */
export const CHAT_AUDIO_TRANSCRIPT_MAX_OUTPUT_TOKENS = 2_000;

/**
 * How long one transcription may take. Voice input's 30 seconds is sized for a
 * two-minute clip; a ten-minute recording needs room, and a timeout is an
 * indeterminate outcome that keeps its reservation, so it should be rare.
 */
export const CHAT_AUDIO_TRANSCRIPTION_TIMEOUT_MS = 120_000;

export type AudioAttachmentInspection =
    | { ok: true; durationSeconds: number; durationSource: "ebml" | "mp4" | "riff" | "mpeg-frames" }
    | {
          ok: false;
          /** Codes the attachment error copy already explains, plus the length one. */
          code: "ATTACHMENT_TYPE_MISMATCH" | "ATTACHMENT_UNREADABLE" | "ATTACHMENT_AUDIO_TOO_LONG";
      };

/**
 * The container's length, read from the bytes, or why the file is refused.
 *
 * `mediaType` is the format table's canonical type -- the name has already
 * decided which format this is, and the bytes now have to agree.
 */
export const inspectAudioAttachment = (input: {
    bytes: Uint8Array;
    mediaType: string;
}): AudioAttachmentInspection => {
    let durationSeconds: number | null;
    let durationSource: "ebml" | "mp4" | "riff" | "mpeg-frames";
    if (input.mediaType === "audio/mpeg") {
        durationSeconds = mp3DurationSeconds(input.bytes);
        durationSource = "mpeg-frames";
    } else {
        const inspection = inspectVoiceClip({
            bytes: input.bytes,
            declaredMediaType: input.mediaType,
        });
        if (!inspection.ok) return { ok: false, code: "ATTACHMENT_TYPE_MISMATCH" };
        if (inspection.durationSource === "unknown") {
            return { ok: false, code: "ATTACHMENT_UNREADABLE" };
        }
        durationSeconds = inspection.durationSeconds;
        durationSource = inspection.durationSource;
    }
    if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return { ok: false, code: "ATTACHMENT_UNREADABLE" };
    }
    if (durationSeconds > CHAT_AUDIO_ATTACHMENT_MAX_SECONDS) {
        return { ok: false, code: "ATTACHMENT_AUDIO_TOO_LONG" };
    }
    return { ok: true, durationSeconds, durationSource };
};

// ---------------------------------------------------------------------------
// MPEG audio (mp3): the length is what the frames add up to
// ---------------------------------------------------------------------------

/**
 * Bytes after the last frame that may be ignored: ID3v1, APE and Lyrics tags.
 * More than this is something a decoder could resynchronise on and play, so
 * the length the frames add up to would no longer bound what is transcribed.
 */
const MP3_TRAILING_TAG_ALLOWANCE = 256 * 1024;

// Bitrates in kbit/s, indexed by the header's 4-bit field. Index 0 ("free") and
// 15 ("bad") are refused: a free-format stream has no length this can compute.
const BITRATES_V1: Record<1 | 2 | 3, readonly number[]> = {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const BITRATES_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const BITRATES_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
// By the header's 2-bit version field: 0 = MPEG 2.5, 2 = MPEG 2, 3 = MPEG 1.
const SAMPLE_RATES: Record<number, readonly number[]> = {
    0: [11025, 12000, 8000],
    2: [22050, 24000, 16000],
    3: [44100, 48000, 32000],
};

type Mp3Frame = { length: number; samples: number; sampleRate: number };

const readMp3Frame = (bytes: Uint8Array, offset: number): Mp3Frame | null => {
    if (offset + 4 > bytes.length) return null;
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
    const version = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    if (version === 1 || layerBits === 0) return null;
    const layer = (4 - layerBits) as 1 | 2 | 3;
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const sampleRateIndex = (b2 >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
    const padding = (b2 >> 1) & 0x01;
    const isV1 = version === 3;
    const bitrate =
        (isV1
            ? BITRATES_V1[layer][bitrateIndex]
            : layer === 1
              ? BITRATES_V2_L1[bitrateIndex]
              : BITRATES_V2_L23[bitrateIndex]) * 1000;
    const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
    const samples = layer === 1 ? 384 : layer === 2 || isV1 ? 1152 : 576;
    const length =
        layer === 1
            ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
            : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
    if (length < 4) return null;
    return { length, samples, sampleRate };
};

/**
 * Seconds of audio in an mp3, from walking every frame, or `null`.
 *
 * Every frame rather than the first one's bitrate or a Xing header, because
 * both of those are the file describing itself, and a header claiming 320
 * kbit/s over frames encoded at 8 would make the reserved length forty times
 * shorter than what the provider decodes. The walk is bounded by the file:
 * each step advances by at least four bytes.
 */
export const mp3DurationSeconds = (bytes: Uint8Array): number | null => {
    let offset = 0;
    // ID3v2 at the front: "ID3", version, flags, then a 28-bit syncsafe size.
    if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        const size =
            ((bytes[6] & 0x7f) << 21) |
            ((bytes[7] & 0x7f) << 14) |
            ((bytes[8] & 0x7f) << 7) |
            (bytes[9] & 0x7f);
        const footer = (bytes[5] & 0x10) !== 0 ? 10 : 0;
        offset = 10 + size + footer;
    }
    let seconds = 0;
    let frames = 0;
    for (;;) {
        const frame = readMp3Frame(bytes, offset);
        if (!frame) break;
        if (offset + frame.length > bytes.length) break;
        seconds += frame.samples / frame.sampleRate;
        frames += 1;
        offset += frame.length;
    }
    if (frames === 0) return null;
    if (bytes.length - offset > MP3_TRAILING_TAG_ALLOWANCE) return null;
    return seconds;
};

// ---------------------------------------------------------------------------
// The transcript as the model receives it
// ---------------------------------------------------------------------------

export const AUDIO_TRANSCRIPT_KIND = "audio transcript";
export const AUDIO_TRANSCRIPT_MAY_BE_INCOMPLETE_KIND =
    "audio transcript (may end before the recording does)";

/**
 * The transcript as an extracted-text entry, or `null` when there was no speech.
 *
 * A transcript that used the model's whole output allowance may have been cut
 * off, and the provider does not say whether it was. The entry is named so the
 * model can tell the person rather than summarise a meeting it only heard half
 * of; the transcript itself is never trimmed or padded.
 */
export const audioTranscriptEntry = (input: {
    text: string;
    outputTokens: number | null;
}): { kind: string; text: string } | null => {
    const text = input.text.trim();
    if (!text) return null;
    const mayBeIncomplete =
        input.outputTokens !== null &&
        input.outputTokens >= CHAT_AUDIO_TRANSCRIPT_MAX_OUTPUT_TOKENS - 10;
    return {
        kind: mayBeIncomplete ? AUDIO_TRANSCRIPT_MAY_BE_INCOMPLETE_KIND : AUDIO_TRANSCRIPT_KIND,
        text,
    };
};
