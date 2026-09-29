import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHAT_REQUEST_TRANSCRIPT_LIMITS,
  fitChatRequestTranscript,
} from "../lib/chatRequestLimits.ts";
import { CHAT_REQUEST_LIMITS, validateChatPayload } from "../lib/chatSecurity.ts";

// Trace 0f3b722e-fdca-459d-8a33-5cc9e541a38f: the client sent a whole
// transcript past the server's message limit, and the conversation could not
// be continued. Every case below is judged by the server's own validator, not
// by restating its numbers.

/** `exchanges` question/answer pairs, then this turn's question. */
const conversation = (exchanges, { answers = 1, length = 10 } = {}) => {
  const rows = [];
  for (let turn = 0; turn < exchanges; turn += 1) {
    rows.push({ id: `u${turn}`, role: "user", content: "q".repeat(length) });
    for (let reply = 0; reply < answers; reply += 1) {
      rows.push({ id: `a${turn}-${reply}`, role: "assistant", content: "a".repeat(length) });
    }
  }
  rows.push({ id: "current", role: "user", content: "this turn" });
  return rows;
};

const accepted = (messages) => validateChatPayload({ messages, modelId: "gpt-5-6-luna" });

const refusal = (messages) => {
  try {
    accepted(messages);
    return null;
  } catch (error) {
    return error.code;
  }
};

test("the failure it fixes: a transcript sent whole past the count is refused", () => {
  const whole = conversation(50);
  assert.equal(whole.length, CHAT_REQUEST_LIMITS.maxMessages + 1);
  assert.equal(refusal(whole), "INVALID_CHAT_MESSAGES");
});

test("a long conversation is fitted into a request the server accepts", () => {
  for (const exchanges of [50, 51, 120, 1_000]) {
    const fitted = fitChatRequestTranscript(conversation(exchanges));
    assert.equal(refusal(fitted), null, `${exchanges} exchanges`);
    assert.ok(fitted.length <= CHAT_REQUEST_LIMITS.maxMessages);
  }
});

test("the chat surface, where each question carries every model's reply, reaches the count sooner and still fits", () => {
  const whole = conversation(30, { answers: 3 });
  assert.equal(refusal(whole), "INVALID_CHAT_MESSAGES");
  const fitted = fitChatRequestTranscript(whole);
  assert.equal(refusal(fitted), null);
  assert.equal(fitted[0].role, "user");
});

test("the character total is the second limit, and it is fitted the same way", () => {
  // Few messages, each large: the count is nowhere near its limit.
  const whole = conversation(10, { length: 20_000 });
  assert.ok(whole.length < CHAT_REQUEST_LIMITS.maxMessages);
  assert.equal(refusal(whole), "CHAT_CONTENT_TOO_LARGE");
  const fitted = fitChatRequestTranscript(whole);
  assert.equal(refusal(fitted), null);
  const total = fitted.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total <= CHAT_REQUEST_LIMITS.maxTotalCharacters);
});

test("a transcript that already fits is returned unchanged -- the same array", () => {
  const within = conversation(49);
  assert.equal(within.length, CHAT_REQUEST_LIMITS.maxMessages - 1);
  assert.equal(fitChatRequestTranscript(within), within);

  const exactly = [...conversation(49), { id: "extra", role: "assistant", content: "x" }];
  assert.equal(exactly.length, CHAT_REQUEST_LIMITS.maxMessages);
  assert.equal(fitChatRequestTranscript(exactly), exactly);
  assert.equal(refusal(exactly), null);
});

test("what is kept is the newest part, whole messages in their order, ending on this turn", () => {
  const whole = conversation(80);
  const fitted = fitChatRequestTranscript(whole);
  assert.ok(fitted.length <= CHAT_REQUEST_LIMITS.maxMessages);
  assert.deepEqual(fitted, whole.slice(whole.length - fitted.length));
  assert.equal(fitted.at(-1).id, "current");
  // Filled to the limit less at most the one reply dropped to open on a user.
  assert.ok(fitted.length >= CHAT_REQUEST_LIMITS.maxMessages - 1);
});

test("the window opens on a user message, never on a reply to a question it dropped", () => {
  for (const exchanges of [50, 51, 52]) {
    for (const answers of [1, 2, 3]) {
      const whole = conversation(exchanges, { answers });
      const fitted = fitChatRequestTranscript(whole);
      assert.ok(fitted.length < whole.length, `${exchanges}x${answers} was cut`);
      assert.equal(fitted[0].role, "user", `${exchanges}x${answers}`);
    }
  }
});

test("this turn's question is kept even when it alone breaks a limit, so the server names the real fault", () => {
  const oversized = {
    id: "current",
    role: "user",
    content: "q".repeat(CHAT_REQUEST_LIMITS.maxMessageCharacters + 1),
  };
  const fitted = fitChatRequestTranscript([...conversation(60).slice(0, -1), oversized]);
  assert.equal(fitted.at(-1), oversized);
  assert.equal(refusal(fitted), "INVALID_CHAT_CONTENT");
});

test("the same transcript always yields the same window", () => {
  const whole = conversation(75, { answers: 2 });
  assert.deepEqual(fitChatRequestTranscript(whole), fitChatRequestTranscript(whole));
});

test("an empty transcript is returned as it is", () => {
  const empty = [];
  assert.equal(fitChatRequestTranscript(empty), empty);
});

test("the client fits to exactly the limits the server applies", () => {
  // A copy, because the server's module cannot be imported by the client and
  // is not moved (see lib/chatRequestLimits.ts). This is what keeps the copy
  // honest: a client fitting to a limit the server no longer applies either
  // sends requests that are refused or drops context it did not need to.
  assert.deepEqual(CHAT_REQUEST_TRANSCRIPT_LIMITS, {
    maxMessages: CHAT_REQUEST_LIMITS.maxMessages,
    maxTotalCharacters: CHAT_REQUEST_LIMITS.maxTotalCharacters,
  });
});

test("the client sends its transcript through the fit", () => {
  const source = readFileSync(new URL("../components/chat/ChatApp.tsx", import.meta.url), "utf8");
  const send = source.indexOf('fetch("/api/chat", {\n          method: "POST"');
  assert.ok(send > 0, "the chat request is sent from ChatApp");
  const body = source.slice(send, source.indexOf("modelId: modelId", send));
  assert.match(body, /messages: fitChatRequestTranscript\(/);
});
