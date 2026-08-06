import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_TAB,
  isSettingsSectionId,
  parseSettingsDeepLink,
  settingsSectionElementId,
  settingsSectionHref,
  stripSettingsDeepLink,
} from "../lib/settingsNavigation.ts";
import {
  consumePendingAccountSettingsRequest,
  readAccountSettingsOpenRequest,
} from "../lib/accountSettingsEvents.ts";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";

const LOCALES = { en, ko };

test("every entry with a detail page addresses the settings list, not the chat", () => {
  for (const section of SETTINGS_SECTION_IDS) {
    const href = settingsSectionHref(section);
    assert.match(href, /^\/chat\?/);
    const link = parseSettingsDeepLink(href.slice(href.indexOf("?")));
    assert.deepEqual(link, { tab: SETTINGS_SECTION_TAB[section], section });
  }
});

test("both entries live under the same settings tab but stay separate rows", () => {
  assert.deepEqual(SETTINGS_SECTION_IDS, ["external-import", "memory"]);
  assert.equal(SETTINGS_SECTION_TAB["external-import"], "data");
  assert.equal(SETTINGS_SECTION_TAB.memory, "data");
  assert.notEqual(
    settingsSectionElementId("external-import"),
    settingsSectionElementId("memory")
  );
  assert.notEqual(
    settingsSectionHref("external-import"),
    settingsSectionHref("memory")
  );
});

test("a directly opened detail-page link still resolves without any history", () => {
  // Nothing but the query string is consulted: no referrer, no prior state.
  assert.deepEqual(parseSettingsDeepLink("?settings=data&settingsSection=memory"), {
    tab: "data",
    section: "memory",
  });
  assert.deepEqual(parseSettingsDeepLink("settings=data"), {
    tab: "data",
    section: null,
  });
});

test("an unrelated query string never opens the settings panel", () => {
  assert.equal(parseSettingsDeepLink(""), null);
  assert.equal(parseSettingsDeepLink("?section=memory"), null);
  assert.equal(parseSettingsDeepLink("?settings=nowhere"), null);
  assert.equal(parseSettingsDeepLink("?q=settings"), null);
});

test("an unknown section opens the tab rather than nothing at all", () => {
  assert.deepEqual(parseSettingsDeepLink("?settings=plan&settingsSection=zzz"), {
    tab: "plan",
    section: null,
  });
});

test("the section decides the tab when a hand-edited pair disagrees", () => {
  assert.deepEqual(
    parseSettingsDeepLink("?settings=plan&settingsSection=memory"),
    { tab: "data", section: "memory" }
  );
});

test("stripping the request leaves the rest of the query string untouched", () => {
  assert.equal(
    stripSettingsDeepLink("?settings=data&settingsSection=memory"),
    ""
  );
  assert.equal(
    stripSettingsDeepLink("?lang=ko&settings=data&settingsSection=memory"),
    "?lang=ko"
  );
  assert.equal(stripSettingsDeepLink("?lang=ko"), "?lang=ko");
});

test("isSettingsSectionId rejects anything that has no row to restore", () => {
  assert.equal(isSettingsSectionId("memory"), true);
  assert.equal(isSettingsSectionId("Memory"), false);
  assert.equal(isSettingsSectionId(null), false);
  assert.equal(isSettingsSectionId(undefined), false);
  assert.equal(isSettingsSectionId(42), false);
});

test("the open request reads both the object and the bare tab shape", () => {
  assert.deepEqual(readAccountSettingsOpenRequest("data"), {
    tab: "data",
    section: null,
  });
  assert.deepEqual(
    readAccountSettingsOpenRequest({ tab: "data", section: "memory" }),
    { tab: "data", section: "memory" }
  );
  assert.deepEqual(readAccountSettingsOpenRequest({ tab: "nope" }), {
    tab: "account",
    section: null,
  });
  assert.deepEqual(readAccountSettingsOpenRequest(undefined), {
    tab: "account",
    section: null,
  });
});

test("a request nobody made is never replayed on the next mount", () => {
  assert.equal(consumePendingAccountSettingsRequest(), null);
});

test("no user-facing label promises a destination the link does not go to", () => {
  for (const [name, locale] of Object.entries(LOCALES)) {
    // The two detail pages navigate up to settings, so the copy they use has
    // to name settings -- and the chat-bound wording is gone from the bundle
    // entirely, not merely unused.
    assert.equal(locale.externalImport.backToChat, undefined, name);
    assert.equal(locale.memoryReview.backToChat, undefined, name);
    assert.ok(locale.settingsNav.backToSettings, name);
  }
});

test("the group and the trail call the same thing by the same name", () => {
  for (const [name, locale] of Object.entries(LOCALES)) {
    assert.ok(locale.settingsNav.dataAndPersonalization, name);
    assert.ok(locale.settingsNav.settings, name);
    assert.ok(locale.settingsNav.navLabel, name);
  }
});

test("each entry's action names its own purpose instead of repeating one CTA", () => {
  for (const [name, locale] of Object.entries(LOCALES)) {
    const importAction = locale.externalImport.dataTabOpen;
    const memoryAction = locale.memoryReview.dataTabOpen;
    assert.ok(importAction, name);
    assert.ok(memoryAction, name);
    assert.notEqual(importAction, memoryAction, name);
    // Neither may fall back to the generic "open settings" phrasing the rows
    // replaced, in either language.
    for (const action of [importAction, memoryAction]) {
      assert.doesNotMatch(action, /open .*settings/i, name);
      assert.doesNotMatch(action, /설정 열기/, name);
    }
  }
});

test("every row can state where it stands, including when it is empty", () => {
  for (const [name, locale] of Object.entries(LOCALES)) {
    assert.ok(locale.externalImport.dataTabUsage.includes("{conversations}"), name);
    assert.ok(locale.externalImport.dataTabUsageEmpty, name);
    assert.ok(locale.memoryReview.dataTabStatusOn, name);
    assert.ok(locale.memoryReview.dataTabStatusOff, name);
    assert.notEqual(
      locale.memoryReview.dataTabStatusOn,
      locale.memoryReview.dataTabStatusOff,
      name
    );
    assert.ok(locale.memoryReview.dataTabStatusPending.includes("{count}"), name);
  }
});
