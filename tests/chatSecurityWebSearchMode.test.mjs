import assert from "node:assert/strict";
import test from "node:test";
import { validateChatPayload } from "../lib/chatSecurity.ts";
import { isWebSearchMode, WEB_SEARCH_MODES } from "../lib/appDefaults.ts";

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
