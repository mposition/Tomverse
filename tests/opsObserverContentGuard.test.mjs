// A notification is a fixed sentence and at most one canonical Admin link
// (docs/policy/sre-ops.md §3 rule 1, §4). These tests pin the sentences to the
// policy text, prove the renderers produce only accepted shapes, and throw
// hostile strings at the guard.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMIN_ITEM_PATH_PREFIX,
  CHANNEL_CHECK_SENTENCE,
  DIGEST_SENTENCE,
  PAGE_SENTENCE,
  PRODUCTION_ORIGIN,
  adminItemLink,
  checkNotification,
  isCanonicalItemId,
  renderChannelCheckMessage,
  renderDigestNotice,
  renderPageMessage,
} from "../scripts/ops-observer/content-guard-core.mjs";

const ID = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";
const policy = readFileSync(new URL("../docs/policy/sre-ops.md", import.meta.url), "utf8");

test("the three sentences are the policy's §4 sentences, verbatim", () => {
  for (const sentence of [PAGE_SENTENCE, DIGEST_SENTENCE, CHANNEL_CHECK_SENTENCE]) {
    assert.ok(policy.includes(`\`${sentence}\``), `policy §4 must quote: ${sentence}`);
  }
});

test("renderers produce shapes the guard accepts", () => {
  assert.deepEqual(checkNotification("page", renderPageMessage({ itemId: ID })), { ok: true });
  assert.deepEqual(
    checkNotification("page", renderPageMessage({ itemId: ID, withChannelCheck: true })),
    { ok: true },
  );
  assert.deepEqual(checkNotification("digest", renderDigestNotice({ itemId: ID })), { ok: true });
  assert.deepEqual(checkNotification("channel_check", renderChannelCheckMessage()), { ok: true });
});

test("the link is the fixed origin, the fixed path and the id, nothing else", () => {
  assert.equal(adminItemLink(ID), `${PRODUCTION_ORIGIN}${ADMIN_ITEM_PATH_PREFIX}${ID}`);
  for (const bad of [
    ID.toUpperCase(),
    `{${ID}}`,
    `${ID}?x=1`,
    `${ID}#k`,
    `../${ID}`,
    "00000000-0000-0000-0000-000000000000",
    "",
    null,
    42,
  ]) {
    assert.equal(isCanonicalItemId(bad), false, String(bad));
    assert.throws(() => adminItemLink(bad), /ops_observer_item_id_not_canonical/);
  }
});

test("the guard refuses anything beyond the allowed shapes", () => {
  const link = adminItemLink(ID);
  const cases = [
    ["page", `${PAGE_SENTENCE}\n${link}\nP1a#database`, "trailing_line"],
    ["page", `${PAGE_SENTENCE} database\n${link}`, "sentence"],
    ["page", `${PAGE_SENTENCE}\n${link}?signal=P3`, "link_item_id"],
    ["page", `${PAGE_SENTENCE}\nhttps://evil.example${ADMIN_ITEM_PATH_PREFIX}${ID}`, "link_origin_or_path"],
    ["page", `${PAGE_SENTENCE}\nhttp://tomverse.app${ADMIN_ITEM_PATH_PREFIX}${ID}`, "link_origin_or_path"],
    ["page", `${PAGE_SENTENCE}\n${PRODUCTION_ORIGIN}/admin/other/${ID}`, "link_origin_or_path"],
    ["page", `${PAGE_SENTENCE}\r\n${link}`, "carriage_return"],
    ["page", PAGE_SENTENCE, "line_count"],
    ["page", `${PAGE_SENTENCE}\n${link}\n${CHANNEL_CHECK_SENTENCE}\n`, "line_count"],
    ["digest", `${DIGEST_SENTENCE}\n${link}\n${CHANNEL_CHECK_SENTENCE}`, "line_count"],
    ["digest", `${PAGE_SENTENCE}\n${link}`, "sentence"],
    ["channel_check", `${CHANNEL_CHECK_SENTENCE}\n${link}`, "line_count"],
    ["channel_check", `${CHANNEL_CHECK_SENTENCE} `, "sentence"],
    ["page", "", "empty"],
    ["page", 7, "not_text"],
    ["sms", PAGE_SENTENCE, "unknown_kind"],
  ];
  for (const [kind, text, reason] of cases) {
    assert.deepEqual(checkNotification(kind, text), { ok: false, reason }, JSON.stringify(text));
  }
});

test("a decomposed (non-NFC) copy of the sentence is refused", () => {
  const decomposed = `${PAGE_SENTENCE.normalize("NFD")}\n${adminItemLink(ID)}`;
  assert.notEqual(decomposed, decomposed.normalize("NFC"));
  assert.deepEqual(checkNotification("page", decomposed), { ok: false, reason: "not_nfc" });
});

test("a refusal reason never echoes the refused text", () => {
  const secretish = `${PAGE_SENTENCE}\n${adminItemLink(ID)}\nsk_live_abc123`;
  const verdict = checkNotification("page", secretish);
  assert.equal(verdict.ok, false);
  assert.ok(!JSON.stringify(verdict).includes("sk_live"));
});
