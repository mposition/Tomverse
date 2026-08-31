/**
 * What a voice clip's own bytes say it is, and how long it says it runs.
 *
 * Contract: docs/policy/voice-input.md §5.2.
 *
 * Pure: bytes in, a verdict out. No `server-only`, no Prisma, no `next` — the
 * endpoint calls it, and a test drives it with a real recording rather than a
 * request.
 *
 * ## Why the container is read at all
 *
 * A declared media type is a claim. Reading the first bytes turns it into a
 * fact, which is the same rule the attachment pipeline follows: the name and
 * the type are hints, and disagreement is a refusal
 * (AGENTS.md, "채팅 첨부 형식과 압축파일").
 *
 * ## Why duration is read, and what it can honestly promise
 *
 * The upload ceiling bounds bytes. Bytes bound provider cost only loosely,
 * because cost is charged per second of audio and a low-bitrate container can
 * hold a great many seconds inside a small file. So the length is read from
 * the container before anything is sent anywhere.
 *
 * What this can promise is bounded by what recorders actually write, and that
 * was measured rather than assumed. Against real `MediaRecorder` output from
 * Chromium 1194:
 *
 *   * `audio/webm` carries `Segment > Info > TimecodeScale` and
 *     `Segment > Info > Duration`. A 2.5s recording declared 2400.6 (× 1 ms).
 *   * `audio/mp4` is fragmented (`moov`/`moof`/`mdat`) and its `mvhd` is
 *     populated: a 3.0s recording declared duration 2960 at timescale 1000.
 *
 * Both are therefore refusable *before* a provider call. What has **not** been
 * observed here is Safari, which is the only engine that records MP4 in
 * production and cannot be run in this container. A fragmented MP4 is entitled
 * to write `mvhd.duration = 0` and leave the length to its fragments, so
 * `unknown` is a real outcome and is treated as one: it is not a refusal, it is
 * an absence, and it is reported so the caller can log it and the operational
 * budget can still book the provider's own measurement afterwards
 * (docs/policy/voice-input.md §7). Confirming Safari's behaviour is item D-3 on
 * docs/ops/voice-input-staging-checklist.md, and until somebody has actually
 * looked, this file claims nothing about it.
 *
 * Refusing every clip whose length could not be read would have been the
 * tidier rule and the wrong one: it would make voice input unusable on an
 * entire browser engine on the strength of a guess about that engine.
 */

import {
  VOICE_CLIP_FORMATS,
  voiceClipFormatFor,
  type VoiceClipFormat,
} from "@/lib/voiceInputFormats";

export type VoiceClipInspection =
  | {
      ok: true;
      format: VoiceClipFormat;
      /** Seconds, or `null` when the container did not declare a length. */
      durationSeconds: number | null;
      /** How the number above was obtained, for the structured log. */
      durationSource: "ebml" | "mp4" | "riff" | "unknown";
    }
  | { ok: false; code: VoiceClipInspectionRefusal };

export type VoiceClipInspectionRefusal =
  /** The bytes are not any container this product accepts. */
  | "VOICE_CLIP_UNREADABLE"
  /** The bytes are a container we accept, but not the one that was declared. */
  | "VOICE_CLIP_TYPE_MISMATCH";

/**
 * A hard stop on how much of a container this walks.
 *
 * The same reasoning as `lib/legacyOffice/budget.ts`: these are loops over
 * attacker-supplied lengths, and a malformed file that costs a bounded amount
 * of work is a refusal, while one that costs an unbounded amount is an outage.
 * Every loop below counts against it.
 */
const MAX_ELEMENTS_SCANNED = 4_096;

// ---------------------------------------------------------------------------
// Container identification
// ---------------------------------------------------------------------------

const startsWith = (buffer: Uint8Array, bytes: readonly number[]) =>
  bytes.every((byte, index) => buffer[index] === byte);

/** EBML magic: every Matroska and WebM file opens with it. */
const isEbml = (buffer: Uint8Array) =>
  startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3]);

/** ISO base media: a box whose type at offset 4 is `ftyp`. */
const isIsoBmff = (buffer: Uint8Array) =>
  buffer.length >= 12 &&
  buffer[4] === 0x66 &&
  buffer[5] === 0x74 &&
  buffer[6] === 0x79 &&
  buffer[7] === 0x70;

/** RIFF/WAVE. */
const isRiffWave = (buffer: Uint8Array) =>
  buffer.length >= 12 &&
  startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
  buffer[8] === 0x57 &&
  buffer[9] === 0x41 &&
  buffer[10] === 0x56 &&
  buffer[11] === 0x45;

const sniffMediaType = (buffer: Uint8Array): string | null => {
  if (isEbml(buffer)) return "audio/webm";
  if (isIsoBmff(buffer)) return "audio/mp4";
  if (isRiffWave(buffer)) return "audio/wav";
  return null;
};

// ---------------------------------------------------------------------------
// EBML (WebM)
// ---------------------------------------------------------------------------

type Vint = { value: number; length: number; unknown: boolean };

/**
 * Reads one EBML variable-length integer.
 *
 * `keepMarker` distinguishes the two uses the format makes of the same
 * encoding: an element *ID* keeps its leading marker bit (the ID is the whole
 * byte sequence), while a *size* strips it. Getting that backwards silently
 * shifts every subsequent offset, which is why they are one function with a
 * flag rather than two that could drift apart.
 */
const readVint = (
  buffer: Uint8Array,
  offset: number,
  keepMarker: boolean
): Vint | null => {
  const first = buffer[offset];
  if (first === undefined || first === 0) return null;
  let length = 1;
  for (let mask = 0x80; mask > 0; mask >>= 1) {
    if (first & mask) break;
    length++;
  }
  if (length > 8 || offset + length > buffer.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  // All data bits set means "unknown size" — a live-written element whose
  // length was not known when the header went out.
  let unknown = (first & (0xff >> length)) === (0xff >> length);
  for (let index = 1; index < length; index++) {
    const byte = buffer[offset + index];
    value = value * 256 + byte;
    if (byte !== 0xff) unknown = false;
  }
  // 2^53: beyond this the arithmetic above is no longer exact, and an
  // inexact size is not a size.
  if (!Number.isSafeInteger(value)) return null;
  return { value, length, unknown: unknown && !keepMarker };
};

const EBML_SEGMENT = "18538067";
const EBML_INFO = "1549a966";
const EBML_TIMECODE_SCALE = "2ad7b1";
const EBML_DURATION = "4489";

const readUnsignedInteger = (
  buffer: Uint8Array,
  start: number,
  end: number
): number | null => {
  if (end <= start || end - start > 8) return null;
  let value = 0;
  for (let index = start; index < end; index++) value = value * 256 + buffer[index];
  return Number.isSafeInteger(value) ? value : null;
};

const readFloat = (
  buffer: Uint8Array,
  start: number,
  end: number
): number | null => {
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset + start,
    end - start
  );
  if (end - start === 4) return view.getFloat32(0);
  if (end - start === 8) return view.getFloat64(0);
  return null;
};

/**
 * Walks Segment > Info and returns the declared length in seconds.
 *
 * Deliberately shallow. Only three elements matter, they sit at a known depth,
 * and descending further would mean walking clusters — thousands of blocks
 * whose timecodes would let us *reconstruct* a duration the container already
 * told us. `null` when the file does not say, which the caller treats as an
 * absence rather than a refusal.
 */
const ebmlDurationSeconds = (buffer: Uint8Array): number | null => {
  let scanned = 0;

  const findChild = (
    start: number,
    end: number,
    wantedId: string
  ): { start: number; end: number } | null => {
    let offset = start;
    while (offset < end && scanned < MAX_ELEMENTS_SCANNED) {
      scanned++;
      const id = readVint(buffer, offset, true);
      if (!id) return null;
      const size = readVint(buffer, offset + id.length, false);
      if (!size) return null;
      const contentStart = offset + id.length + size.length;
      // An unknown-size master runs to the end of its parent. That is exactly
      // what a live-written Segment does, and it is why this cannot simply
      // trust `size.value`.
      const contentEnd = size.unknown
        ? end
        : Math.min(end, contentStart + size.value);
      if (contentEnd < contentStart) return null;
      let idHex = "";
      for (let index = offset; index < offset + id.length; index++) {
        idHex += buffer[index].toString(16).padStart(2, "0");
      }
      if (idHex === wantedId) return { start: contentStart, end: contentEnd };
      // An unknown-size element we are not looking for cannot be stepped over:
      // there is no length to step. Stop rather than guess.
      if (size.unknown) return null;
      offset = contentEnd;
    }
    return null;
  };

  const segment = findChild(0, buffer.length, EBML_SEGMENT);
  if (!segment) return null;
  const info = findChild(segment.start, segment.end, EBML_INFO);
  if (!info) return null;

  const scaleElement = findChild(info.start, info.end, EBML_TIMECODE_SCALE);
  // The spec's default when the element is absent: 1 ms expressed in ns.
  const timecodeScaleNs = scaleElement
    ? readUnsignedInteger(buffer, scaleElement.start, scaleElement.end)
    : 1_000_000;
  if (!timecodeScaleNs || timecodeScaleNs <= 0) return null;

  const durationElement = findChild(info.start, info.end, EBML_DURATION);
  if (!durationElement) return null;
  const scaled = readFloat(buffer, durationElement.start, durationElement.end);
  if (scaled === null || !Number.isFinite(scaled) || scaled <= 0) return null;

  return (scaled * timecodeScaleNs) / 1_000_000_000;
};

// ---------------------------------------------------------------------------
// ISO base media (MP4 / M4A)
// ---------------------------------------------------------------------------

/**
 * Reads `moov > mvhd` and returns its declared length in seconds.
 *
 * `null` for the fragmented case where `mvhd.duration` is zero. Summing the
 * fragments would be the way to answer it, and is deliberately not done here:
 * it is a materially larger parser, the only engine believed to need it cannot
 * be observed from this container, and a parser written against a guess about
 * a format is worse than an honest `null` that the operational budget and the
 * provider's own measurement still cover (docs/policy/voice-input.md §7).
 */
const mp4DurationSeconds = (buffer: Uint8Array): number | null => {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let scanned = 0;

  const findBox = (
    start: number,
    end: number,
    wanted: string
  ): { start: number; end: number } | null => {
    let offset = start;
    while (offset + 8 <= end && scanned < MAX_ELEMENTS_SCANNED) {
      scanned++;
      let size = view.getUint32(offset);
      let headerLength = 8;
      if (size === 1) {
        // 64-bit `largesize`. Read as two 32-bit halves: the high half of a
        // legitimate audio box is always zero, and a file claiming otherwise
        // is describing something larger than this endpoint can hold anyway.
        if (offset + 16 > end) return null;
        if (view.getUint32(offset + 8) !== 0) return null;
        size = view.getUint32(offset + 12);
        headerLength = 16;
      } else if (size === 0) {
        // "to end of file"
        size = end - offset;
      }
      if (size < headerLength || offset + size > end) return null;
      let type = "";
      for (let index = offset + 4; index < offset + 8; index++) {
        type += String.fromCharCode(buffer[index]);
      }
      if (type === wanted) {
        return { start: offset + headerLength, end: offset + size };
      }
      offset += size;
    }
    return null;
  };

  const moov = findBox(0, buffer.length, "moov");
  if (!moov) return null;
  const mvhd = findBox(moov.start, moov.end, "mvhd");
  if (!mvhd) return null;

  const version = buffer[mvhd.start];
  // version + 3 flag bytes, then creation/modification times (4 bytes each at
  // version 0, 8 at version 1), then timescale and duration.
  const base = mvhd.start + 4 + (version === 1 ? 16 : 8);
  if (version === 1) {
    if (base + 12 > mvhd.end) return null;
    const timescale = view.getUint32(base);
    const durationHigh = view.getUint32(base + 4);
    const durationLow = view.getUint32(base + 8);
    if (!timescale || durationHigh !== 0) return null;
    return durationLow > 0 ? durationLow / timescale : null;
  }
  if (base + 8 > mvhd.end) return null;
  const timescale = view.getUint32(base);
  const duration = view.getUint32(base + 4);
  if (!timescale) return null;
  return duration > 0 ? duration / timescale : null;
};

// ---------------------------------------------------------------------------
// RIFF / WAVE
// ---------------------------------------------------------------------------

/** Exact: `data` chunk bytes divided by `fmt ` byte rate. */
const wavDurationSeconds = (buffer: Uint8Array): number | null => {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  let scanned = 0;
  while (offset + 8 <= buffer.length && scanned < MAX_ELEMENTS_SCANNED) {
    scanned++;
    let id = "";
    for (let index = offset; index < offset + 4; index++) {
      id += String.fromCharCode(buffer[index]);
    }
    const size = view.getUint32(offset + 4, true);
    const contentStart = offset + 8;
    if (id === "fmt " && contentStart + 12 <= buffer.length) {
      byteRate = view.getUint32(contentStart + 8, true);
    }
    if (id === "data") {
      // A truncated file declares more than it carries; the honest length is
      // what is actually present.
      dataBytes = Math.min(size, buffer.length - contentStart);
      break;
    }
    if (size <= 0) break;
    // Chunks are word-aligned.
    offset = contentStart + size + (size % 2);
  }
  if (!byteRate || byteRate <= 0 || dataBytes === null || dataBytes <= 0) {
    return null;
  }
  return dataBytes / byteRate;
};

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

export const inspectVoiceClip = (input: {
  bytes: Uint8Array;
  declaredMediaType: string;
}): VoiceClipInspection => {
  const declared = voiceClipFormatFor(input.declaredMediaType);
  if (!declared) return { ok: false, code: "VOICE_CLIP_UNREADABLE" };

  const sniffed = sniffMediaType(input.bytes);
  if (!sniffed) return { ok: false, code: "VOICE_CLIP_UNREADABLE" };
  if (sniffed !== declared.mediaType) {
    return { ok: false, code: "VOICE_CLIP_TYPE_MISMATCH" };
  }

  // The sniff decided which format this is; the declaration only had to agree
  // with it. Resolving from the sniff keeps the table the single authority for
  // how the container is then read.
  const format =
    VOICE_CLIP_FORMATS.find((entry) => entry.mediaType === sniffed) ?? declared;

  const durationSeconds =
    format.durationSource === "ebml"
      ? ebmlDurationSeconds(input.bytes)
      : format.durationSource === "mp4"
        ? mp4DurationSeconds(input.bytes)
        : format.durationSource === "riff"
          ? wavDurationSeconds(input.bytes)
          : null;

  // `"none"` cannot survive here: a format that declares it never produces a
  // number above, so the only reachable value for it is `unknown`. Written as
  // an explicit branch rather than a cast, so adding a format with a new
  // `durationSource` is a compile error here instead of a silent `"none"` in a
  // log field nothing knows how to read.
  return {
    ok: true,
    format,
    durationSeconds,
    durationSource:
      durationSeconds === null || format.durationSource === "none"
        ? "unknown"
        : format.durationSource,
  };
};
