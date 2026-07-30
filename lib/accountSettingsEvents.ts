export const ACCOUNT_SETTINGS_OPEN_EVENT = "tomverse:account-settings-open";

export type AccountSettingsTab = "account" | "preferences" | "data" | "plan";

export const openAccountSettings = (tab: AccountSettingsTab = "account") => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AccountSettingsTab>(ACCOUNT_SETTINGS_OPEN_EVENT, { detail: tab })
  );
};
