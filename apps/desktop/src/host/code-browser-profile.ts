import { dialog, session, webContents, type BrowserWindow, type Session, type WebContents } from "electron";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../../tomverse-cli/src/runtime.js";
import type { desktopNativeCopy } from "../../../../locales/desktopNative";
import { checkPermission, createPermissionMemory, decidePermission, type PermissionRequest } from "./code-browser-policy";
import { createResolvedHostGate, type GatedRequest, type GateResponse } from "./resolved-host-gate";

type NativeCopy = (typeof desktopNativeCopy)["en"];

/**
 * The saved data of one project of one account: a persistent session of its own that every tab of that project shares (so a sign-in
 * to the project's own site survives closing a tab and restarting the app), and that nothing else shares: not another account, not
 * another project, not the window's Tomverse session, not the link viewers. Sites ask for camera, location and the like through the
 * person; a download asks the system's save dialog. The session has one listener for each of these, so each hands the request to the
 * tab (or popup window) it came from, which says whether the agent holds it.
 */

/** What a tab (or a popup window of it) lets the profile's session ask of it. */
export type TabPort = {
  /** The tab's own rule for a request of its page: cancelled unless it passes. */
  request(request: GatedRequest, callback: (response: GateResponse) => void): void;
  /** The agent holds the tab: nothing is asked of the person and nothing remembered is used. */
  agentHolds(): boolean;
  /** The window a question of the person is attached to; null when the tab is gone. */
  owner(): BrowserWindow | null;
  /** A download the page started. The port decides where it goes (and may refuse it). */
  download(item: Electron.DownloadItem): void;
};

export type ProfileDeps = {
  /** The folder the profile's decisions are kept in (inside the app's own data). */
  directory(): string;
  copy(): NativeCopy;
};

/** The longest a session cookie is kept once it is made to outlive the app, so a sign-in to a development site persists. */
const SESSION_COOKIE_DAYS = 30;

function createProfile(profile: { id: string; partition: string }, deps: ProfileDeps) {
  const browserSession: Session = session.fromPartition(profile.partition, { cache: false });
  const tabs = new Map<number, TabPort>();
  const gate = createResolvedHostGate((host) => browserSession.resolveHost(host));
  const file = () => join(deps.directory(), profile.id + ".json");
  const memory = createPermissionMemory({
    read: () => { try { return readFileSync(file(), "utf8"); } catch { return null; } },
    write: (text) => { mkdirSync(dirname(file()), { recursive: true }); writeFileAtomic(file(), text); },
    remove: () => rmSync(file(), { force: true }),
  });
  // One question at a time: a page that asks twice gets the answer of the first when the person said to remember it.
  let questions: Promise<unknown> = Promise.resolve();
  const inTurn = <Value>(work: () => Promise<Value>): Promise<Value> => {
    const next = questions.then(work, work);
    questions = next.catch(() => undefined);
    return next;
  };

  const originOf = (value: string) => { try { const origin = new URL(value).origin; return origin === "null" ? "" : origin; } catch { return ""; } };
  const lookup = (contents: WebContents | null) => (contents && !contents.isDestroyed() ? tabs.get(contents.id) : undefined);

  async function ask(port: TabPort, question: { origin: string; permission: string; mediaTypes: readonly string[] }) {
    const owner = port.owner();
    if (!owner || owner.isDestroyed()) return { allow: false, remember: false };
    const copy = deps.copy();
    const what = question.permission === "media"
      ? question.mediaTypes.length === 1 ? (question.mediaTypes[0] === "video" ? copy.browserPermissionCamera : copy.browserPermissionMicrophone) : copy.browserPermissionCameraMicrophone
      : ({ geolocation: copy.browserPermissionLocation, notifications: copy.browserPermissionNotifications,
        "clipboard-read": copy.browserPermissionClipboard, midi: copy.browserPermissionMidi } as Record<string, string>)[question.permission] ?? question.permission;
    const { response, checkboxChecked } = await dialog.showMessageBox(owner, {
      type: "question", title: copy.browserPermissionTitle,
      message: copy.browserPermissionPrompt.replace("{origin}", question.origin).replace("{permission}", what),
      detail: copy.browserPermissionDetail, buttons: [copy.browserPermissionDeny, copy.browserPermissionAllow], defaultId: 0, cancelId: 0,
      checkboxLabel: copy.browserPermissionRemember, checkboxChecked: false, noLink: true,
    });
    return { allow: response === 1, remember: checkboxChecked };
  }

  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const port = lookup(contents);
    if (!port) return callback(false);
    const request: PermissionRequest = {
      permission, origin: originOf(details.requestingUrl), mainFrame: details.isMainFrame === true, agentHolds: port.agentHolds(),
      mediaTypes: (details as { mediaTypes?: string[] }).mediaTypes,
    };
    inTurn(() => decidePermission({ ...request, agentHolds: port.agentHolds() }, { memory, ask: (question) => ask(port, question) }))
      // The agent may have taken the tab, or the tab may have closed, while the person was deciding.
      .then((allowed) => callback(allowed && !port.agentHolds() && tabs.get(contents!.id) === port), () => callback(false));
  });
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const port = lookup(contents);
    if (!port) return false;
    return checkPermission({ permission, origin: originOf(requestingOrigin), mainFrame: (details as { isMainFrame?: boolean }).isMainFrame === true,
      agentHolds: port.agentHolds(), mediaTypes: (details as { mediaType?: string }).mediaType ? [(details as { mediaType: string }).mediaType] : undefined }, memory);
  });
  // Devices (USB, serial, HID, Bluetooth) and screen sharing are never offered.
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.setDisplayMediaRequestHandler((_request, callback) => { try { callback({}); } catch { /* Refused all the same. */ } });

  browserSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, callback) => {
    const port = request.webContentsId === undefined ? undefined : tabs.get(request.webContentsId);
    if (!port) {
      // The DevTools window of one of this profile's tabs loads its own front end (devtools://); no other page without a tab is admitted.
      const frontEnd = request.webContentsId === undefined ? null : webContents.fromId(request.webContentsId);
      return callback({ cancel: !(request.url.startsWith("devtools://") && frontEnd && !frontEnd.isDestroyed() && frontEnd.getType() === "remote") });
    }
    port.request(request, callback);
  });
  browserSession.on("will-download", (event, item, contents) => {
    const port = lookup(contents);
    if (!port) { event.preventDefault(); return; }
    // A download that cannot be set up (no folder to offer) is cancelled, never saved somewhere unasked.
    try { port.download(item); } catch { item.cancel(); }
  });
  // A sign-in that the site meant for this visit only (a cookie with no expiry) would end with the app; the profile keeps it for a
  // while, as the person asked for a sign-in that lasts.
  browserSession.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed || !cookie.session) return;
    const host = (cookie.domain ?? "").replace(/^\./, "");
    if (!host) return;
    void browserSession.cookies.set({
      url: (cookie.secure ? "https://" : "http://") + host + cookie.path, name: cookie.name, value: cookie.value,
      ...(cookie.hostOnly ? {} : { domain: cookie.domain }), path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite, expirationDate: Date.now() / 1000 + SESSION_COOKIE_DAYS * 86_400,
    }).catch(() => {});
  });

  return {
    id: profile.id,
    session: browserSession,
    /** The address check of this profile's public tabs (the session's own lookup). */
    gate,
    resolveHost: (host: string) => browserSession.resolveHost(host),
    /** Hands the session's requests, permission questions and downloads of this page to its tab. Returns the detach. */
    attach(contents: WebContents, port: TabPort) {
      tabs.set(contents.id, port);
      const detach = () => { if (tabs.get(contents.id) === port) tabs.delete(contents.id); };
      contents.once("destroyed", detach);
      return detach;
    },
    /** Cookies and storage written so far reach the disk (they do on their own after a while, and when the app quits). */
    async flush() {
      await browserSession.cookies.flushStore().catch(() => {});
      browserSession.flushStorageData();
    },
    /** Everything the profile saved: cookies and storage of every site, the cache, sign-in answers and remembered permissions. */
    async clearData() {
      memory.clear();
      await browserSession.clearStorageData();
      await browserSession.clearCache();
      await browserSession.clearAuthCache();
      await browserSession.clearHostResolverCache();
      await browserSession.cookies.flushStore().catch(() => {});
    },
    /** For tests: what is remembered. */
    remembered: () => memory.size(),
  };
}

export type BrowserProfileSession = ReturnType<typeof createProfile>;
const profiles = new Map<string, BrowserProfileSession>();

/** The profile of a key (see browserProfile in code-browser-policy.ts): made once, with its handlers, and kept for the life of the app. */
export function openBrowserProfile(profile: { id: string; partition: string }, deps: ProfileDeps): BrowserProfileSession {
  let opened = profiles.get(profile.id);
  if (!opened) {
    opened = createProfile(profile, deps);
    profiles.set(profile.id, opened);
  }
  return opened;
}

/** The app is quitting: what every profile holds in memory reaches the disk. */
export function flushBrowserProfiles() {
  return Promise.all([...profiles.values()].map((opened) => opened.flush()));
}
