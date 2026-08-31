import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { inspectVoiceClip } from "../lib/voiceClipDuration.ts";
import {
  VOICE_CLIP_MAX_BYTES,
  VOICE_CLIP_MAX_SECONDS,
  VOICE_CLIP_MIN_BYTES,
  VOICE_CLIP_REFUSAL_SECONDS,
  VOICE_CLIP_FORMATS,
  VOICE_RECORDER_MIME_PREFERENCE,
  voiceClipFormatFor,
} from "../lib/voiceInputFormats.ts";

/**
 * Container identification and the length limit: docs/policy/voice-input.md §5.
 *
 * ## The fixtures are real recordings
 *
 * AGENTS.md, "채팅 첨부 형식과 압축파일": a binary parser's happy path is tested
 * with real documents, because a fixture our own writer produced only proves
 * that the writer and the parser agree with each other. These came out of
 * Chromium's `MediaRecorder` via `scripts/make-voice-fixtures.mjs`, so a
 * change that stops reading what browsers actually emit fails here.
 *
 * The refusal paths are built byte by byte, which is the opposite requirement:
 * a malformed container has to be malformed in a specific way.
 */

const fixture = (name) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./fixtures/voice/${name}`, import.meta.url)))
  );

const WEBM_2500MS = fixture("chromium-webm-opus-2500ms.webm");
const MP4_3000MS = fixture("chromium-mp4-aac-3000ms.mp4");
const WEBM_400MS = fixture("chromium-webm-opus-400ms.webm");

test("a real Chromium WebM recording declares its own length", () => {
  const result = inspectVoiceClip({
    bytes: WEBM_2500MS,
    // Exactly what `MediaRecorder` reports, codec parameter and all: the
    // allowlist keys on the container, and a parameter must not defeat it.
    declaredMediaType: "audio/webm;codecs=opus",
  });

  assert.equal(result.ok, true);
  assert.equal(result.format.mediaType, "audio/webm");
  assert.equal(result.durationSource, "ebml");
  // The recorder was asked for 2500 ms and wrote what it actually encoded.
  assert.ok(
    result.durationSeconds > 2 && result.durationSeconds < 3,
    `expected about 2.4s, got ${result.durationSeconds}`
  );
});

test("a real Chromium MP4 recording declares its own length", () => {
  const result = inspectVoiceClip({
    bytes: MP4_3000MS,
    declaredMediaType: "audio/mp4",
  });

  assert.equal(result.ok, true);
  assert.equal(result.durationSource, "mp4");
  assert.ok(
    result.durationSeconds > 2.5 && result.durationSeconds < 3.5,
    `expected about 3s, got ${result.durationSeconds}`
  );
});

test("a very short real recording is measured, not rounded to nothing", () => {
  const result = inspectVoiceClip({
    bytes: WEBM_400MS,
    declaredMediaType: "audio/webm",
  });

  assert.equal(result.ok, true);
  assert.ok(result.durationSeconds > 0 && result.durationSeconds < 1);
  // And it is below the byte floor, which is how the accidental
  // start-and-stop-in-one-gesture recording is refused.
  assert.ok(
    WEBM_400MS.byteLength < VOICE_CLIP_MIN_BYTES,
    "a 400ms recording should be under the empty-clip floor"
  );
});

test("the bytes decide, not the declaration", () => {
  const result = inspectVoiceClip({
    bytes: MP4_3000MS,
    declaredMediaType: "audio/webm",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "VOICE_CLIP_TYPE_MISMATCH");
});

test("a container this product does not accept is refused", () => {
  // A real Ogg header. Firefox will record this happily; the transcription
  // provider does not accept it, so admitting it would move the refusal from
  // before the recording to after it.
  const ogg = new Uint8Array(64);
  ogg.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"

  assert.equal(voiceClipFormatFor("audio/ogg"), null);
  assert.equal(
    inspectVoiceClip({ bytes: ogg, declaredMediaType: "audio/ogg" }).code,
    "VOICE_CLIP_UNREADABLE"
  );
});

test("bytes that are not a container at all are refused", () => {
  const noise = new Uint8Array([...Array(64).keys()]);

  assert.equal(
    inspectVoiceClip({ bytes: noise, declaredMediaType: "audio/webm" }).code,
    "VOICE_CLIP_UNREADABLE"
  );
});

test("a truncated real recording does not crash the walk", () => {
  // Cut inside the first cluster: the header is intact, the rest is not.
  for (const length of [8, 40, 120, 300, 1000]) {
    const result = inspectVoiceClip({
      bytes: WEBM_2500MS.slice(0, length),
      declaredMediaType: "audio/webm",
    });
    // Either it reads a length or it does not; what it may never do is throw.
    if (result.ok) {
      assert.ok(result.durationSeconds === null || result.durationSeconds > 0);
    } else {
      assert.equal(result.code, "VOICE_CLIP_UNREADABLE");
    }
  }
});

test("an EBML file with no Info Duration reports unknown rather than refusing", () => {
  // Safari's fragmented MP4 is believed to be able to do this and cannot be
  // observed from this container (docs/ops/voice-input-staging-checklist.md
  // D-3), so the *behaviour* is pinned here with a container that certainly
  // does: an EBML header and a Segment with no Info at all.
  const bytes = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x00, 0x00, 0x00, 0x00, // EBML header
    0x18, 0x53, 0x80, 0x67, 0x84, 0x00, 0x00, 0x00, 0x00, // Segment, 4 empty bytes
  ]);
  const result = inspectVoiceClip({ bytes, declaredMediaType: "audio/webm" });

  assert.equal(result.ok, true, "an unreadable length is an absence, not a refusal");
  assert.equal(result.durationSeconds, null);
  assert.equal(result.durationSource, "unknown");
});

test("a WAV header is measured exactly", () => {
  // 16-bit mono at 8000 Hz => 16000 bytes per second. 32000 data bytes = 2s.
  const dataBytes = 32_000;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (text, offset) => {
    for (let index = 0; index < text.length; index++) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii("RIFF", 0);
  view.setUint32(4, 36 + dataBytes, true);
  ascii("WAVE", 8);
  ascii("fmt ", 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 16_000, true); // byte rate
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii("data", 36);
  view.setUint32(40, dataBytes, true);

  const result = inspectVoiceClip({ bytes, declaredMediaType: "audio/wav" });
  assert.equal(result.ok, true);
  assert.equal(result.durationSource, "riff");
  assert.equal(result.durationSeconds, 2);
});

test("a WAV that declares more data than it carries is measured by what arrived", () => {
  const bytes = new Uint8Array(44 + 8_000);
  const view = new DataView(bytes.buffer);
  const ascii = (text, offset) => {
    for (let index = 0; index < text.length; index++) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii("RIFF", 0);
  ascii("WAVE", 8);
  ascii("fmt ", 12);
  view.setUint32(16, 16, true);
  view.setUint32(28, 16_000, true);
  ascii("data", 36);
  // Claims 10 minutes; carries half a second.
  view.setUint32(40, 16_000 * 600, true);

  const result = inspectVoiceClip({ bytes, declaredMediaType: "audio/wav" });
  assert.equal(result.ok, true);
  assert.equal(
    result.durationSeconds,
    0.5,
    "a declared length must never outweigh the bytes actually present"
  );
});

test("every recorder preference resolves to a format in the table", () => {
  for (const candidate of VOICE_RECORDER_MIME_PREFERENCE) {
    assert.ok(
      voiceClipFormatFor(candidate),
      `${candidate} is offered to MediaRecorder but the server would refuse it`
    );
  }
});

test("the limits stay in the relationship the policy describes", () => {
  assert.ok(VOICE_CLIP_MIN_BYTES < VOICE_CLIP_MAX_BYTES);
  assert.ok(
    VOICE_CLIP_REFUSAL_SECONDS > VOICE_CLIP_MAX_SECONDS,
    "the refusal threshold must leave room for the recorder's own rounding"
  );
  // Below the provider's own 25 MB ceiling, so a clip this endpoint accepts is
  // never one the provider refuses for size.
  assert.ok(VOICE_CLIP_MAX_BYTES < 25 * 1024 * 1024);
  // Every format must be one the provider accepts. The list is from the
  // OpenAI speech-to-text guide, read 2026-08-30.
  const providerAccepts = new Set(["webm", "mp4", "wav", "mp3", "mpeg", "mpga", "m4a"]);
  for (const format of VOICE_CLIP_FORMATS) {
    assert.ok(
      providerAccepts.has(format.extension),
      `${format.extension} is in the table but the provider does not accept it`
    );
  }
});
