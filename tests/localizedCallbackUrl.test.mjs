import assert from "node:assert/strict";
import test from "node:test";
import { withChatLanguage } from "../lib/localizedCallbackUrl.ts";

test("localized callback URLs keep safe internal paths", () => {
  assert.equal(withChatLanguage("/chat", "ko"), "/chat?lang=ko");
  assert.equal(withChatLanguage("/review", "ko"), "/review?lang=ko");
  assert.equal(withChatLanguage("/review?lang=en", "ko"), "/review?lang=en");
  assert.equal(withChatLanguage("/admin/overview?tab=health", "en"), "/admin/overview?tab=health");
});

test("localized callback URLs default to Review when no purpose was supplied", () => {
  assert.equal(withChatLanguage(null, "fr"), "/review?lang=fr");
});

test("localized callback URLs reject external and protocol-relative redirects", () => {
  for (const value of [
    "https://evil.example/steal",
    "//evil.example/steal",
    "/\\evil.example/steal",
    "javascript:alert(1)",
  ]) {
    assert.equal(withChatLanguage(value, "ko"), "/review?lang=ko");
  }
});
