import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DATABASE_RETRY_AFTER_SECONDS,
  DATABASE_RETRY_MAX_DELAY_MS,
  DATABASE_TEMPORARILY_UNAVAILABLE_CODE,
  isTransientDatabaseCode,
  transientDatabaseRetryDelayMs,
  waitForTransientRetry,
} from "../lib/databaseError.ts";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";
import { zhHant } from "../locales/zhHant.ts";

const locales = { en, ko, zh, zhHant, fr, de, es, pt };

test("only the dedicated code is a transient database refusal", () => {
  assert.equal(isTransientDatabaseCode(DATABASE_TEMPORARILY_UNAVAILABLE_CODE), true);
  assert.equal(isTransientDatabaseCode("CHAT_APPLICATION_ERROR"), false);
  assert.equal(isTransientDatabaseCode("AI_PROVIDER_ERROR"), false);
  assert.equal(isTransientDatabaseCode(undefined), false);
});

test("the pause before the one resend follows Retry-After, bounded", () => {
  assert.equal(transientDatabaseRetryDelayMs("2"), 2_000);
  assert.equal(transientDatabaseRetryDelayMs("0"), 0);
  assert.equal(transientDatabaseRetryDelayMs("1.5"), 1_500);
  // Not delta-seconds, absent or hostile: the server's own default, never a
  // value that parks a send.
  for (const value of [undefined, null, "", "soon", "-3", "Wed, 21 Oct 2026 07:28:00 GMT", "NaN"]) {
    assert.equal(
      transientDatabaseRetryDelayMs(value),
      DATABASE_RETRY_AFTER_SECONDS * 1_000,
      String(value)
    );
  }
  assert.equal(transientDatabaseRetryDelayMs("3600"), DATABASE_RETRY_MAX_DELAY_MS);
});

test("the wait ends early when the person presses Stop", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = waitForTransientRetry(5_000, controller.signal);
  controller.abort();
  await waiting;
  assert.ok(Date.now() - started < 1_000, "an abort does not wait out the delay");
  assert.equal(controller.signal.aborted, true);

  const already = new AbortController();
  already.abort();
  await waitForTransientRetry(5_000, already.signal);
});

test("the wait lasts for the delay when nothing interrupts it", async () => {
  const started = Date.now();
  await waitForTransientRetry(60, new AbortController().signal);
  assert.ok(Date.now() - started >= 50);
});

test("every locale says it", () => {
  const lookup = (dictionary, key) =>
    key.split(".").reduce((node, part) => (node ? node[part] : undefined), dictionary);
  for (const [language, dictionary] of Object.entries(locales)) {
    const sentence = lookup(dictionary, "chat.databaseTemporarilyUnavailable");
    assert.equal(typeof sentence, "string", language);
    assert.ok(sentence.trim().length > 0, language);
  }
});

/**
 * The panel is not mountable in the unit lane, so its wiring is read the way
 * `chatStreamConsumer.test.mjs` reads it: what has to be true of the source for
 * the behaviour to exist, not a snapshot of it.
 */
test("the panel resends once, only on the dedicated code, and never a one-shot turn", () => {
  const source = readFileSync(new URL("../components/chat/ChatApp.tsx", import.meta.url), "utf8");
  const start = source.indexOf("isTransientDatabaseCode(code)");
  assert.ok(start > 0, "the recovery branch exists");
  const branch = source.slice(start, start + 4_000);
  assert.ok(branch.includes("transientDatabaseRetries < 1"), "one resend, not a loop");
  assert.ok(branch.includes("!(isGuestMode && guestAutoCapability)"), "a Guest Auto turn is never resent");
  assert.ok(
    source.slice(start - 300, start).includes("promptRefinerAllowsAutomaticChatRecovery"),
    "a send carrying a one-shot Refiner decision is never resent"
  );
  assert.ok(branch.includes("crypto.randomUUID()"), "the answer gets a fresh id");
  assert.ok(branch.includes("waitForTransientRetry"), "the server's pause is honoured");
  // The second refusal reaches the localized sentence rather than the raw one.
  assert.ok(source.includes('t("chat.databaseTemporarilyUnavailable")'));
});
