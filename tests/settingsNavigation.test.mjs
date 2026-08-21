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
  ASSISTANT_PROFILE_FOCUS_PARAM,
  settingsBackTarget,
  ASSISTANT_PROFILE_LIST_PATH,
  assistantProfileHierarchy,
  assistantProfileListHref,
  settingsEntryHierarchy,
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
  // Asserted explicitly rather than derived: this list is what stops a section
  // vanishing in a refactor, so a change to it has to be a change here too.
  assert.deepEqual(SETTINGS_SECTION_IDS, [
    "external-import",
    "memory",
    "assistants",
    "account-data",
    "email-notifications",
  ]);

  // Pinned per section rather than "all of them are in `data`". They were all
  // in one tab, and asserting that shape said nothing about whether each row
  // was in the right place -- it only said they were in the same place. What
  // has to hold now is that a row's tab, its href and its breadcrumb agree,
  // which is what the rest of this test and the trail test below check.
  const EXPECTED_TAB = {
    "external-import": "data",
    memory: "ai",
    // Its own tab, which is also where the collection is managed.
    assistants: "assistants",
    "account-data": "data",
    // Outbound mail, not stored data -- but it is still an account-wide data
    // decision, so it sits in the same tab as import and export.
    "email-notifications": "data",
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
  // before a move still names the old tab, and the section still wins. Both
  // moves are covered -- `data` was the first home, `ai` the second -- because
  // a bookmark from either era has to keep working.
  assert.deepEqual(
    parseSettingsDeepLink("?settings=data&settingsSection=assistants"),
    { tab: "assistants", section: "assistants" }
  );
  assert.deepEqual(
    parseSettingsDeepLink("?settings=ai&settingsSection=assistants"),
    { tab: "assistants", section: "assistants" }
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

/* ------------------------------------------------ nested detail pages ---- */

test("tab ids stay stable while the names on screen change", () => {
  // The name on screen is a product decision; the ids are what a bookmark and
  // a deep link carry, and renaming a tab must not break either.
  assert.equal(SETTINGS_SECTION_TAB.assistants, "assistants");
  assert.equal(SETTINGS_SECTION_TAB.memory, "ai");
  assert.deepEqual(
    parseSettingsDeepLink("?settings=ai&settingsSection=memory"),
    { tab: "ai", section: "memory" }
  );
  assert.equal(
    settingsSectionHref("assistants"),
    "/chat?settings=assistants&settingsSection=assistants"
  );
  assert.equal(
    settingsSectionHref("memory"),
    "/chat?settings=ai&settingsSection=memory"
  );
});

test("the tab and the breadcrumb crumb read one label key", () => {
  // Two keys is how "AI settings" and "AI personalization" ended up on screen
  // at the same time, one in the tab strip and one in the trail below it.
  assert.equal(SETTINGS_TAB_LABEL_KEY.ai, "settingsNav.aiPersonalization");
  assert.equal(SETTINGS_TAB_LABEL_KEY.assistants, "settingsNav.assistantsTab");
  assert.equal(
    settingsSectionGroupLabelKey("assistants"),
    SETTINGS_TAB_LABEL_KEY.assistants
  );
  assert.equal(
    settingsSectionGroupLabelKey("memory"),
    SETTINGS_TAB_LABEL_KEY.ai
  );
  for (const [name, locale] of Object.entries(LOCALES)) {
    assert.ok(locale.settingsNav.aiPersonalization, name);
    assert.ok(locale.settingsNav.assistantsTab, name);
    // The group inside a tab is named for what it holds, so the two are not
    // the same string.
    assert.ok(locale.settingsNav.profilesAndMemory, name);
    assert.notEqual(
      locale.settingsNav.profilesAndMemory,
      locale.settingsNav.aiPersonalization,
      `${name} names the tab and the group inside it identically`
    );
  }
});

test("a settings entry page goes back to the panel, and names its tab", () => {
  for (const section of SETTINGS_SECTION_IDS) {
    const trail = settingsEntryHierarchy(section);
    // Two crumbs, one destination: the panel opens *at* the tab, so the tab
    // names where you are rather than offering a second place to go.
    assert.equal(trail.length, 2);
    assert.equal(trail[0].href, settingsSectionHref(section));
    assert.equal(trail[1].href, undefined);
    assert.equal(trail[1].labelKey, settingsSectionGroupLabelKey(section));

    const back = settingsBackTarget(trail);
    assert.equal(back.href, settingsSectionHref(section));
    assert.equal(back.backLabelKey, "settingsNav.backToSettings");
  }
});

test("the back target is the nearest ancestor that is somewhere", () => {
  // Not simply the last crumb: for both page kinds the last crumb may be a
  // naming step, and a back link pointing at a label has nowhere to go.
  const entry = settingsBackTarget(settingsEntryHierarchy("memory"));
  assert.equal(entry.href, settingsSectionHref("memory"));

  const profile = settingsBackTarget(assistantProfileHierarchy());
  assert.equal(profile.href, ASSISTANT_PROFILE_LIST_PATH);
  assert.equal(profile.backLabelKey, "assistantProfiles.backToList");
});

test("a profile's nearest ancestor is the list, not the settings panel", () => {
  // The correction this whole hierarchy exists for: the editor used to offer
  // "back to settings", skipping the list it sat inside, while the trail
  // underneath claimed a hierarchy the link did not follow.
  const trail = assistantProfileHierarchy();
  assert.equal(trail.length, 3);
  const parent = settingsBackTarget(trail);
  assert.equal(parent.href, ASSISTANT_PROFILE_LIST_PATH);
  assert.equal(parent.backLabelKey, "assistantProfiles.backToList");

  // Settings, then the AI tab, then the list -- the order a reader walks up.
  assert.deepEqual(
    trail.map((ancestor) => ancestor.labelKey),
    [
      "settingsNav.settings",
      SETTINGS_TAB_LABEL_KEY.assistants,
      "assistantProfiles.pageTitle",
    ]
  );
});

test("every ancestor's back label exists in every locale", () => {
  const trails = [
    ...SETTINGS_SECTION_IDS.map((section) => settingsEntryHierarchy(section)),
    assistantProfileHierarchy(),
  ];
  for (const trail of trails) {
    for (const ancestor of trail) {
      for (const key of [ancestor.labelKey, ancestor.backLabelKey].filter(
        Boolean
      )) {
        const [namespace, leaf] = key.split(".");
        for (const [name, locale] of Object.entries(LOCALES)) {
          assert.ok(locale[namespace]?.[leaf], `${name} has no ${key}`);
        }
      }
    }
  }
});

test("the focus hint is a query parameter, never a path", () => {
  assert.equal(assistantProfileListHref(), ASSISTANT_PROFILE_LIST_PATH);
  assert.equal(
    assistantProfileListHref("p-1"),
    `${ASSISTANT_PROFILE_LIST_PATH}?${ASSISTANT_PROFILE_FOCUS_PARAM}=p-1`
  );
  // A value that would change the destination if it were pasted in raw is
  // encoded, so the href still points at the list and the list still decides
  // what to do with the value by looking it up among its own rows.
  for (const hostile of ["../../admin", "a/b", "?x=1", "https://evil.example"]) {
    const href = assistantProfileListHref(hostile);
    assert.ok(
      href.startsWith(`${ASSISTANT_PROFILE_LIST_PATH}?${ASSISTANT_PROFILE_FOCUS_PARAM}=`),
      `${hostile} escaped the query string`
    );
    assert.equal(href.includes("/", ASSISTANT_PROFILE_LIST_PATH.length), false);
  }
});
