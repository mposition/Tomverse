import assert from "node:assert/strict";
import test from "node:test";

import { rowActions } from "@/components/admin/AdminMarketingPanel";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * What the Published tab offers for a hand-posted account's approved post
 * (operator decision 2026-11-04): no schedule button, and a form that records
 * the post once the person has put it up. Executed, not read: the actions the
 * console hands its rail are called and their bodies inspected.
 */

const DIGEST = "d".repeat(64);

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "post-1",
  accountSlug: "x-1",
  channel: "x",
  provider: "manual",
  status: "approved",
  envelopeDigest: DIGEST,
  historyVersion: 4,
  legalHold: false,
  reusableAsTemplate: false,
  ...overrides,
});

for (const locale of ["en", "ko"] as const) {
  const m = adminMarketingMessages[locale] as unknown as Record<string, string>;

  test(`${locale}: an approved hand-posted post offers recording, and no schedule button`, () => {
    const actions = rowActions("published", row(), m);
    const ids = actions.map((action) => action.id);
    assert.ok(ids.includes("record-manual-publish"));
    assert.equal(ids.includes("schedule"), false);
    // Taking the approval back is still there.
    assert.ok(ids.includes("withdraw-approval"));

    const record = actions.find((action) => action.id === "record-manual-publish");
    assert.ok(record);
    assert.equal(record.label, m.actRecordManualPublish);
    assert.ok(record.label.length > 0);
    assert.equal(record.path, "/api/admin/marketing/posts/post-1/record-manual");
    assert.equal(record.confirm, m.confirmRecordManualPublish);
    // Both fields are required, and the link is a url input.
    assert.deepEqual(
      record.fields?.map((field) => [field.name, field.kind, field.required]),
      [
        ["externalUrl", "url", true],
        ["evidenceRef", "text", true],
      ],
    );
    assert.deepEqual(
      record.body({
        externalUrl: "  https://x.com/tomverse/status/1  ",
        evidenceRef: " opened it signed out ",
      }),
      {
        expectedEnvelopeDigest: DIGEST,
        expectedHistoryVersion: 4,
        externalUrl: "https://x.com/tomverse/status/1",
        evidenceRef: "opened it signed out",
      },
    );
  });

  test(`${locale}: an overage on the record is told to the operator, and not otherwise`, () => {
    const record = rowActions("published", row(), m).find(
      (action) => action.id === "record-manual-publish",
    );
    assert.ok(record?.describe);
    assert.equal(record.describe({ warnings: [] }), m.recordManualPublishDone);
    assert.equal(record.describe(undefined), m.recordManualPublishDone);
    assert.equal(
      record.describe({ warnings: ["daily_cap_exceeded"] }),
      `${m.recordManualPublishDone}${m.recordManualPublishDailyOver}`,
    );
    assert.equal(
      record.describe({ warnings: ["daily_cap_exceeded", "weekly_cap_exceeded"] }),
      `${m.recordManualPublishDone}${m.recordManualPublishDailyOver}${m.recordManualPublishWeeklyOver}`,
    );
  });
}

test("a post of an account the publisher carries is scheduled, not recorded by hand", () => {
  const m = adminMarketingMessages.en as unknown as Record<string, string>;
  for (const provider of ["zernio", undefined]) {
    const ids = rowActions("published", row({ provider }), m).map((action) => action.id);
    assert.ok(ids.includes("schedule"), String(provider));
    assert.equal(ids.includes("record-manual-publish"), false, String(provider));
  }
});

test("a hand-posted post is offered the record only while it is approved", () => {
  const m = adminMarketingMessages.en as unknown as Record<string, string>;
  for (const status of ["scheduled", "published", "verified", "failed", "deleted"]) {
    const ids = rowActions("published", row({ status }), m).map((action) => action.id);
    assert.equal(ids.includes("record-manual-publish"), false, status);
    assert.equal(ids.includes("schedule"), false, status);
  }
});

test("the new console messages exist in both languages", () => {
  for (const key of [
    "actRecordManualPublish",
    "confirmRecordManualPublish",
    "recordManualPublishDone",
    "recordManualPublishDailyOver",
    "recordManualPublishWeeklyOver",
    "hintManualPublishUrl",
  ]) {
    for (const locale of ["en", "ko"] as const) {
      const text = (adminMarketingMessages[locale] as unknown as Record<string, string>)[key];
      assert.ok(typeof text === "string" && text.trim().length > 0, `${locale}.${key}`);
    }
  }
});

test("the Published tab's read hands each row its account's provider", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../lib/marketingConsoleRead.ts", import.meta.url), "utf8");
  const published = source.slice(source.indexOf('if (section === "published")'));
  const section = published.slice(0, published.indexOf('if (section === "accounts")'));
  assert.match(section, /channel: \{ select: \{ accountSlug: true, channel: true, provider: true \} \}/u);
  assert.match(section, /provider: post\.channel\.provider/u);
});
