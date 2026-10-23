import assert from "node:assert/strict";
import test from "node:test";
import { appendVoiceCaption, isVoiceTranscriptEvent, voiceConversationConfig, voiceDurationCharge, VOICE_CONVERSATION_INSTRUCTIONS } from "../packages/chat-core/src/voiceConversation.ts";

test("voice is default-off and requires a dedicated provider credential", () => {
  assert.equal(voiceConversationConfig({}), null);
  assert.equal(voiceConversationConfig({ VOICE_CONVERSATION_ENABLED: "true" }), null);
  const env = { VOICE_CONVERSATION_ENABLED: "true", VOICE_CONVERSATION_API_KEY: "test-not-a-live-key" };
  assert.deepEqual(voiceConversationConfig(env), { creditsPerMinute: 36, maxSeconds: 300 });
  assert.equal(voiceConversationConfig({ ...env, VOICE_CONVERSATION_KILL_SWITCH: "stop" }), null);
  for (const value of ["0", "NaN", "901", "20.5"]) assert.equal(voiceConversationConfig({ ...env, VOICE_CONVERSATION_MAX_SECONDS: value }), null);
});

test("the approved price rounds the cumulative session once, not each delta or minute", () => {
  assert.equal(voiceDurationCharge(10, 36).credits, 6);
  assert.equal(voiceDurationCharge(60, 36).credits, 36);
  assert.equal(voiceDurationCharge(80, 36).credits, 48);
  assert.equal(voiceDurationCharge(12, 36).credits, 8);
  assert.equal(voiceDurationCharge(0, 36).credits, 0);
  assert.equal(voiceDurationCharge(60, 36).costMicroUsd, 50_000);
  for (const invalid of [-1, NaN, Infinity]) assert.throws(() => voiceDurationCharge(invalid, 36));
});

const fragment = (role, id, delta, start, end) => ({ type: role === "user" ? "session.input_transcript.delta" : "session.output_transcript.delta", event_id: id, delta, start_ms: start, end_ms: end });

test("overlapping speakers keep separate captions and preserve spaces and repeated words", () => {
  let captions = appendVoiceCaption([], fragment("user", "u1", "I I", 0, 200));
  captions = appendVoiceCaption(captions, fragment("assistant", "a1", "Sure.", 100, 300));
  captions = appendVoiceCaption(captions, fragment("user", "u2", " need help", 200, 500));
  assert.equal(captions.length, 2);
  assert.equal(captions[0].text, "I I need help");
  assert.equal(captions[1].text, "Sure.");
  assert.equal(captions[0].endMs, 500);
  captions = appendVoiceCaption(captions, fragment("user", "u3", "New turn", 3_000, 3_300));
  assert.equal(captions.length, 3);
});

test("malformed transcript timing is rejected and substantive answers must use the existing backend", () => {
  assert.equal(isVoiceTranscriptEvent(fragment("user", "u1", "Hi", 0, 300)), true);
  assert.equal(isVoiceTranscriptEvent(fragment("user", "u1", "Hi", 500, 300)), false);
  assert.equal(isVoiceTranscriptEvent({ type: "session.usage.updated", seconds: 300 }), false);
  assert.match(VOICE_CONVERSATION_INSTRUCTIONS, /Delegate every substantive question/);
  assert.match(VOICE_CONVERSATION_INSTRUCTIONS, /Smart Adaptive/);
});
