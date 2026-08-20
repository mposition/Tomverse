export const ACCOUNT_SETTINGS_OPEN_EVENT = "tomverse:account-settings-open";

export const ACCOUNT_SETTINGS_TABS = [
  "account",
  "preferences",
  // Everything that shapes what the models do: which ones a new conversation
  // starts with, the profiles that carry instructions, and the account's
  // long-term memory. These used to be split between "preferences" (a tab
  // about theme, language and time zone) and "data" (a tab about import,
  // export and deletion), which put the three decisions a user makes about
  // their assistants in two places, neither of which is named after them.
  "ai",
  "data",
  "plan",
] as const;

export type AccountSettingsTab = (typeof ACCOUNT_SETTINGS_TABS)[number];

export const isAccountSettingsTab = (
  value: unknown
): value is AccountSettingsTab =>
  typeof value === "string" &&
  (ACCOUNT_SETTINGS_TABS as readonly string[]).includes(value);

export type AccountSettingsOpenRequest = {
  tab: AccountSettingsTab;
  /**
   * Entry inside the tab to scroll to and focus once it renders, when the
   * request came from one (see lib/settingsNavigation.ts). `null` opens the
   * tab without moving focus past the dialog's own initial focus.
   */
  section: string | null;
};

/**
 * The settings modal lives inside AuthButton, which only mounts with the
 * *expanded* sidebar: not in the collapsed desktop rail, and on mobile not
 * until the drawer has been opened once. So the event alone is lost exactly
 * when the request is what causes the host to mount. The last request is kept
 * here as well, and the modal claims it on mount — the event stays the fast
 * path for an already-mounted modal, this is the handoff for the rest.
 *
 * Whoever acts on the request clears it, so a later mount never replays a
 * request that was already served.
 */
let pendingRequest: AccountSettingsOpenRequest | null = null;

export const openAccountSettings = (
  tab: AccountSettingsTab = "account",
  section: string | null = null
) => {
  if (typeof window === "undefined") return;
  pendingRequest = { tab, section };
  window.dispatchEvent(
    new CustomEvent<AccountSettingsOpenRequest>(ACCOUNT_SETTINGS_OPEN_EVENT, {
      detail: { tab, section },
    })
  );
};

export const consumePendingAccountSettingsRequest =
  (): AccountSettingsOpenRequest | null => {
    const request = pendingRequest;
    pendingRequest = null;
    return request;
  };

/**
 * Reads either shape off the event: the object this module dispatches, or a
 * bare tab string, which is what external callers (tests, older code) send.
 */
export const readAccountSettingsOpenRequest = (
  detail: unknown
): AccountSettingsOpenRequest => {
  if (isAccountSettingsTab(detail)) return { tab: detail, section: null };
  if (detail && typeof detail === "object") {
    const candidate = detail as { tab?: unknown; section?: unknown };
    if (isAccountSettingsTab(candidate.tab)) {
      return {
        tab: candidate.tab,
        section:
          typeof candidate.section === "string" ? candidate.section : null,
      };
    }
  }
  return { tab: "account", section: null };
};
