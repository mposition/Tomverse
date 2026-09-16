import assert from "node:assert/strict";
import { test } from "node:test";

import { sentDomainOf } from "../lib/emailSentIdentityCore.ts";

// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4.

test("the domain comes from the address inside the display name", () => {
  assert.equal(sentDomainOf("Tomverse <no-reply@Mail.Tomverse.app>"), "mail.tomverse.app");
});

test("a bare address works too", () => {
  assert.equal(sentDomainOf("news@news.tomverse.app"), "news.tomverse.app");
});

test("anything that is not an address is no domain rather than a guess", () => {
  for (const value of [null, undefined, "", "Tomverse", "a@", "@b.c", "x@b c"]) {
    assert.equal(sentDomainOf(value), null, String(value));
  }
});
