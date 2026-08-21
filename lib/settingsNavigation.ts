import {
    isAccountSettingsTab,
    type AccountSettingsTab,
} from "@/lib/accountSettingsEvents";

/**
 * Where a settings *detail page* goes when the user navigates back up.
 *
 * Settings is not a route: it is a closable panel (the modal inside
 * components/auth/AuthButton.tsx) that lives on the chat surface. Its detail
 * screens — /settings/imports, /settings/memory and /settings/data — are full
 * pages, so their
 * upward navigation has to name a destination rather than lean on
 * `router.back()`, which points at whatever the visitor happened to see last
 * and at nothing at all when the URL was opened directly.
 *
 * The destination is therefore the chat route plus a deep link that says which
 * settings tab to open and which entry inside it to restore, so "Back to
 * settings" lands on the settings list with the row the user came from
 * scrolled into view and focused. Going on to the chat itself stays the
 * panel's own close action — the detail pages never link to it directly.
 */
export const SETTINGS_HOME_PATH = "/chat";

export const SETTINGS_TAB_QUERY_PARAM = "settings";
export const SETTINGS_SECTION_QUERY_PARAM = "settingsSection";

/**
 * Entries that own a detail page. All sit under one group in the settings
 * list ("Data & personalization") but stay separate features: separate rows,
 * separate pages, separate state.
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
        "external-import": "data",
        memory: "data",
        // A profile is personalisation the account owns, so it belongs in the
        // same group rather than in a card beside it (settings-navigation
        // contract §2). Placed after memory because that is the order the
        // features build on each other -- a profile may use approved memory,
        // and never the other way round.
        assistants: "data",
        "account-data": "data",
        // What the account receives by email is personalisation it owns, in
        // the same sense the other four are: a separate feature with its own
        // page and its own state, presented as another row in this group
        // rather than merged into one of them (settings-navigation contract
        // §2). Last because it is the only one that is about outbound mail
        // rather than about data the account already holds.
        "email-notifications": "data",
    };

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
