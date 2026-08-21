import {
    isAccountSettingsTab,
    type AccountSettingsTab,
} from "@/lib/accountSettingsEvents";

/**
 * Where a settings *detail page* goes when the user navigates back up.
 *
 * Settings is not a route: it is a closable panel (the modal inside
 * components/auth/AuthButton.tsx) that lives on the chat surface. Its detail
 * screens — everything under /settings — are full pages, so their upward
 * navigation has to name a destination rather than lean on `router.back()`,
 * which points at whatever the visitor happened to see last and at nothing at
 * all when the URL was opened directly.
 *
 * The destination is therefore the chat route plus a deep link that says which
 * settings tab to open and which entry inside it to restore, so "Back to
 * settings" lands on the settings list with the row the user came from
 * scrolled into view and focused.
 *
 * Leaving the settings hierarchy altogether is a *second*, separate movement,
 * and it needs its own control: the panel's close button is on the chat
 * surface, which is exactly the surface a visitor standing on
 * /settings/imports/conversations/<id> cannot reach without walking back up
 * one level at a time. `settingsExitHref()` is that one-click way out, and it
 * goes to the bare chat route — no deep link, so the panel stays closed and
 * the tab's own last conversation is restored by the chat page as usual.
 * Both movements are rendered, and they are never merged into one control:
 * see docs/ui-contracts/settings-navigation.md §1.
 */
export const SETTINGS_HOME_PATH = "/chat";

/**
 * The chat route with nothing appended. Written through the same constant the
 * deep links are built from so "/chat" has one spelling in this module, and
 * kept parameter-free on purpose: any `settings=` value here would reopen the
 * panel the visitor just asked to leave.
 */
export const settingsExitHref = () => SETTINGS_HOME_PATH;

/**
 * Shared handle for the exit control, so the layout that renders it and the
 * tests that look for it cannot drift apart.
 */
export const SETTINGS_RETURN_TO_CHAT_TEST_ID = "settings-return-to-chat";

export const SETTINGS_TAB_QUERY_PARAM = "settings";
export const SETTINGS_SECTION_QUERY_PARAM = "settingsSection";

/**
 * Entries that own a detail page. Each stays a separate feature — separate
 * row, separate page, separate state — and each names the tab it lives in
 * below rather than assuming they share one.
 */
export const SETTINGS_SECTION_IDS = [
    "external-import",
    "memory",
    "assistants",
    "account-data",
    "email-notifications",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export const SETTINGS_SECTION_TAB: Record<SettingsSectionId, AccountSettingsTab> =
    {
        // Import moves conversations *into* the account: it is a data
        // operation, and it stays beside export and deletion.
        "external-import": "data",
        // Memory and profiles both shape what a model is told, so they sit in
        // the tab named after that rather than in the one named after data.
        // They were in "data" while it was the only tab with detail rows;
        // that made "Data & personalization" a group whose second half had no
        // relationship to its first.
        memory: "ai",
            // Its own tab, which is also its management home. A deep link minted
        // while this section lived in "ai" still resolves, because the section
        // decides the tab and `parseSettingsDeepLink` reads that -- so an old
        // bookmark opens the assistants tab rather than a tab the row left.
        assistants: "assistants",
        "account-data": "data",
        // What the account receives by email is personalisation it owns, in
        // the same sense the other four are: a separate feature with its own
        // page and its own state, presented as another row in this group
        // rather than merged into one of them (settings-navigation contract
        // docs/policy/email-notifications.md §2). Last because it is the only
        // one that is about outbound mail
        // rather than about data the account already holds.
        "email-notifications": "data",
    };

/**
 * The tab's own name, for a detail page's breadcrumb.
 *
 * Keyed by tab rather than by section so the trail cannot disagree with where
 * the back link actually goes: both read `SETTINGS_SECTION_TAB`. The previous
 * breadcrumb hard-coded one group name, which was correct while every section
 * lived in one tab and silently wrong the moment one did not.
 */
export const SETTINGS_TAB_LABEL_KEY: Record<AccountSettingsTab, string> = {
    account: "auth.accountTab",
    preferences: "auth.preferencesTab",
    // Deliberately not `auth.aiTab`. The tab and the breadcrumb crumb are the
    // same name for the same place, so they read one key -- two keys is how
    // "AI settings" and "AI personalization" ended up on screen at once, one
    // in the tab strip and one in the trail below it.
    assistants: "settingsNav.assistantsTab",
    ai: "settingsNav.aiPersonalization",
    data: "auth.dataTab",
    plan: "auth.planTab",
};

/** The category a detail page sits under, as its breadcrumb should say it. */
export const settingsSectionGroupLabelKey = (section: SettingsSectionId) =>
    SETTINGS_TAB_LABEL_KEY[SETTINGS_SECTION_TAB[section]];

export const isSettingsSectionId = (
    value: unknown
): value is SettingsSectionId =>
    typeof value === "string" &&
    (SETTINGS_SECTION_IDS as readonly string[]).includes(value);

/** DOM id of the settings list row, i.e. the scroll and focus target. */
export const settingsSectionElementId = (section: SettingsSectionId) =>
    `settings-entry-${section}`;

export const settingsSectionHref = (section: SettingsSectionId) => {
    const params = new URLSearchParams();
    params.set(SETTINGS_TAB_QUERY_PARAM, SETTINGS_SECTION_TAB[section]);
    params.set(SETTINGS_SECTION_QUERY_PARAM, section);
    return `${SETTINGS_HOME_PATH}?${params.toString()}`;
};

/* ------------------------------------------------ nested detail pages ---- */

/**
 * One step in a settings page's ancestry.
 *
 * A settings *entry* page (imports, memory, the profile list) has one ancestor:
 * the settings panel. A page nested below one of those -- a single assistant
 * profile -- has two, and the difference is what this exists for. The profile
 * editor previously rendered the entry-page nav, so its back link went to the
 * settings panel while the list it actually sat inside was skipped, and the
 * trail underneath claimed a hierarchy the link did not follow.
 *
 * `href` is a literal or built from a literal. Nothing here ever comes from a
 * query string, so no ancestor can be pointed anywhere by a caller.
 */
export type SettingsAncestor = {
    /**
     * Where this crumb goes, when it goes anywhere.
     *
     * Absent for a step that names a place without being a separate
     * destination — the settings tab is one, since the panel opens *at* that
     * tab and the crumb before it already links there. A crumb that looked
     * like a link and led to the page you were already on would be a control
     * people try once.
     */
    href?: string;
    /** Locale key for the breadcrumb crumb: this ancestor's own name. */
    labelKey: string;
    /**
     * Locale key for the back link, when this is the nearest navigable
     * ancestor.
     *
     * A whole sentence rather than a name interpolated into "Back to {x}",
     * because the join is grammar: Korean's particle changes with the noun it
     * follows, and every locale has some version of that. One key per
     * destination costs a line and leaves the sentence to the translator.
     */
    backLabelKey?: string;
};

/**
 * The back link's target: the nearest ancestor that is actually somewhere.
 *
 * Not simply the last entry, because the last entry may be a naming step. For
 * a settings entry page that makes the back link the panel; for a profile it
 * makes it the list.
 */
export const settingsBackTarget = (
    hierarchy: SettingsHierarchy
): SettingsAncestor | null => {
    for (let index = hierarchy.length - 1; index >= 0; index -= 1) {
        const ancestor = hierarchy[index];
        if (ancestor.href && ancestor.backLabelKey) return ancestor;
    }
    return null;
};

/**
 * The ancestry of a page, nearest parent last.
 *
 * The back link is the last entry and the breadcrumb is the whole list, so
 * they cannot disagree: there is one array and two readings of it.
 */
export type SettingsHierarchy = readonly SettingsAncestor[];

/** The assistant profile list, as its own children should address it. */
export const ASSISTANT_PROFILE_LIST_PATH = "/settings/assistants";

/**
 * A settings entry page: settings panel -> this page.
 *
 * `settingsSectionHref` already encodes which tab the row lives in, so the
 * crumb's name comes from the same mapping the link does.
 */
export const settingsEntryHierarchy = (
    section: SettingsSectionId
): SettingsHierarchy => [
    {
        href: settingsSectionHref(section),
        labelKey: "settingsNav.settings",
        backLabelKey: "settingsNav.backToSettings",
    },
    // The tab this row lives in. It names the place without being a second
    // one: the deep link above already opens the panel *at* this tab.
    { labelKey: settingsSectionGroupLabelKey(section) },
];

/**
 * An assistant profile: settings panel -> AI personalization -> profile list.
 *
 * Three ancestors rather than the entry page's one, and the nearest is the
 * list. That is the whole correction: a profile belongs to a list, and the
 * list belongs to a settings tab.
 */
/**
 * The list's href, optionally asking it to restore a row.
 *
 * The id is placed in a query parameter and the list looks it up *against its
 * own loaded profiles* — it is never interpolated into a selector, and an id
 * naming nothing simply restores nothing. That is the whole handling: the
 * parameter is a hint about which of the list's own rows to focus, so the
 * worst a crafted value can do is fail to match.
 */
export const ASSISTANT_PROFILE_FOCUS_PARAM = "focus";

export const assistantProfileListHref = (focusProfileId?: string) =>
    focusProfileId
        ? `${ASSISTANT_PROFILE_LIST_PATH}?${ASSISTANT_PROFILE_FOCUS_PARAM}=${encodeURIComponent(focusProfileId)}`
        : ASSISTANT_PROFILE_LIST_PATH;

export const assistantProfileHierarchy = (options?: {
    /** Focused on return, when the visitor came from that profile. */
    focusProfileId?: string;
}): SettingsHierarchy => [
    {
        href: settingsSectionHref("assistants"),
        labelKey: "settingsNav.settings",
        backLabelKey: "settingsNav.backToSettings",
    },
    { labelKey: SETTINGS_TAB_LABEL_KEY.assistants },
    {
        href: assistantProfileListHref(options?.focusProfileId),
        labelKey: "assistantProfiles.pageTitle",
        backLabelKey: "assistantProfiles.backToList",
    },
];

export type SettingsDeepLink = {
    tab: AccountSettingsTab;
    section: SettingsSectionId | null;
};

const toSearchParams = (search: string) =>
    new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

/**
 * `null` for anything that is not a settings deep link, so an unrelated query
 * string never opens the panel. The tab parameter is the trigger; an unknown
 * or absent section only means "no row to restore".
 */
export const parseSettingsDeepLink = (
    search: string
): SettingsDeepLink | null => {
    const params = toSearchParams(search);
    const tab = params.get(SETTINGS_TAB_QUERY_PARAM);
    if (!isAccountSettingsTab(tab)) return null;
    const section = params.get(SETTINGS_SECTION_QUERY_PARAM);
    if (!isSettingsSectionId(section)) return { tab, section: null };
    // The section decides the tab: a hand-edited pair that disagrees would
    // otherwise open a tab the row is not in, leaving nothing to restore.
    return { tab: SETTINGS_SECTION_TAB[section], section };
};

/**
 * The same query string without the deep-link parameters, ready for
 * `history.replaceState`. Replacing rather than pushing is deliberate: the
 * panel is open, the address bar should stop advertising a request that was
 * already served, and the visitor's Back button must still go where it went
 * before — one entry, rewritten, not a new one.
 */
export const stripSettingsDeepLink = (search: string) => {
    const params = toSearchParams(search);
    params.delete(SETTINGS_TAB_QUERY_PARAM);
    params.delete(SETTINGS_SECTION_QUERY_PARAM);
    const rest = params.toString();
    return rest ? `?${rest}` : "";
};
