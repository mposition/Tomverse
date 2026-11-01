import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  changeMarketingChannelLocales,
  MarketingChannelLocalesRefusedError,
  MARKETING_ACCOUNT_LOCALES_ACTION,
  MARKETING_REFUSAL_STATUS,
  MARKETING_S2B1_ACTIONS,
} from "../lib/marketingStore.ts";

// An account's languages (operator decision 2026-11-01: Instagram is one
// account per language, docs/policy/marketing-automation.md §7.6, and the
// first account was registered with three). The trigger and CHECK half is in
// tests/integration/marketing-automation-schema.db.test.ts.

const account = (overrides = {}) => ({
  status: "approval_mode",
  defaultLocale: "en",
  allowedLocales: ["ko", "en", "zh-Hant"],
  ...overrides,
});

const fakeDatabase = (row, { unfinished = 0, updated = 1 } = {}) => {
  const calls = [];
  return {
    calls,
    database: {
      marketingChannel: {
        findUnique: async (query) => {
          calls.push(["read", query]);
          return row;
        },
        updateMany: async (query) => {
          calls.push(["update", query]);
          return { count: updated };
        },
      },
      marketingPost: {
        count: async (query) => {
          calls.push(["count", query]);
          return unfinished;
        },
      },
    },
  };
};

const narrowToEnglish = {
  id: "channel-1",
  expectedDefaultLocale: "en",
  expectedAllowedLocales: ["ko", "en", "zh-Hant"],
  defaultLocale: "en",
  allowedLocales: ["en"],
};

const refusedWith = (code, status) => (error) =>
  error instanceof MarketingChannelLocalesRefusedError &&
  error.code === code &&
  error.status === status;

test("the language change keeps out of the tables the webhook fingerprint reads", () => {
  // Both tables are reached by the webhook modules, so an entry in either
  // moves the pipeline fingerprint and stales the signed production
  // verification for a change that decides no webhook event.
  assert.equal(MARKETING_ACCOUNT_LOCALES_ACTION, "marketing_account.locales_changed");
  assert.ok(!Object.values(MARKETING_S2B1_ACTIONS).includes(MARKETING_ACCOUNT_LOCALES_ACTION));
  assert.ok(!("locales_change_conflict" in MARKETING_REFUSAL_STATUS));
});

test("a default outside the languages, and a no-op, are refused before reading", async () => {
  const { calls, database } = fakeDatabase(account());
  await assert.rejects(
    changeMarketingChannelLocales(database, { ...narrowToEnglish, defaultLocale: "ko" }),
    refusedWith("default_locale_not_allowed", 400),
  );
  // The same set in another order, with a duplicate, is not a change.
  await assert.rejects(
    changeMarketingChannelLocales(database, {
      ...narrowToEnglish,
      allowedLocales: ["zh-Hant", "en", "ko", "en"],
    }),
    refusedWith("locales_unchanged", 400),
  );
  assert.deepEqual(calls, []);
});

test("a missing account, a stale view and an unapproved state write nothing", async () => {
  const missing = fakeDatabase(null);
  await assert.rejects(
    changeMarketingChannelLocales(missing.database, narrowToEnglish),
    refusedWith("channel_not_found", 404),
  );

  const stale = fakeDatabase(account({ allowedLocales: ["en", "ko"] }));
  await assert.rejects(
    changeMarketingChannelLocales(stale.database, narrowToEnglish),
    refusedWith("locales_change_conflict", 409),
  );
  assert.deepEqual(stale.calls.map(([kind]) => kind), ["read"]);

  for (const status of ["autonomous_mode", "paused", "disconnected"]) {
    const { calls, database } = fakeDatabase(account({ status }));
    await assert.rejects(
      changeMarketingChannelLocales(database, narrowToEnglish),
      refusedWith("locales_change_needs_approval_mode", 409),
      status,
    );
    assert.deepEqual(calls.map(([kind]) => kind), ["read"], status);
  }
});

test("the write is conditioned on the row it read and comes before the post count", async () => {
  const { calls, database } = fakeDatabase(account({ status: "connect_pending" }));
  const result = await changeMarketingChannelLocales(database, narrowToEnglish);
  assert.deepEqual(result, {
    defaultLocale: "en",
    allowedLocales: ["en"],
    droppedLocales: ["ko", "zh-Hant"],
  });
  // The update takes the row lock that a post insert's trigger waits on, so
  // the count after it cannot miss a post in a dropped language.
  assert.deepEqual(calls.map(([kind]) => kind), ["read", "update", "count"]);
  assert.deepEqual(calls[1][1], {
    where: {
      id: "channel-1",
      status: "connect_pending",
      defaultLocale: "en",
      allowedLocales: { equals: ["ko", "en", "zh-Hant"] },
    },
    data: { defaultLocale: "en", allowedLocales: ["en"] },
  });

  const lost = fakeDatabase(account(), { updated: 0 });
  await assert.rejects(
    changeMarketingChannelLocales(lost.database, narrowToEnglish),
    refusedWith("locales_change_conflict", 409),
  );
  assert.deepEqual(lost.calls.map(([kind]) => kind), ["read", "update"]);
});

test("removing a language waits for every post in it that could still go out", async () => {
  const { calls, database } = fakeDatabase(account(), { unfinished: 2 });
  await assert.rejects(
    changeMarketingChannelLocales(database, narrowToEnglish),
    refusedWith("locales_change_has_unfinished_posts", 409),
  );
  const [, { where }] = calls.find(([kind]) => kind === "count");
  assert.equal(where.channelId, "channel-1");
  assert.deepEqual(where.locale.in, ["ko", "zh-Hant"]);
  // Everything a status-only move can still carry to the platform, and none
  // of the states that are over.
  assert.deepEqual([...where.status.in].sort(), [
    "approved",
    "drafted",
    "failed",
    "outcome_unknown",
    "pending_approval",
    "publishing",
    "scheduled",
  ]);

  // Adding a language removes none, so there is nothing to wait for.
  const widen = fakeDatabase(account({ allowedLocales: ["en"] }));
  await changeMarketingChannelLocales(widen.database, {
    ...narrowToEnglish,
    expectedAllowedLocales: ["en"],
    allowedLocales: ["en", "ko"],
  });
  assert.deepEqual(widen.calls.map(([kind]) => kind), ["read", "update"]);
});

test("the console offers the language change in exactly the states the store accepts", () => {
  const listed = (path, name) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const at = source.indexOf(name);
    assert.ok(at > 0, `${name} is missing from ${path}`);
    const open = source.indexOf("[", at);
    const close = source.indexOf("]", open);
    return source
      .slice(open + 1, close)
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
      .filter((entry) => entry.length > 0)
      .sort();
  };
  const store = listed("../lib/marketingStore.ts", "MARKETING_LOCALE_CHANGE_STATUSES =");
  assert.deepEqual(store, ["approval_mode", "connect_pending"]);
  assert.deepEqual(
    listed("../components/admin/AdminMarketingPanel.tsx", "MARKETING_LOCALE_CHANGE_ACCOUNT_STATUSES ="),
    store,
  );
});
