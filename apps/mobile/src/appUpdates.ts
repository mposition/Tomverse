import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface AppUpdateState {
  state: "none" | "available" | "downloading" | "downloaded";
  versionCode: number;
}
export interface AppUpdates {
  check(): Promise<AppUpdateState>;
  start(): Promise<{ accepted: boolean }>;
  complete(): Promise<void>;
  addListener(event: "stateChanged", listener: (state: AppUpdateState) => void): Promise<PluginListenerHandle>;
}
export const nativeAppUpdates = Capacitor.getPlatform() === "android" ? registerPlugin<AppUpdates>("MobileUpdates") : null;
const DISMISSED = "tomverse-update-later";
export function updateWasDismissed(version: number) {
  try {
    const record = JSON.parse(localStorage.getItem(DISMISSED) ?? "null");
    return record?.version === version && typeof record.at === "number" && Date.now() - record.at < 86_400_000;
  } catch { return false; }
}
export function dismissAppUpdate(version: number) {
  try { localStorage.setItem(DISMISSED, JSON.stringify({ version, at: Date.now() })); } catch { /* In-memory dismissal still applies. */ }
}
