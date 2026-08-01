import assert from "node:assert/strict";
import test from "node:test";
import { withChatLanguage } from "../lib/localizedCallbackUrl.ts";

test("localized callback URLs keep safe internal paths", () => {
  assert.equal(withChatLanguage("/chat", "ko"), "/chat?lang=ko");
  assert.equal(withChatLanguage("/admin/overview?tab=health", "en"), "/admin/overview?tab=health");
});

test("localized callback URLs reject external and protocol-relative redirects", () => {
  for (const value of [
    "https://evil.example/steal",
    "//evil.example/steal",
    "/\\evil.example/steal",
    "javascript:alert(1)",
  ]) {
    assert.equal(withChatLanguage(value, "ko"), "/chat?lang=ko");
  }
});
