import assert from "node:assert/strict";
import test from "node:test";
import { validateChatPayload } from "../lib/chatSecurity.ts";
import { isWebSearchMode, WEB_SEARCH_MODES } from "../lib/appDefaults.ts";
import { profileTextFor } from "../lib/autoDispatchPreflight.ts";

const basePayload = () => ({
  messages: [{ role: "user", content: "hi" }],
  modelId: "gpt-5-5",
});

test("isWebSearchMode only accepts the three defined modes", () => {
  for (const mode of WEB_SEARCH_MODES) {
    assert.equal(isWebSearchMode(mode), true);
  }
  for (const invalid of ["ALWAYS", "sometimes", "", null, undefined, 1, {}]) {
    assert.equal(isWebSearchMode(invalid), false);
  }
});

test("validateChatPayload accepts each valid webSearchMode and passes it through", () => {
  for (const mode of WEB_SEARCH_MODES) {
    const result = validateChatPayload({ ...basePayload(), webSearchMode: mode });
    assert.equal(result.webSearchMode, mode);
  }
});

test("validateChatPayload omits webSearchMode when the field isn't sent at all", () => {
  const result = validateChatPayload(basePayload());
  assert.equal(result.webSearchMode, undefined);
});

test("validateChatPayload rejects any value outside off/auto/always", () => {
  for (const invalid of ["ALWAYS", "sometimes", "", 1, true, {}, []]) {
    assert.throws(
      () => validateChatPayload({ ...basePayload(), webSearchMode: invalid }),
      (error) => error.code === "INVALID_WEB_SEARCH_MODE"
    );
  }
});

test("Refiner payload cannot supply suggestion bytes or an accepted boolean", () => {
  const ids = { conversationId: "conversation", assistantMessageId: "11111111-1111-4111-8111-111111111111",
    sourceUserMessageId: "22222222-2222-4222-8222-222222222222" };
  const decision = { suggestionId: "33333333-3333-4333-8333-333333333333",
    scopeId: "44444444-4444-4444-8444-444444444444", epoch: 1, decision: "accepted" };
  assert.deepEqual(validateChatPayload({ ...basePayload(), ...ids, promptRefinerDecision: decision }).promptRefinerDecision, decision);
  for (const changed of [{ accepted: true }, { ...decision, refinedPrompt: "injected" }, { ...decision, mode: "auto" }, null]) {
    assert.throws(() => validateChatPayload({ ...basePayload(), ...ids, promptRefinerDecision: changed }),
      error => error.code === "INVALID_PROMPT_REFINER_DECISION");
  }
  assert.throws(() => validateChatPayload({ ...basePayload(), promptRefinerDecision: decision }),
    error => error.code === "INVALID_PROMPT_REFINER_DECISION");
});

test("attachment turns retain their nonempty authored profile text; array content is not a valid Chat payload", () => {
  const payload = { ...basePayload(), messages: [{ role: "user", content: "Read the attached file",
    attachments: [{ attachmentId: "document" }, { uploadId: "image" }] }] };
  assert.equal(profileTextFor(validateChatPayload(payload).messages), "Read the attached file");
  assert.throws(() => validateChatPayload({ ...payload,
    messages: [{ role: "user", content: [{ type: "text", text: "Read the attached file" }] }] }));
});
