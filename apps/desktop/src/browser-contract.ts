import { z } from "zod";
import { isIpAddress, isPrivateNetworkAddress } from "./internal-address";
import { linkViewUrl, publicHostname } from "./web-view-contract";

const bounds = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(),
  width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();

const tab = z.uuid();
export const MAX_CODE_BROWSER_TABS = 4;
export const browserCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), tab, url: z.string().trim().min(1).max(2048) }).strict(),
  z.object({ type: z.literal("layout"), tab, bounds: bounds.nullable() }).strict(),
  z.object({ type: z.enum(["back", "forward", "reload", "stop", "focus", "close-tab", "share", "unshare"]), tab }).strict(),
  // The person's button: the page's own DevTools in a window of its own. The agent's tools use the debugger session, not this.
  z.object({ type: z.literal("devtools"), tab }).strict(),
  // The person clears the saved data (cookies, storage, cache, remembered permissions) of the project profile the tab belongs to.
  z.object({ type: z.literal("clear-data"), tab: tab.optional() }).strict(),
  z.object({ type: z.literal("close") }).strict(),
  // The panel asks for the state of every tab it was not mounted to hear about (the agent opens tabs while the panel is closed).
  z.object({ type: z.literal("sync") }).strict(),
  // The person points at an element of the page; the host answers with one picked element and ends the mode.
  z.object({ type: z.literal("pick"), tab, enabled: z.boolean() }).strict(),
  // The person takes the tab away from the agent, or hands it back.
  z.object({ type: z.enum(["agent-stop", "agent-resume"]), tab }).strict(),
  // The person's switch for the agent's browser tools (off by default). The panel itself does not depend on it.
  z.object({ type: z.literal("agent-tools"), enabled: z.boolean() }).strict(),
  // The person's second switch: the agent may open public https sites too (off by default; it needs the switch above).
  z.object({ type: z.literal("agent-web"), enabled: z.boolean() }).strict(),
]);
export type BrowserCommand = z.infer<typeof browserCommand>;
/** agent: the tab belongs to the agent of the running task; working while one of its requests runs, stopped once the person took it back. */
/**
 * local: a loopback development server, pinned to its origin. web: a public https site, checked on every request. private: an address
 * the person typed on their own computer or network (http or https: a LAN address, a `.local`, `.test` or `.internal` name, or a name
 * their DNS answers privately), pinned to the origin it was opened with. Only a person opens a private tab; the agent never does.
 */
export type BrowserKind = "local" | "web" | "private";
export type BrowserDownload = { name: string; state: "progressing" | "completed" | "cancelled" | "interrupted"; received: number; total: number };
export type BrowserState = { tab: string; kind?: BrowserKind; url: string; loading: boolean; failed: boolean; back: boolean; forward: boolean;
  agent?: "idle" | "working" | "stopped"; picking?: boolean;
  /** The page is one of Tomverse's own origins: the panel says the Tomverse account is not signed in here. */
  tomverse?: boolean;
  /** A page (a link or window.open) opened this tab: the panel adopts it, once. It is the id of the tab that opened it. */
  opener?: string;
  /** The latest download of this tab; the system's save dialog asked where to put it. */
  download?: BrowserDownload;
  /** The main process closed this tab (the agent's permission or task ended): the panel drops it. */
  closed?: boolean };

/** One element the person pointed at: what the page said it is, where it was, and a small picture for the panel. */
export const elementPickId = /^pick-[0-9a-f]{8}$/;
export type ElementPick = {
  id: string; tab: string; url: string; selector: string; tag: string; text: string;
  box: { x: number; y: number; width: number; height: number };
  /** A data URL for the panel only; the full picture goes with the instruction (attachedPickIds) or is read through browser_screenshot with this id. */
  thumbnail?: string;
  /** No picture was taken: the element is, or covers, a secret field (a password, a card number, a one-time code), or it has no visible area. */
  withheld?: "secret" | "empty";
};

const LOOPBACK_WITH_PORT = /^(localhost|127\.0\.0\.1|\[::1\]):\d+(?:[/?#].*)?$/i;
const NON_WEB_SCHEME = /^(javascript|data|file|blob|about|mailto|ftp|view-source|chrome|devtools|ws|wss):/i;
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const hostKey = (target: URL) => target.hostname.toLowerCase().replace(/\.$/, "");
const addressLiteral = (host: string) => host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

/**
 * An address a person typed that is on their own computer or network, or null. This reads the text only: a name that is not an address
 * literal still has to answer privately (admitTypedAddress in host/code-browser-policy.ts). A loopback name needs a port. An address
 * literal must be loopback, private, link-local or CGNAT: the unspecified, multicast and public ones are refused.
 */
export function privateNetworkUrl(value: string): URL | null {
  let target: URL;
  try { target = new URL(value); } catch { return null; }
  if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password) return null;
  const host = hostKey(target);
  if (!host) return null;
  if (LOOPBACK_NAMES.has(host)) return target.port ? target : null;
  const literal = addressLiteral(host);
  if (isIpAddress(literal)) return isPrivateNetworkAddress(literal) ? target : null;
  // An https name that looks public is a web page (classifyBrowserAddress takes it first); every other name is a candidate.
  return target.protocol === "https:" && publicHostname(host) ? null : target;
}

/**
 * What the person typed in the address box. A loopback address with a port is a local page (http), a public https address is a web
 * page, and an address on their own network (a LAN address or a private name, http or https) is a private page that stays on its
 * origin. Anything else (another scheme, credentials, a public IP address, a loopback address with no port) is null. A box with no
 * scheme gets http for a loopback address with a port and for a private-looking name or address, and https for the rest.
 */
export function classifyBrowserAddress(input: string): { kind: BrowserKind; url: URL } | null {
  const text = input.trim();
  if (!text || text.length > 2048 || /[\u0000-\u001f\u007f-\u009f\s]/.test(text) || NON_WEB_SCHEME.test(text)) return null;
  let full = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let guess: URL | null = null;
    try { guess = new URL("http://" + text); } catch { guess = null; }
    const host = guess ? hostKey(guess) : "";
    const literal = addressLiteral(host);
    const privateLooking = LOOPBACK_WITH_PORT.test(text) || (isIpAddress(literal) ? isPrivateNetworkAddress(literal) : !!host && !publicHostname(host));
    full = (privateLooking ? "http://" : "https://") + text;
  }
  const local = loopbackBrowserUrl(full);
  if (local) return { kind: "local", url: local };
  const web = linkViewUrl(full);
  if (web) return { kind: "web", url: web };
  const priv = privateNetworkUrl(full);
  return priv ? { kind: "private", url: priv } : null;
}

/**
 * Whether a request or a navigation of a pinned tab (local or private) stays on the origin the tab was opened with: the same host and
 * port, over the scheme of the origin or its WebSocket twin (a development server's hot reload), without credentials.
 */
export function pinnedOriginUrl(value: string, origin: string): URL | null {
  try {
    const target = new URL(value);
    const pinned = new URL(origin);
    const twin = pinned.protocol === "https:" ? "wss:" : "ws:";
    if (target.username || target.password || target.host !== pinned.host) return null;
    return target.protocol === pinned.protocol || target.protocol === twin ? target : null;
  } catch {
    return null;
  }
}

/** A main-frame address of a pinned tab (local or private): the origin of the tab, over its own scheme (never the WebSocket twin). */
export function pinnedNavigationUrl(value: string, origin: string): URL | null {
  const target = pinnedOriginUrl(value, origin);
  return target && target.protocol === new URL(origin).protocol ? target : null;
}

/** The comparison key of a site the agent was given: the lower-case name without a trailing dot. */
export function webHostKey(target: URL): string {
  return target.hostname.toLowerCase().replace(/\.$/, "");
}

/** The only external addresses the agent may open: a public https site on the standard port, without the fragment (it is never sent). */
export function agentWebUrl(value: string): URL | null {
  const text = value.trim();
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(text)) return null;
  const target = linkViewUrl(text);
  if (!target || (target.port && target.port !== "443")) return null;
  target.hash = "";
  return target;
}

/** Whether an address is a page the agent may be on: a public https page on the standard port of a site it was given. */
export function onApprovedSite(hosts: ReadonlySet<string>, address: string): boolean {
  const target = agentWebUrl(address);
  return target !== null && hosts.has(webHostKey(target));
}

export function loopbackBrowserUrl(value: string, origin?: string): URL | null {
  try {
    const target = new URL(value);
    const loopback = target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "[::1]";
    return target.protocol === "http:" && loopback && target.port && !target.username && !target.password &&
      (!origin || target.origin === origin) ? target : null;
  } catch {
    return null;
  }
}
