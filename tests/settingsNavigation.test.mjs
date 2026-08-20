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
  settingsSectionGroupLabelKey,
  SETTINGS_TAB_LABEL_KEY,
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

// The set is asserted explicitly so a section cannot quietly disappear, but the
// row-level properties are derived: adding a fourth entry should not mean
// hand-writing another pair of comparisons that somebody will forget.
test("every entry names the tab it is actually in, and stays a separate row", () => {
  assert.deepEqual(SETTINGS_SECTION_IDS, ["external-import", "memory", "assistants", "account-data"]);

  // Pinned per section rather than "all of them are in `data`". They were all
  // in one tab, and asserting that shape said nothing about whether each row
  // was in the right place -- it only said they were in the same place. What
  // has to hold now is that a row's tab, its href and its breadcrumb agree,
  // which is what the rest of this test and the trail test below check.
  const EXPECTED_TAB = {
    "external-import": "data",
    memory: "ai",
    assistants: "ai",
    "account-data": "data",
  };

  const elementIds = new Set();
  const hrefs = new Set();
  for (const section of SETTINGS_SECTION_IDS) {
    assert.equal(
      SETTINGS_SECTION_TAB[section],
      EXPECTED_TAB[section],
      `${section} is not in the ${EXPECTED_TAB[section]} tab, so the group heading above it would be wrong`
    );

    // The href is what "Back to settings" uses, so it has to carry the same
    // tab the row lives in. A drifting pair opens a tab the row is not in.
    assert.match(
      settingsSectionHref(section),
      new RegExp(`[?&]settings=${EXPECTED_TAB[section]}(&|$)`),
      `${section}'s back link opens a different tab than the row is in`
    );

    const elementId = settingsSectionElementId(section);
    assert.equal(elementIds.has(elementId), false, `${section} shares a DOM id`);
    elementIds.add(elementId);

    // A shared href would restore the wrong row on the way back up.
    const href = settingsSectionHref(section);
    assert.equal(hrefs.has(href), false, `${section} shares an href`);
    hrefs.add(href);
  }
});

test("a directly opened detail-page link still resolves without any history", () => {
  // Nothing but the query string is consulted: no referrer, no prior state.
  assert.deepEqual(parseSettingsDeepLink("?settings=ai&settingsSection=memory"), {
    tab: "ai",
    section: "memory",
  });
  assert.deepEqual(parseSettingsDeepLink("?settings=data&settingsSection=external-import"), {
    tab: "data",
    section: "external-import",
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
    { tab: "ai", section: "memory" }
  );
  // The direction that regressed when the tabs were split: a link minted
  // before the move still names `data`, and the section still wins.
  assert.deepEqual(
    parseSettingsDeepLink("?settings=data&settingsSection=assistants"),
    { tab: "ai", section: "assistants" }
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
    assert.ok(locale.settingsNav.aiPersonalization, name);
    assert.ok(locale.settingsNav.settings, name);
    assert.ok(locale.settingsNav.navLabel, name);
  }
});

test("a detail page's breadcrumb names the tab its back link opens", () => {
  // The bug this replaces a hard-coded string to prevent: the trail said
  // "Data & personalization" on every detail page, so once profiles and
  // memory moved the breadcrumb and the back link beside it disagreed --
  // and the breadcrumb is the half a reader trusts to know where they are.
  for (const section of SETTINGS_SECTION_IDS) {
    const key = settingsSectionGroupLabelKey(section);
    assert.equal(
      key,
      SETTINGS_TAB_LABEL_KEY[SETTINGS_SECTION_TAB[section]],
      `${section}'s trail is not derived from the tab it lives in`
    );
    const [namespace, leaf] = key.split(".");
    for (const [name, locale] of Object.entries(LOCALES)) {
      assert.ok(
        locale[namespace]?.[leaf],
        `${name} has no ${key} for ${section}'s breadcrumb`
      );
    }
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
