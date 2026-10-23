import type { MobileLanguage } from "./mobile";

const en = {
  sources: "Sources", download: "Save file", saving: "Saving…", downloadFailed: "The file could not be saved. Check your connection and try again.",
  fileFailed: "This file could not be created. Ask for it again.", signIn: "Sign in to create files.",
  offline: "You are offline. Your draft stays on this device until you reconnect.",
  account: "Account and data", export: "Export my data", delete: "Delete my account", confirmation: "Type DELETE MY ACCOUNT to confirm",
  deleteDetail: "Your account will be scheduled for deletion using the existing account deletion process. This signs you out on every device.",
  reauthenticate: "Sign in again before exporting data or deleting your account.", reauthenticateAction: "Sign in again", cancel: "Cancel",
  uncertain: "The result could not be confirmed. Sign in again and check your account before trying again.",
  exportSaved: "Your account data was saved.", deleting: "Scheduling deletion…", busy: "Working…",
  checkAccount: "Check account status", accountChecked: "Your account is active. Review your choice before trying again.",
  accountUnavailable: "Account export and deletion are not available in this app yet. Use account settings on the website.",
  restoreDraft: "Restore offline draft",
  logoutUnconfirmed: "Signed out on this device. Server sign-out could not be confirmed. Check your account on the website before trying again.",
};

// The existing app supports seven locales; new strings use its English fallback.
const copies: Partial<Record<MobileLanguage, typeof en>> = { en };
export const mobileCompletionCopy = (language: string) => copies[language as MobileLanguage] ?? en;
