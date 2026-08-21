import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_HOME_PATH,
  SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_TAB,
  isSettingsSectionId,
  parseSettingsDeepLink,
  settingsExitHref,
  settingsSectionElementId,
  settingsSectionHref,
  stripSettingsDeepLink,
} from "../lib/settingsNavigation.ts";
import {
  consumePendingAccountSettingsRequest,
  readAccountSettingsOpenRequest,
} from "../lib/accountSettingsEvents.ts";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

const LOCALES = { en, ko };
// The exit control ships in every language the product speaks, so its copy is
// checked in every language rather than in the two the rest of this file
// happens to assert on.
const ALL_LOCALES = { de, en, es, fr, ko, pt, zh };

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
test("every entry lives under the same settings tab but stays a separate row", () => {
  assert.deepEqual(SETTINGS_SECTION_IDS, ["external-import", "memory", "assistants", "account-data"]);

  const elementIds = new Set();
  const hrefs = new Set();
  for (const section of SETTINGS_SECTION_IDS) {
    assert.equal(
      SETTINGS_SECTION_TAB[section],
      "data",
      `${section} is not in the data tab, so the group heading above it would be wrong`
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
    // A detail page's own nav goes up to settings, so it names settings. The
    // chat-bound wording it used to carry stays deleted from these
    // namespaces: the one control that goes to the chat owns the only key
    // that says so (settingsNav.backToChat).
    assert.equal(locale.externalImport.backToChat, undefined, name);
    assert.equal(locale.memoryReview.backToChat, undefined, name);
    assert.ok(locale.settingsNav.backToSettings, name);
  }
});

test("the exit goes to the bare chat route, with nothing appended", () => {
  // A settings deep link here would reopen the panel the visitor just asked
  // to leave, so the exit href must not merely *start* with /chat.
  assert.equal(settingsExitHref(), "/chat");
  assert.equal(settingsExitHref(), SETTINGS_HOME_PATH);
  assert.equal(parseSettingsDeepLink(""), null);

  // And it is a different destination from every hierarchical back link, in
  // both directions: no section href collapses to the exit, and the exit
  // carries no section.
  for (const section of SETTINGS_SECTION_IDS) {
    assert.notEqual(settingsSectionHref(section), settingsExitHref());
  }
});

test("both movements are named, in every language, and never share a phrase", () => {
  for (const [name, locale] of Object.entries(ALL_LOCALES)) {
    const { backToSettings, backToChat, backToChatShort, exitNavLabel } =
      locale.settingsNav;

    // One level up and all the way out are different movements; a locale that
    // gives them the same words leaves two controls no one can tell apart.
    assert.ok(backToSettings, name);
    assert.ok(backToChat, name);
    assert.notEqual(backToChat, backToSettings, name);

    // The narrow-viewport rendering is the same control, so it stays part of
    // the accessible name rather than a second, shorter phrase: WCAG 2.5.3
    // asks that what is on screen appear in the name, and a speech-input user
    // can only say what they can see.
    assert.ok(backToChatShort, name);
    assert.ok(backToChat.length >= backToChatShort.length, name);
    assert.ok(
      backToChat.toLowerCase().includes(backToChatShort.toLowerCase()),
      `${name}: "${backToChatShort}" is not part of "${backToChat}"`
    );

    // The exit strip is its own landmark, so it cannot borrow the detail
    // nav's name -- two "Settings navigation" entries in the landmark list
    // are indistinguishable.
    assert.ok(exitNavLabel, name);
    assert.notEqual(exitNavLabel, locale.settingsNav.navLabel, name);
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
