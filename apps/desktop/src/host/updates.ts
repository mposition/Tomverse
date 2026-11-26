import { app, autoUpdater, net } from "electron";
import type { UpdateState } from "../contract";
import { prepareMacUpdate } from "./mac-update";
import { prepareWindowsUpdate } from "./windows-update";

declare const DESKTOP_UPDATE_ORIGIN: string;
declare const DESKTOP_LOCAL_DEV_PACKAGE: boolean;
const CHECK_INTERVAL = 6 * 60 * 60_000;

export function configureUpdates(isBusy: () => boolean, publish: (state: UpdateState) => void) {
  let stage: UpdateState["stage"] = "unavailable";
  let feed: URL | undefined;
  let checking = false;
  let pendingUpdate: Awaited<ReturnType<typeof prepareMacUpdate>> = null;
  const windows = process.platform === "win32";
  const set = (next: UpdateState["stage"], detail?: UpdateState["detail"]) => {
    stage = next;
    publish({ stage: next, detail });
  };
  const releasePendingUpdate = () => {
    const previous = pendingUpdate;
    pendingUpdate = null;
    void previous?.remove();
  };
  const finishCheck = (next: UpdateState["stage"], detail?: UpdateState["detail"]) => {
    releasePendingUpdate();
    set(next, detail);
  };
  const check = async () => {
    if (!feed || checking || stage === "ready" || stage === "installing" || stage === "checking" || stage === "downloading") return;
    checking = true;
    set("checking");
    try {
      pendingUpdate = windows
        ? await prepareWindowsUpdate(net.fetch, feed, app.getVersion(), app.getPath("userData"), () => set("downloading"))
        : await prepareMacUpdate(net.fetch, feed, app.getVersion(), process.arch, app.getPath("temp"));
      if (!pendingUpdate) { set("idle", "updateCurrent"); return; }
      autoUpdater.setFeedURL(windows
        ? { url: pendingUpdate.url, allowAnyVersion: false }
        : { url: pendingUpdate.url, serverType: "json" });
      if (pendingUpdate) await autoUpdater.checkForUpdates();
    } catch {
      finishCheck("failed", "updateCheckFailure");
    } finally {
      checking = false;
    }
  };
  const install = () => {
    if (!feed || stage !== "ready" || isBusy()) return;
    set("installing", "updateInstalling");
    try {
      void Promise.resolve(autoUpdater.quitAndInstall()).catch(() => set("failed", "updateInstallFailure"));
    } catch {
      set("failed", "updateInstallFailure");
    }
  };
  if (DESKTOP_LOCAL_DEV_PACKAGE && windows && process.windowsStore) {
    set("unavailable", "updateWindowsInstaller");
    return { check, install };
  }
  if (!app.isPackaged || !DESKTOP_UPDATE_ORIGIN || process.platform === "linux") {
    set("unavailable", process.platform === "linux" ? "updateLinux" : "updateNoFeed");
    return { check, install };
  }

  // Electron selects its native MSIX updater for Windows packaged apps.
  if (windows && (!process.windowsStore || process.arch !== "x64")) {
    set("unavailable", "updateMSIX");
    return { check, install };
  }
  try {
    feed = new URL(`/desktop/updates/${process.platform}/${process.arch}/${app.getVersion()}`, DESKTOP_UPDATE_ORIGIN);
    set("idle");
  } catch {
    set("unavailable", "updateConfigFailure");
    return { check, install };
  }
  autoUpdater.on("update-available", () => set("downloading"));
  autoUpdater.on("update-not-available", () => finishCheck("idle", "updateCurrent"));
  autoUpdater.on("update-downloaded", () => finishCheck("ready"));
  autoUpdater.on("error", () => finishCheck("failed", "updateFailure"));
  const first = setTimeout(check, 30_000);
  const periodic = setInterval(check, CHECK_INTERVAL);
  app.once("will-quit", () => { clearTimeout(first); clearInterval(periodic); releasePendingUpdate(); });
  return { check, install };
}
