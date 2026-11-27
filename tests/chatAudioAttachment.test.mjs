import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CHAT_ATTACHMENT_FORMATS,
  CHAT_ATTACHMENT_MEDIA_TYPES,
  CHAT_AUDIO_ATTACHMENT_FORMATS,
  GUEST_CHAT_ATTACHMENT_MEDIA_TYPES,
  chatAttachmentAcceptAttribute,
  chatAttachmentExtensionsByGroup,
  chatAttachmentMediaTypeAccepted,
  formatByMediaType,
  resolveChatAttachmentFormat,
} from "../lib/chatAttachmentFormats.ts";
import {
  AUDIO_TRANSCRIPT_KIND,
  AUDIO_TRANSCRIPT_MAY_BE_INCOMPLETE_KIND,
  CHAT_AUDIO_ATTACHMENT_MAX_BYTES,
  CHAT_AUDIO_ATTACHMENT_MAX_SECONDS,
  CHAT_AUDIO_TRANSCRIPTION_TIMEOUT_MS,
  audioTranscriptEntry,
  chatAudioAttachmentSwitchOn,
  inspectAudioAttachment,
  mp3DurationSeconds,
  wavPcmDurationSeconds,
} from "../lib/chatAudioAttachmentCore.ts";
import {
  AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS,
  chatAudioAttachmentEnabled,
  transcribeAudioAttachment,
  transcribeAudioAttachmentOnce,
} from "../lib/chatAudioAttachment.ts";
import {
  ChatAttachmentValidationError,
  validateChatAttachmentUpload,
} from "../lib/chatAttachmentValidation.ts";
import {
  ATTACHMENT_TEXT_CACHE_CATEGORIES,
  ATTACHMENT_TEXT_CACHE_VERSION,
  ATTACHMENT_TEXT_CLAIM_VERSION,
  AUDIO_TRANSCRIPT_RESULT_VERSION,
  AUDIO_TRANSCRIPT_VERSION_BAND,
  isCurrentAttachmentTextVersion,
} from "../lib/attachmentTextCache.ts";
import { transcribeWithOpenAi } from "../lib/voiceTranscriptionPortCore.ts";
import { createRequire } from "node:module";

// The class the library itself throws and catches. A .ts module reached by
// `import` from this .mjs file is a second instance of the one the library
// reaches by `require`, and `instanceof` would be comparing the two.
const { VoiceBudgetError } = createRequire(import.meta.url)("../lib/voiceInputBudget.ts");

/**
 * Audio attachments: docs/policy/chat-attachment-formats.md section 2.4.1.
 *
 * The mp3 happy path is two real encoder outputs (LAME through ffmpeg 8.1.2,
 * one constant and one variable bitrate); the WebM and MP4 ones are the
 * Chromium recordings voice input is already tested with. Refusals are built
 * byte by byte, because a malformed stream has to be malformed in one way.
 */

const fixture = (path) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url))));

const MP3_CBR_3000MS = fixture("audio/ffmpeg-lame-cbr32k-22050hz-3000ms.mp3");
const MP3_VBR_2500MS = fixture("audio/ffmpeg-lame-vbr-44100hz-2500ms.mp3");
const WAV_1500MS = fixture("audio/ffmpeg-pcm-s16le-8000hz-1500ms.wav");
const WAV_EXTENSIBLE_500MS = fixture("audio/ffmpeg-pcm-s16le-3ch-extensible-8000hz-500ms.wav");
const WEBM_2500MS = fixture("voice/chromium-webm-opus-2500ms.webm");
const MP4_3000MS = fixture("voice/chromium-mp4-aac-3000ms.mp4");

// A RIFF/WAVE file built field by field: fmt then data.
const wav = ({ format = 1, channels = 1, sampleRate = 8000, bits = 8, byteRate, blockAlign, dataSize, payload }) => {
  const align = blockAlign ?? channels * (bits / 8);
  const rate = byteRate ?? sampleRate * align;
  const bytes = new Uint8Array(44 + payload);
  const view = new DataView(bytes.buffer);
  const tag = (at, text) => [...text].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  tag(0, "RIFF"); view.setUint32(4, 36 + payload, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, format, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, rate, true); view.setUint16(32, align, true); view.setUint16(34, bits, true);
  tag(36, "data"); view.setUint32(40, dataSize ?? payload, true);
  return bytes;
};

// MPEG 2.5 Layer III, 8 kbit/s, 8 kHz: 72-byte frames of 576 samples (72 ms).
const tinyMp3Frame = () => {
  const frame = new Uint8Array(72);
  frame.set([0xff, 0xe3, 0x18, 0x00]);
  return frame;
};
const mp3OfFrames = (count, tail = new Uint8Array(0)) => {
  const bytes = new Uint8Array(count * 72 + tail.length);
  for (let i = 0; i < count; i += 1) bytes.set(tinyMp3Frame(), i * 72);
  bytes.set(tail, count * 72);
  return bytes;
};

// -- The switch leaves the format table exactly as it was -------------------

test("switched off, nothing derived from the format table changes", () => {
  assert.equal(CHAT_ATTACHMENT_FORMATS.some((format) => format.category === "audio"), false);
  for (const format of CHAT_AUDIO_ATTACHMENT_FORMATS) {
    assert.equal(CHAT_ATTACHMENT_MEDIA_TYPES.has(format.mediaType), false, format.id);
    assert.equal(GUEST_CHAT_ATTACHMENT_MEDIA_TYPES.has(format.mediaType), false, format.id);
    assert.equal(chatAttachmentMediaTypeAccepted(format.mediaType), false, format.id);
    assert.equal(formatByMediaType(format.mediaType), null, format.id);
  }
  assert.equal(chatAttachmentAcceptAttribute(), chatAttachmentAcceptAttribute({ audio: false }));
  assert.equal(chatAttachmentAcceptAttribute().includes(".mp3"), false);
  assert.deepEqual(Object.keys(chatAttachmentExtensionsByGroup()), [
    "image", "document", "data", "markup", "code", "archive",
  ]);
  for (const [name, type] of [["meeting.mp3", "audio/mpeg"], ["memo.m4a", "audio/x-m4a"],
    ["call.wav", "audio/wav"], ["clip.webm", "video/webm"]]) {
    assert.equal(resolveChatAttachmentFormat({ filename: name, declaredMediaType: type }), null, name);
  }
});

test("switched on, recordings resolve from the names and types browsers report", () => {
  const resolve = (filename, declaredMediaType) =>
    resolveChatAttachmentFormat({ filename, declaredMediaType, audio: true })?.id ?? null;
  assert.equal(resolve("meeting.mp3", "audio/mpeg"), "mp3");
  assert.equal(resolve("meeting.MP3", ""), "mp3");
  assert.equal(resolve("call.wav", "audio/x-wav"), "wav");
  assert.equal(resolve("call.WAV", ""), "wav");
  // Containers that only state their length in a header are not offered yet.
  assert.equal(resolve("memo.m4a", "audio/x-m4a"), null);
  assert.equal(resolve("clip.webm", "audio/webm"), null);
  // A name and a type naming two different formats is still a refusal.
  assert.equal(resolve("notes.txt", "audio/mpeg"), null);
  assert.equal(resolve("meeting.mp3", "application/pdf"), null);
  assert.equal(resolve("voice.ogg", "audio/ogg"), null);
  assert.equal(chatAttachmentMediaTypeAccepted("audio/mpeg", { audio: true }), true);
  assert.equal(formatByMediaType("audio/x-wav", { audio: true })?.mediaType, "audio/wav");
  assert.equal(formatByMediaType("audio/mp4", { audio: true }), null);
});

test("recordings are appended for an account and never offered to a guest", () => {
  const accept = chatAttachmentAcceptAttribute({ audio: true });
  assert.ok(accept.startsWith(chatAttachmentAcceptAttribute()));
  assert.ok(accept.includes(".mp3") && accept.includes("audio/wav"));
  assert.equal(
    chatAttachmentAcceptAttribute({ guest: true, audio: true }),
    chatAttachmentAcceptAttribute({ guest: true })
  );
  assert.deepEqual(chatAttachmentExtensionsByGroup({ audio: true }).audio, ["mp3", "wav"]);
  assert.equal("audio" in chatAttachmentExtensionsByGroup({ guest: true, audio: true }), false);
  for (const format of CHAT_AUDIO_ATTACHMENT_FORMATS) {
    assert.equal(format.guestAllowed, false, format.id);
    assert.equal(format.allowedInArchive, false, format.id);
  }
  // The transcript is cached; re-reading the recording would bill it again.
  assert.equal(ATTACHMENT_TEXT_CACHE_CATEGORIES.has("audio"), true);
});

test("the switch reads the string true and nothing else", () => {
  for (const value of [undefined, "", "1", "TRUE", "yes", "false"]) {
    assert.equal(chatAudioAttachmentSwitchOn({ CHAT_AUDIO_ATTACHMENT_ENABLED: value }), false, String(value));
    assert.equal(chatAudioAttachmentEnabled({ CHAT_AUDIO_ATTACHMENT_ENABLED: value }), false, String(value));
  }
  assert.equal(chatAudioAttachmentSwitchOn({ CHAT_AUDIO_ATTACHMENT_ENABLED: "true" }), true);
  assert.equal(chatAudioAttachmentEnabled({ CHAT_AUDIO_ATTACHMENT_ENABLED: "true" }), true);
  // A transcription model without an observed price keeps it off.
  assert.equal(
    chatAudioAttachmentEnabled({ CHAT_AUDIO_ATTACHMENT_ENABLED: "true", VOICE_TRANSCRIPTION_MODEL: "whisper-9" }),
    false
  );
});

// -- Length is read before anything is paid for -----------------------------

test("an mp3's length is what its frames add up to, measured on real encoder output", () => {
  // ffprobe says 3.000 and 2.500 after LAME's gapless trim; the frame walk
  // also counts the one metadata frame and the encoder padding, which only
  // ever errs towards reserving slightly more.
  const cbr = mp3DurationSeconds(MP3_CBR_3000MS);
  const vbr = mp3DurationSeconds(MP3_VBR_2500MS);
  assert.ok(cbr >= 3.0 && cbr < 3.15, String(cbr));
  assert.ok(vbr >= 2.5 && vbr < 2.65, String(vbr));
  assert.deepEqual(inspectAudioAttachment({ bytes: MP3_CBR_3000MS, mediaType: "audio/mpeg" }), {
    ok: true, durationSeconds: cbr, durationSource: "mpeg-frames",
  });
});

test("a WAV's length is its PCM bytes over the rate they are played at", () => {
  assert.deepEqual(inspectAudioAttachment({ bytes: WAV_1500MS, mediaType: "audio/wav" }), {
    ok: true, durationSeconds: 1.5, durationSource: "pcm-bytes",
  });
  // A data size smaller than what follows is the file's claim: every byte counts.
  assert.equal(wavPcmDurationSeconds(wav({ dataSize: 100, payload: 16_000 })), 2);
  assert.equal(wavPcmDurationSeconds(wav({ dataSize: 0xffffffff, payload: 8_000 })), 1);
  // A rate that disagrees with its own sample format, or a compressed stream.
  assert.equal(wavPcmDurationSeconds(wav({ byteRate: 192_000, payload: 16_000 })), null);
  assert.equal(wavPcmDurationSeconds(wav({ blockAlign: 4, payload: 16_000 })), null);
  assert.equal(wavPcmDurationSeconds(wav({ format: 0x0055, payload: 16_000 })), null);
});

test("WAVE_FORMAT_EXTENSIBLE counts only when its sub-format is PCM or float", () => {
  // ffmpeg writes the extensible wrapper for three channels: a real one, with
  // KSDATAFORMAT_SUBTYPE_PCM in its 40-byte fmt chunk.
  const real = WAV_EXTENSIBLE_500MS;
  assert.equal(new DataView(real.buffer, real.byteOffset).getUint16(20, true), 0xfffe);
  assert.equal(wavPcmDurationSeconds(real), 0.5);
  // The same file naming a compressed codec in the GUID, keeping the PCM-looking
  // byteRate and blockAlign that would otherwise understate its length.
  const compressed = new Uint8Array(real);
  new DataView(compressed.buffer).setUint32(44, 0x0055, true);
  assert.equal(wavPcmDurationSeconds(compressed), null);
  // A GUID outside the KSDATAFORMAT family, and a wrapper with no room for one.
  const foreign = new Uint8Array(real);
  foreign[50] ^= 0xff;
  assert.equal(wavPcmDurationSeconds(foreign), null);
  assert.equal(wavPcmDurationSeconds(wav({ format: 0xfffe, payload: 16_000 })), null);
  assert.equal(inspectAudioAttachment({ bytes: compressed, mediaType: "audio/wav" }).code, "ATTACHMENT_UNREADABLE");
});

test("bytes of another container are refused whatever they are named", () => {
  for (const [bytes, mediaType] of [[MP3_CBR_3000MS, "audio/wav"], [WAV_1500MS, "audio/mpeg"],
    [WEBM_2500MS, "audio/webm"], [MP4_3000MS, "audio/mp4"], [WEBM_2500MS, "audio/mpeg"]]) {
    const result = inspectAudioAttachment({ bytes, mediaType });
    assert.equal(result.ok, false, mediaType);
  }
  assert.deepEqual(inspectAudioAttachment({ bytes: MP3_CBR_3000MS, mediaType: "audio/wav" }), {
    ok: false, code: "ATTACHMENT_TYPE_MISMATCH",
  });
});

test("a recording past the ceiling, or of no readable length, is refused", () => {
  const frames = Math.ceil((CHAT_AUDIO_ATTACHMENT_MAX_SECONDS + 1) / 0.072);
  assert.deepEqual(inspectAudioAttachment({ bytes: mp3OfFrames(frames), mediaType: "audio/mpeg" }), {
    ok: false, code: "ATTACHMENT_AUDIO_TOO_LONG",
  });
  const justUnder = Math.floor((CHAT_AUDIO_ATTACHMENT_MAX_SECONDS - 1) / 0.072);
  assert.equal(inspectAudioAttachment({ bytes: mp3OfFrames(justUnder), mediaType: "audio/mpeg" }).ok, true);
  // No frames at all.
  assert.equal(mp3DurationSeconds(new Uint8Array(4096)), null);
  // Free-format and reserved fields are not a length.
  assert.equal(mp3DurationSeconds(new Uint8Array([0xff, 0xe3, 0x08, 0x00, ...new Uint8Array(68)])), null);
  assert.deepEqual(inspectAudioAttachment({ bytes: new Uint8Array(4096), mediaType: "audio/mpeg" }), {
    ok: false, code: "ATTACHMENT_UNREADABLE",
  });
});

// Review r-20261127-073816-5a1bf4: whatever follows the last frame the walk
// reached must be something no decoder can play, or the walk has not measured
// what the provider will transcribe.
test("an mp3 is read to its end: nothing after the frames may hold a frame sync", () => {
  const ten = mp3DurationSeconds(mp3OfFrames(10));
  assert.ok(Math.abs(ten - 0.72) < 1e-9, String(ten));
  // A short frame, bytes the walk cannot read, then 216 seconds a
  // resynchronising decoder would play in full -- inside the 256 KiB of tail
  // that used to be waved through as "tags", and booked as 72 ms.
  const hidden = mp3OfFrames(3_000);
  const junk = new Uint8Array(100).fill(0x01);
  const attack = mp3OfFrames(1, new Uint8Array([...junk, ...hidden]));
  assert.equal(mp3DurationSeconds(attack), null);
  assert.deepEqual(inspectAudioAttachment({ bytes: attack, mediaType: "audio/mpeg" }), {
    ok: false, code: "ATTACHMENT_UNREADABLE",
  });
  // One sync anywhere in the tail is enough to refuse, the real encoder's
  // output included.
  assert.equal(mp3DurationSeconds(mp3OfFrames(10, new Uint8Array([0x00, 0xff, 0xfb, 0x90]))), null);
  assert.equal(mp3DurationSeconds(new Uint8Array([...MP3_CBR_3000MS, 0x01, 0xff, 0xe3])), null);
  // A tag or padding no decoder can play is not audio and adds no length.
  const id3v1 = new Uint8Array(128);
  id3v1.set([0x54, 0x41, 0x47]);
  id3v1.fill(0x20, 3, 127);
  id3v1[127] = 0xff; // "no genre", with no byte after it to complete a sync
  assert.equal(mp3DurationSeconds(mp3OfFrames(10, id3v1)), ten);
  assert.equal(mp3DurationSeconds(mp3OfFrames(10, new Uint8Array(300 * 1024))), ten);
  assert.equal(
    mp3DurationSeconds(new Uint8Array([...MP3_CBR_3000MS, ...id3v1])),
    mp3DurationSeconds(MP3_CBR_3000MS)
  );
  // Review r-20261127-122037-b72ce5: an ID3v1 tag is skipped by its format, so
  // a Latin-1 title that happens to read as a sync does not refuse the file...
  const syncInTitle = new Uint8Array(id3v1);
  syncInTitle.set([0xff, 0xe0], 10);
  assert.equal(mp3DurationSeconds(mp3OfFrames(10, syncInTitle)), ten);
  // ...but only a real one: exactly 128 bytes at the end, opening with "TAG".
  assert.equal(mp3DurationSeconds(mp3OfFrames(10, new Uint8Array([...syncInTitle, 0x00]))), null);
  const notATag = new Uint8Array(syncInTitle);
  notATag[0] = 0x58;
  assert.equal(mp3DurationSeconds(mp3OfFrames(10, notATag)), null);
  // The bytes before the tag are still scanned.
  assert.equal(mp3DurationSeconds(mp3OfFrames(10, new Uint8Array([0x00, 0xff, 0xe3, 0x00, ...id3v1]))), null);
  // An APEv2 tag is not skipped: its footer states its own size, so a sync
  // inside one still refuses the file.
  const ape = new Uint8Array(64);
  ape.set([...new TextEncoder().encode("APETAGEX")], 32);
  ape.set([0xff, 0xe3], 8);
  assert.equal(mp3DurationSeconds(mp3OfFrames(10, ape)), null);
  // A last frame cut short counts as a whole one, unless what follows its
  // header could start another.
  assert.equal(mp3DurationSeconds(mp3OfFrames(10).subarray(0, 10 * 72 - 30)), ten);
  const cut = mp3OfFrames(10).subarray(0, 10 * 72 - 30);
  cut.set([0xff, 0xe3], 9 * 72 + 20);
  assert.equal(mp3DurationSeconds(cut), null);
});

test("finalize checks the container and length, and the provider's size ceiling", async () => {
  const mp3 = formatByMediaType("audio/mpeg", { audio: true });
  const validated = await validateChatAttachmentUpload({
    buffer: Buffer.from(MP3_CBR_3000MS), format: mp3, scope: "account",
  });
  assert.equal(validated.mediaType, "audio/mpeg");
  const refusal = async (buffer) => {
    try {
      await validateChatAttachmentUpload({ buffer, format: mp3, scope: "account" });
    } catch (error) {
      assert.ok(error instanceof ChatAttachmentValidationError);
      return [error.code, error.status];
    }
    assert.fail("expected a refusal");
  };
  const frames = Math.ceil((CHAT_AUDIO_ATTACHMENT_MAX_SECONDS + 1) / 0.072);
  assert.deepEqual(await refusal(Buffer.from(mp3OfFrames(frames))), ["ATTACHMENT_AUDIO_TOO_LONG", 413]);
  assert.deepEqual(await refusal(Buffer.alloc(CHAT_AUDIO_ATTACHMENT_MAX_BYTES + 1)), ["ATTACHMENT_TOO_LARGE", 413]);
  assert.deepEqual(await refusal(Buffer.alloc(4096)), ["ATTACHMENT_UNREADABLE", 400]);
});

// -- The transcript, and the seconds it is booked against ------------------

test("a transcript is an extracted-text entry, flagged when it may have been cut", () => {
  assert.equal(audioTranscriptEntry({ text: "   ", outputTokens: 3 }), null);
  assert.deepEqual(audioTranscriptEntry({ text: " Hello team. ", outputTokens: 120 }), {
    kind: AUDIO_TRANSCRIPT_KIND, text: "Hello team.",
  });
  assert.equal(audioTranscriptEntry({ text: "...", outputTokens: 1_995 }).kind, AUDIO_TRANSCRIPT_MAY_BE_INCOMPLETE_KIND);
  assert.equal(audioTranscriptEntry({ text: "...", outputTokens: null }).kind, AUDIO_TRANSCRIPT_KIND);
});

const fakeDeps = (result, events) => ({
  reserve: async (input) => {
    events.push(["reserve", input.subjectKey, input.seconds]);
    return { subject: {}, provider: {} };
  },
  settle: async ({ basis }) => {
    events.push(["settle", basis]);
    return { releasedSeconds: 0 };
  },
  release: async () => {
    events.push(["release"]);
    return { releasedSeconds: 0 };
  },
  transcribe: async (request) => {
    events.push(["transcribe", request.mediaType, request.extension, request.timeoutMs]);
    if (result instanceof Error) throw result;
    return result;
  },
});
const attachment = {
  bytes: MP3_CBR_3000MS, mediaType: "audio/mpeg", extension: "mp3",
  durationSeconds: 184.2, subjectKey: "user:abc", traceId: "trace-1",
};
const quietly = async (run) => {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
};

test("a transcription reserves the measured seconds and settles on them", async () => {
  const events = [];
  // The documented token-billed response shape (OpenAI /v1/audio/transcriptions).
  const entry = await quietly(() => transcribeAudioAttachment(attachment, fakeDeps(
    { ok: true, text: "Minutes of the meeting.", usage: { kind: "tokens", inputTokens: 1800, outputTokens: 210 } },
    events
  )));
  assert.deepEqual(entry, { kind: AUDIO_TRANSCRIPT_KIND, text: "Minutes of the meeting." });
  assert.deepEqual(events, [
    ["reserve", "user:abc", 185],
    ["transcribe", "audio/mpeg", "mp3", CHAT_AUDIO_TRANSCRIPTION_TIMEOUT_MS],
    ["settle", { kind: "measured_clip", seconds: 184.2 }],
  ]);
});

test("a provider's own seconds win, and an unknown outcome keeps the reservation", async () => {
  const events = [];
  await quietly(() => transcribeAudioAttachment(attachment, fakeDeps(
    { ok: true, text: "Hi.", usage: { kind: "duration", seconds: 183 } }, events)));
  assert.deepEqual(events.at(-1), ["settle", { kind: "provider_seconds", seconds: 183 }]);

  for (const [disposition, basis] of [["indeterminate", "reservation"], ["refused", "not_billed"], ["not_sent", "not_billed"]]) {
    const log = [];
    await assert.rejects(
      quietly(() => transcribeAudioAttachment(attachment, fakeDeps(
        { ok: false, code: "provider_unavailable", status: 503, disposition }, log))),
      (error) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE" && error.status === 502
    );
    assert.deepEqual(log.at(-1), ["settle", { kind: basis }], disposition);
  }
});

test("no speech is a refusal after settling; a throw before the call releases, a throw from it keeps", async () => {
  const events = [];
  await assert.rejects(
    quietly(() => transcribeAudioAttachment(attachment, fakeDeps(
      { ok: true, text: "  ", usage: { kind: "absent" } }, events))),
    (error) => error.code === "ATTACHMENT_NO_TEXT"
  );
  assert.deepEqual(events.at(-1), ["settle", { kind: "measured_clip", seconds: 184.2 }]);

  // Stopped before the provider is asked: nothing billed, the seconds go back.
  const stopped = [];
  const call = { mayHaveBeenPaid: false, beforeProviderCall: async () => { throw new Error("stop"); } };
  await assert.rejects(quietly(() => transcribeAudioAttachment(attachment, fakeDeps(null, stopped), call)), /stop/);
  assert.deepEqual(stopped.at(-1), ["release"]);
  assert.equal(call.mayHaveBeenPaid, false);

  // A throw from the call itself is an outcome nobody knows (review
  // r-20261127-122037-b72ce5): the seconds stay booked, as for an
  // indeterminate failure.
  const thrown = [];
  const thrownCall = { mayHaveBeenPaid: false };
  await assert.rejects(
    quietly(() => transcribeAudioAttachment(attachment, fakeDeps(new Error("boom"), thrown), thrownCall)),
    (error) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE"
  );
  assert.deepEqual(thrown.at(-1), ["settle", { kind: "reservation" }]);
  assert.equal(thrownCall.mayHaveBeenPaid, true);

  // A settle that throws after the provider answered has an unknown outcome:
  // the hold is kept, never released over it.
  const unsettled = [];
  const deps = fakeDeps({ ok: true, text: "Hi.", usage: { kind: "duration", seconds: 3 } }, unsettled);
  deps.settle = async ({ basis }) => {
    unsettled.push(["settle", basis]);
    throw new Error("settle connection lost");
  };
  await assert.rejects(quietly(() => transcribeAudioAttachment(attachment, deps)), /settle connection lost/);
  assert.deepEqual(unsettled.at(-1), ["settle", { kind: "provider_seconds", seconds: 3 }]);
  assert.equal(unsettled.some(([event]) => event === "release"), false);
});

test("an exhausted seconds budget is its own refusal and never reaches the provider", async () => {
  const events = [];
  const deps = fakeDeps({ ok: true, text: "never", usage: { kind: "absent" } }, events);
  deps.reserve = async () => {
    throw new VoiceBudgetError(429, "VOICE_OPERATIONAL_LIMIT_REACHED", "limit", 3600);
  };
  await assert.rejects(
    quietly(() => transcribeAudioAttachment(attachment, deps)),
    (error) => error.code === "AUDIO_TRANSCRIPTION_LIMIT_REACHED" && error.status === 429 && error.retryAfter === 3600
  );
  assert.deepEqual(events, []);
});

// -- One paid transcription per recording -------------------------------------

// Review r-20261127-082100-427572: several models answering one message are
// several requests. The store below claims the way the SQL does -- one
// statement, so the second claimant loses -- and the real database version of
// this is tests/integration/chat-audio-transcript-claim.db.test.ts.
const memoryStore = (overrides = {}) => {
  const rows = new Map();
  let clock = 0;
  const store = {
    rows,
    read: async (id) => {
      const row = rows.get(id);
      return row?.noText ? "no_text" : (row?.entries ?? null);
    },
    readInherited: async () => null,
    // As the SQL does: a missing row or a stale claim is taken, nothing else.
    claim: async (id, token, staleSeconds) => {
      const row = rows.get(id);
      if (row && !(row.claim && clock - row.at > staleSeconds * 1000)) return false;
      rows.set(id, { claim: token, at: clock });
      return true;
    },
    renew: async (id, token) => {
      const row = rows.get(id);
      if (row?.claim !== token) return false;
      row.at = clock;
      return true;
    },
    write: async (id, entries) => { rows.set(id, { entries }); return true; },
    writeNoText: async (id) => { rows.set(id, { noText: true }); return true; },
    release: async (id, token) => { if (rows.get(id)?.claim === token) rows.delete(id); },
    wait: async (ms) => { clock += ms; await new Promise((resolve) => setImmediate(resolve)); },
    now: () => clock,
  };
  return Object.assign(store, overrides);
};
const slowTranscription = (events, outcome = { ok: true, text: "Minutes.", usage: { kind: "duration", seconds: 3 } }) => {
  const deps = fakeDeps(outcome, events);
  const transcribe = deps.transcribe;
  deps.transcribe = async (request) => {
    // Long enough for the other request to arrive and find the claim taken.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return transcribe(request);
  };
  return deps;
};
const once = (store, transcription) =>
  quietly(() => transcribeAudioAttachmentOnce({ ...attachment, attachmentId: "att-1" }, { store, transcription }));

test("two requests for one recording pay for one transcription", async () => {
  const store = memoryStore();
  const events = [];
  const transcription = slowTranscription(events);
  const [first, second] = await Promise.all([once(store, transcription), once(store, transcription)]);
  assert.deepEqual(first, [{ kind: AUDIO_TRANSCRIPT_KIND, text: "Minutes." }]);
  assert.deepEqual(second, first);
  assert.equal(events.filter(([event]) => event === "transcribe").length, 1);
  assert.equal(events.filter(([event]) => event === "reserve").length, 1);
  assert.deepEqual(store.rows.get("att-1"), { entries: first });
});

test("a failed transcription gives its claim back and the next request tries in turn", async () => {
  const store = memoryStore();
  const events = [];
  const failing = slowTranscription(events, { ok: false, code: "provider_unavailable", status: 503, disposition: "refused" });
  await assert.rejects(once(store, failing), (error) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE");
  assert.equal(store.rows.has("att-1"), false);
  const retried = await once(store, slowTranscription(events));
  assert.deepEqual(retried, [{ kind: AUDIO_TRANSCRIPT_KIND, text: "Minutes." }]);
});

// Review r-20261127-114544-4444fa: a request that holds no claim never pays.
test("no claim, no call: a store that will not claim, or a wait that runs out, is a retryable refusal", async () => {
  // Taken, with nothing ever written: a store that keeps answering "taken".
  const events = [];
  const taken = memoryStore({ claim: async () => false });
  await assert.rejects(once(taken, slowTranscription(events)),
    (error) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE" && error.status === 503);
  assert.ok(taken.now() > AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS * 1000);
  assert.deepEqual(events, [], "nothing reserved, nothing transcribed");
  // A claim that cannot be written at all.
  const broken = memoryStore({ claim: async () => { throw new Error("database down"); } });
  const brokenEvents = [];
  await assert.rejects(once(broken, slowTranscription(brokenEvents)),
    (error) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE");
  assert.deepEqual(brokenEvents, []);
});

test("a transcript that cannot be stored is used, and its claim kept until it goes stale", async () => {
  // Before the claim goes stale, no later request pays again.
  const kept = memoryStore();
  let writes = 0;
  kept.write = async () => { writes += 1; throw new Error("store down"); };
  const events = [];
  const transcribed = () => events.filter(([event]) => event === "transcribe").length;
  const paid = await once(kept, slowTranscription(events));
  assert.deepEqual(paid, [{ kind: AUDIO_TRANSCRIPT_KIND, text: "Minutes." }], "used for this turn");
  assert.equal(writes, 2, "stored once more before giving up");
  assert.ok(kept.rows.get("att-1")?.claim, "the claim stands");
  const wait = kept.wait;
  kept.wait = async (ms) => {
    if (kept.now() + ms > AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS * 1000) throw new Error("stale from here on");
    await wait(ms);
  };
  await assert.rejects(once(kept, slowTranscription(events)), /stale from here on/);
  assert.equal(transcribed(), 1);

  // The residue: a request still waiting when the claim goes stale takes it
  // over and pays once more -- not before.
  const both = memoryStore();
  both.write = async () => false;
  const bothEvents = [];
  const transcription = slowTranscription(bothEvents);
  const [first, second] = await Promise.all([once(both, transcription), once(both, transcription)]);
  assert.deepEqual(second, first);
  assert.equal(bothEvents.filter(([event]) => event === "transcribe").length, 2);
  assert.ok(both.now() > AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS * 1000, "the second paid only after the stale point");
});

test("a write that fails once is retried, and the claim then given back", async () => {
  const store = memoryStore();
  const write = store.write;
  let attempts = 0;
  store.write = async (id, entries) => { attempts += 1; if (attempts === 1) throw new Error("blip"); return write(id, entries); };
  const entries = await once(store, slowTranscription([]));
  assert.equal(attempts, 2);
  assert.deepEqual(store.rows.get("att-1"), { entries });
});

// Same review: a recording with no speech will have none next turn either.
test("a recording found to hold no speech is not transcribed again", async () => {
  const store = memoryStore();
  const events = [];
  const silent = slowTranscription(events, { ok: true, text: "  ", usage: { kind: "duration", seconds: 3 } });
  await assert.rejects(once(store, silent), (error) => error.code === "ATTACHMENT_NO_TEXT");
  assert.deepEqual(store.rows.get("att-1"), { noText: true });
  await assert.rejects(once(store, silent), (error) => error.code === "ATTACHMENT_NO_TEXT");
  assert.equal(events.filter(([event]) => event === "transcribe").length, 1);
  assert.equal(events.filter(([event]) => event === "reserve").length, 1);
});

// -- The claim lasts longer than the call that holds it ----------------------

// Review r-20261127-110354-67c5f8: a claim goes stale on a fixed clock, so the
// transcription it covers must end -- body and all -- before that clock does.
test("a claim outlives the hardest deadline its transcription can run to", () => {
  assert.ok(AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS * 1000 > CHAT_AUDIO_TRANSCRIPTION_TIMEOUT_MS);
  // Room after the deadline to settle the seconds and store the transcript.
  assert.ok(AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS * 1000 - CHAT_AUDIO_TRANSCRIPTION_TIMEOUT_MS >= 10_000);
});

/** Headers now, a body never: a provider whose answer stalls after its status line. */
const stalledBody = (status) => async () =>
  new Response(new ReadableStream({ start() {} }), {
    status,
    headers: { "content-type": "application/json" },
  });
const portRequest = {
  audio: new Uint8Array([1]),
  mediaType: "audio/mpeg",
  extension: "mp3",
  languageHint: null,
  timeoutMs: 50,
};

test("the provider's deadline covers the body, not only the headers", async () => {
  const started = Date.now();
  const result = await transcribeWithOpenAi(portRequest, {
    apiKey: "k", model: "m", fetchImpl: stalledBody(200),
  });
  assert.deepEqual(result, {
    ok: false, code: "provider_response_unreadable", status: 200, disposition: "indeterminate",
  });
  assert.ok(Date.now() - started < 5_000, "cut off at the deadline, not waited on");
  // A refusal whose body stalls is still classified, and still on time.
  const refused = await transcribeWithOpenAi(portRequest, {
    apiKey: "k", model: "m", fetchImpl: stalledBody(429),
  });
  assert.equal(refused.code, "provider_rate_limited");
  assert.ok(Date.now() - started < 10_000);
});

// -- The claim is given back only when nothing can have been paid -----------

// Review r-20261127-122037-b72ce5: one row of the table in
// transcribeAudioAttachmentOnce's comment per test below.
const transcribedIn = (events) => events.filter(([event]) => event === "transcribe").length;
/** A later request, cut off at the stale point: it must not have paid by then. */
const laterRequestBeforeStale = async (store, events) => {
  const wait = store.wait;
  store.wait = async (ms) => {
    if (store.now() + ms > AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS * 1000) throw new Error("stale from here on");
    await wait(ms);
  };
  await assert.rejects(once(store, slowTranscription(events)), /stale from here on/);
  store.wait = wait;
};

test("a body cut off at the deadline may have been paid: the claim stands until stale", async () => {
  const store = memoryStore();
  const events = [];
  const deps = fakeDeps(null, events);
  deps.transcribe = (request) =>
    transcribeWithOpenAi({ ...request, timeoutMs: 50 }, { apiKey: "k", model: "m", fetchImpl: stalledBody(200) });
  await assert.rejects(once(store, deps), (error) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE");
  // Indeterminate: the provider may have done the work, so the seconds stay booked.
  assert.deepEqual(events.at(-1), ["settle", { kind: "reservation" }]);
  assert.ok(store.rows.get("att-1")?.claim, "the claim stands");
  const later = [];
  await laterRequestBeforeStale(store, later);
  assert.equal(transcribedIn(later), 0, "no later request pays before it is stale");
});

test("a settlement that throws after the provider answered keeps the claim", async () => {
  const store = memoryStore();
  const events = [];
  const deps = slowTranscription(events);
  deps.settle = async ({ basis }) => { events.push(["settle", basis]); throw new Error("ledger down"); };
  await assert.rejects(once(store, deps), /ledger down/);
  assert.equal(transcribedIn(events), 1);
  assert.equal(events.some(([event]) => event === "release"), false, "the seconds are not handed back either");
  assert.ok(store.rows.get("att-1")?.claim, "the claim stands");
  const later = [];
  await laterRequestBeforeStale(store, later);
  assert.equal(transcribedIn(later), 0);
});

test("a call that throws may have been paid too", async () => {
  const store = memoryStore();
  const events = [];
  const deps = slowTranscription(events);
  deps.transcribe = async () => { events.push(["transcribe"]); throw new Error("socket reset"); };
  await assert.rejects(once(store, deps), (error) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE");
  assert.deepEqual(events.at(-1), ["settle", { kind: "reservation" }]);
  assert.ok(store.rows.get("att-1")?.claim, "the claim stands");
});

test("a refusal the port classifies as costing nothing gives the claim back at once", async () => {
  for (const [code, status, disposition] of [
    ["provider_not_configured", null, "not_sent"],
    ["provider_rejected_audio", 400, "refused"],
  ]) {
    const store = memoryStore();
    const events = [];
    const refused = slowTranscription(events, { ok: false, code, status, disposition });
    await assert.rejects(once(store, refused), (error) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE");
    assert.deepEqual(events.at(-1), ["settle", { kind: "not_billed" }], disposition);
    assert.equal(store.rows.has("att-1"), false, disposition);
  }
});

test("seconds refused before any call give the claim back", async () => {
  const store = memoryStore();
  const events = [];
  const deps = slowTranscription(events);
  deps.reserve = async () => { throw new VoiceBudgetError(429, "VOICE_OPERATIONAL_LIMIT_REACHED", "limit", 60); };
  await assert.rejects(once(store, deps), (error) => error.code === "AUDIO_TRANSCRIPTION_LIMIT_REACHED");
  assert.equal(transcribedIn(events), 0);
  assert.equal(store.rows.has("att-1"), false);
});

test("a holder whose claim was taken over while it booked never calls", async () => {
  const store = memoryStore();
  const events = [];
  const deps = slowTranscription(events);
  // Bookings slow enough for another request to take the claim over.
  const reserve = deps.reserve;
  deps.reserve = async (input) => {
    const booked = await reserve(input);
    store.rows.set("att-1", { claim: "someone-else", at: store.now() });
    return booked;
  };
  await assert.rejects(once(store, deps), (error) => error.code === "AUDIO_TRANSCRIPTION_UNAVAILABLE");
  assert.equal(transcribedIn(events), 0, "no call");
  assert.deepEqual(events.at(-1), ["release"], "its seconds are given back");
  assert.equal(store.rows.get("att-1")?.claim, "someone-else", "the other request's claim is left alone");
});

test("the claim is renewed just before the call, so the stale window starts there", async () => {
  const store = memoryStore();
  const events = [];
  const deps = slowTranscription(events);
  const reserve = deps.reserve;
  deps.reserve = async (input) => {
    // Slow bookings: most of the window spent before the call.
    await store.wait(AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS * 1000 - 1_000);
    return reserve(input);
  };
  const write = store.write;
  let renewedAt = null;
  store.write = async (id, entries) => { renewedAt = renewedAt ?? store.rows.get(id)?.at; return write(id, entries); };
  await once(store, deps);
  assert.equal(renewedAt, AUDIO_TRANSCRIPT_CLAIM_STALE_SECONDS * 1000 - 1_000);
});

// -- A paid result is versioned on its own ----------------------------------

// Review r-20261127-124325-a4352d: bumping the extractor cache for a PDF
// change must not make every paid transcript a miss.
test("the audio result version sits in its own band, far from the extractor's", () => {
  assert.ok(ATTACHMENT_TEXT_CACHE_VERSION > ATTACHMENT_TEXT_CLAIM_VERSION);
  assert.ok(ATTACHMENT_TEXT_CACHE_VERSION < AUDIO_TRANSCRIPT_VERSION_BAND);
  assert.ok(AUDIO_TRANSCRIPT_RESULT_VERSION > AUDIO_TRANSCRIPT_VERSION_BAND, "an older audio version stays in the band");
  // A bumped extractor version leaves the audio result readable, and only it.
  const bumped = ATTACHMENT_TEXT_CACHE_VERSION + 1;
  assert.equal(isCurrentAttachmentTextVersion(AUDIO_TRANSCRIPT_RESULT_VERSION, bumped), true);
  assert.equal(isCurrentAttachmentTextVersion(ATTACHMENT_TEXT_CACHE_VERSION, bumped), false);
  assert.equal(isCurrentAttachmentTextVersion(bumped, bumped), true);
  assert.equal(isCurrentAttachmentTextVersion(AUDIO_TRANSCRIPT_RESULT_VERSION - 1), false);
  assert.equal(isCurrentAttachmentTextVersion(ATTACHMENT_TEXT_CLAIM_VERSION), false);
});

test("a copy of a recording already paid for takes its original's result and pays nothing", async () => {
  const transcript = [{ kind: AUDIO_TRANSCRIPT_KIND, text: "From the original." }];
  for (const inherited of [transcript, "no_text"]) {
    const store = memoryStore({ readInherited: async () => inherited });
    const events = [];
    const outcome = once(store, slowTranscription(events));
    if (inherited === "no_text") {
      await assert.rejects(outcome, (error) => error.code === "ATTACHMENT_NO_TEXT");
      assert.deepEqual(store.rows.get("att-1"), { noText: true }, "kept on the copy's own row");
    } else {
      assert.deepEqual(await outcome, transcript);
      assert.deepEqual(store.rows.get("att-1"), { entries: transcript }, "kept on the copy's own row");
    }
    assert.deepEqual(events, [], "nothing booked, nothing transcribed");
  }
});
