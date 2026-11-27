import { createHash } from "node:crypto";
import { join } from "node:path";
import { pinnedNavigationUrl, type BrowserKind } from "../browser-contract";
import { isInternalAddress, isIpAddress, isPrivateNetworkAddress } from "../internal-address";
import { linkViewUrl } from "../web-view-contract";

/**
 * The decisions of the development preview browser that need no Electron, so they can be tested: which profile a tab belongs to,
 * which address a person may open, which site permission is asked about, where a download goes and what a page's new window becomes.
 * The host (code-browser-profile.ts, code-browser-view.ts, main.ts) only carries them out.
 */

// ---- Profile -------------------------------------------------------------------------------------------------------------------

/**
 * The saved browser data of one project of one account. The key is a hash of the account id and of the project folder, so another
 * account, another project, the Tomverse account session of the window and the link viewers never share a cookie or a storage. A
 * browser opened with no project (Chat) has the project part `none`, and one opened with no one signed in the account part of the
 * device. The data stays on this computer.
 */
export function browserProfile(accountId: string | null, projectPath: string | null) {
  const digest = (label: string, value: string) => createHash("sha256").update(label + "\0" + value).digest("hex").slice(0, 16);
  const folder = projectPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() || null;
  const id = digest("account", accountId ?? "device") + "-" + (folder ? digest("project", folder) : "none");
  return { id, partition: "persist:tomverse-code-browser-" + id };
}

// ---- Addresses -----------------------------------------------------------------------------------------------------------------

export type ResolveHost = (host: string) => Promise<{ endpoints: readonly { address: string }[] }>;
type Typed = { kind: BrowserKind; url: URL };

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * What a person-typed address becomes once its name has been looked up, or null when it is refused. A private address and a name that
 * answers only private addresses (a home or office DNS, a `.local` or `.test` name) is a private tab; a name that looks public but
 * answers only private addresses is one too (the person typed it, so the tab is pinned to it and the page is never public). A name
 * that answers a mix of public and private addresses is refused, and so is a private-looking name, or a plain http name, that answers
 * a public address: plain http to the internet is not something this browser opens. A public https name that cannot be resolved is
 * left as a web page, whose requests the address gate refuses. The agent never goes through this: it never opens a private tab.
 */
export async function admitTypedAddress(address: Typed, resolve: ResolveHost): Promise<Typed | null> {
  if (address.kind === "local") return address;
  const host = address.url.hostname.toLowerCase().replace(/\.$/, "");
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIpAddress(literal)) return address.kind === "private" && isPrivateNetworkAddress(literal) ? address : null;
  if (LOOPBACK_NAMES.has(host)) return address.kind === "private" ? address : null;
  let answers: string[] | null;
  try {
    const resolved = await resolve(literal);
    answers = Array.isArray(resolved?.endpoints) ? resolved.endpoints.map((endpoint) => String(endpoint.address)) : null;
  } catch { answers = null; }
  if (address.kind === "private") return answers?.length && answers.every(isPrivateNetworkAddress) ? address : null;
  if (!answers?.length || !answers.some(isInternalAddress)) return address;
  return answers.every(isPrivateNetworkAddress) ? { kind: "private", url: address.url } : null;
}

/** The address a page's new tab or window may open: its opener's own rules (pinned to the origin, or a public https page). */
export function popupAddressAllowed(opener: { kind: BrowserKind; origin: string }, address: string): boolean {
  return opener.kind === "web" ? linkViewUrl(address) !== null : pinnedNavigationUrl(address, opener.origin) !== null;
}

/**
 * What a page's `window.open` or `target=_blank` becomes. A call that names window features and does not cut the link to its opener
 * (a sign-in popup that answers through `window.opener` and `postMessage`) is a real child window, which keeps the opener; every other
 * one is a tab of the panel. The agent keeps the one tab it works in, so its tab never gets a second window.
 */
export function popupMode(details: { disposition: string; features: string }, agentHolds: boolean): "window" | "tab" | "same-tab" {
  if (agentHolds) return "same-tab";
  const features = details.features.toLowerCase();
  return details.disposition === "new-window" && features.trim() !== "" && !/\bnoopener\b/.test(features) ? "window" : "tab";
}

// ---- Permissions ---------------------------------------------------------------------------------------------------------------

/** Asked of the person in a system dialog (never while the agent holds the tab). */
export const PERMISSIONS_ASKED = ["geolocation", "media", "notifications", "clipboard-read", "midi"] as const;
/** Granted without asking: copying text out of the page that the person asked for. */
export const PERMISSIONS_ALLOWED = ["clipboard-sanitized-write"] as const;
/**
 * Refused whatever a page asks and whatever was remembered: sharing the screen, devices (USB, serial, HID, Bluetooth), MIDI that can
 * send system-exclusive data, opening other programs, the file system, window and fullscreen control, keyboard and pointer locks,
 * idle detection, protected media, speaker selection, third-party storage access, and every permission this list does not know.
 */
export const PERMISSIONS_REFUSED = [
  "display-capture", "usb", "serial", "hid", "bluetooth", "midiSysex", "openExternal", "fileSystem", "window-management", "fullscreen",
  "pointerLock", "keyboardLock", "idle-detection", "mediaKeySystem", "speaker-selection", "storage-access", "top-level-storage-access", "unknown",
] as const;

export type PermissionVerdict = "ask" | "allow" | "refuse";
export function permissionVerdict(permission: string): PermissionVerdict {
  if ((PERMISSIONS_REFUSED as readonly string[]).includes(permission)) return "refuse";
  if ((PERMISSIONS_ASKED as readonly string[]).includes(permission)) return "ask";
  return (PERMISSIONS_ALLOWED as readonly string[]).includes(permission) ? "allow" : "refuse";
}

export type StoredDecision = "allow" | "deny";
export type PermissionMemory = ReturnType<typeof createPermissionMemory>;
export const MAX_REMEMBERED_PERMISSIONS = 200;

/** The decisions the person asked to remember, for the profile they were made in. Anything unreadable is forgotten. */
export function createPermissionMemory(store: { read(): string | null; write(text: string): void; remove(): void }) {
  const entries = new Map<string, StoredDecision>();
  try {
    const parsed: unknown = JSON.parse(store.read() ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if ((value === "allow" || value === "deny") && key.length <= 600) entries.set(key, value);
      }
    }
  } catch { entries.clear(); }
  while (entries.size > MAX_REMEMBERED_PERMISSIONS) entries.delete(entries.keys().next().value!);
  const save = () => { try { store.write(JSON.stringify(Object.fromEntries(entries))); } catch { /* The decision still holds for this run. */ } };
  return {
    get: (key: string) => entries.get(key),
    set(key: string, value: StoredDecision) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > MAX_REMEMBERED_PERMISSIONS) entries.delete(entries.keys().next().value!);
      save();
    },
    clear() { entries.clear(); try { store.remove(); } catch { /* Nothing was stored. */ } },
    size: () => entries.size,
  };
}

export const permissionKey = (origin: string, permission: string, detail?: string) => origin + "|" + permission + (detail ? ":" + detail : "");

export type PermissionRequest = {
  permission: string;
  /** The origin of the page that asked (never an iframe's own). */
  origin: string;
  /** For `media`: what was asked. Nothing named means camera and microphone both. */
  mediaTypes?: readonly string[];
  mainFrame: boolean;
  /** The agent holds the tab the page is in. */
  agentHolds: boolean;
};

const keysOf = (request: PermissionRequest): string[] => {
  if (request.permission !== "media") return [permissionKey(request.origin, request.permission)];
  const types = (request.mediaTypes ?? []).filter((type) => type === "audio" || type === "video");
  return (types.length ? types : ["audio", "video"]).map((type) => permissionKey(request.origin, "media", type));
};

const webOrigin = (origin: string) => /^https?:\/\/[^/]+$/i.test(origin);

/**
 * A permission request, answered. The agent's tab never asks and never uses what was remembered; a refused permission is never asked;
 * a remembered answer is used without asking, a denial before an allowance; anything else asks the person, once, and remembers the
 * answer for this project when they said so.
 */
export async function decidePermission(request: PermissionRequest, deps: {
  memory: PermissionMemory;
  ask(question: { origin: string; permission: string; mediaTypes: readonly string[] }): Promise<{ allow: boolean; remember: boolean }>;
}): Promise<boolean> {
  const verdict = permissionVerdict(request.permission);
  if (!request.mainFrame || request.agentHolds || verdict === "refuse") return false;
  if (verdict === "allow") return true;
  if (!webOrigin(request.origin)) return false;
  const keys = keysOf(request);
  const stored = keys.map((key) => deps.memory.get(key));
  if (stored.includes("deny")) return false;
  if (stored.every((value) => value === "allow")) return true;
  const mediaTypes = request.permission === "media" ? keys.map((key) => key.slice(key.lastIndexOf(":") + 1)) : [];
  const answer = await deps.ask({ origin: request.origin, permission: request.permission, mediaTypes });
  if (answer.remember) for (const key of keys) deps.memory.set(key, answer.allow ? "allow" : "deny");
  return answer.allow;
}

/** The synchronous check a page's own query gets (`navigator.permissions.query`, `Notification.permission`): only what was allowed before. */
export function checkPermission(request: PermissionRequest, memory: PermissionMemory): boolean {
  const verdict = permissionVerdict(request.permission);
  if (!request.mainFrame || request.agentHolds || verdict === "refuse") return false;
  if (verdict === "allow") return true;
  return webOrigin(request.origin) && keysOf(request).every((key) => memory.get(key) === "allow");
}

// ---- Downloads -----------------------------------------------------------------------------------------------------------------

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A file name that is only a name: no folder, no control or Windows-reserved characters, no reserved device name, no trailing dot. */
export function safeDownloadName(raw: string): string {
  let name = raw.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/[. ]+$/, "").replace(/^\.+/, "");
  if (name.length > 150) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, 150 - extension.length) + extension;
  }
  if (!name || RESERVED_NAMES.test(name)) name = "download" + (name && RESERVED_NAMES.test(name) ? "-" + name : "");
  return name;
}

/**
 * Where a download goes. The system's save dialog asks the person, starting in their download folder with a safe name. Nothing is
 * opened or run afterwards, whatever the file is. A download from the agent's tab asks the same way (the dialog is the person's
 * answer; nothing saves without it) and says whose tab it came from. A test fixture may name a folder instead of the dialog.
 */
export function downloadPlan(input: { filename: string; downloads: string; agentHolds: boolean; testDirectory?: string | null }) {
  const name = safeDownloadName(input.filename);
  return {
    name,
    defaultPath: join(input.downloads, name),
    savePath: input.testDirectory ? join(input.testDirectory, name) : null,
    from: input.agentHolds ? "agent" as const : "person" as const,
  };
}
