import assert from "node:assert/strict";
import test from "node:test";
import { nativeConversationTitle } from "../apps/mobile/src/conversationTitle.ts";
import { LEGACY_CONTINUATION_TITLE } from "../lib/continuationDisplayTitle.ts";

const row = { id: "continued", title: LEGACY_CONTINUATION_TITLE, surface: "continuation", sourceTitle: "부산 가족 여행", sourceProvider: "chatgpt", fallbackTitleDate: "2026-10-27", sourceState: "available" };
test("native history uses the original title without overwriting stored or user-defined names", () => {
  assert.equal(nativeConversationTitle(row, "ko"), "부산 가족 여행");
  assert.equal(row.title, LEGACY_CONTINUATION_TITLE);
  assert.equal(nativeConversationTitle({ ...row, title: "My own title" }, "ko"), "My own title");
  assert.equal(nativeConversationTitle({ ...row, surface: "chat" }, "ko"), LEGACY_CONTINUATION_TITLE);
});
test("locked or deleted sources use the same translated dated fallback as the web", () => {
  for (const sourceState of ["locked", "deleted"]) {
    assert.equal(nativeConversationTitle({ ...row, sourceState }, "ko"), "ChatGPT에서 이어온 대화 · 2026-10-27");
    assert.equal(nativeConversationTitle({ ...row, sourceState }, "en"), "Continued from ChatGPT · 2026-10-27");
  }
});
