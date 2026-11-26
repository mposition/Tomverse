import { z } from "zod";
import { linkViewUrl } from "./web-view-contract";

const bounds = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(),
  width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();

const tab = z.uuid();
export const MAX_CODE_BROWSER_TABS = 4;
export const browserCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), tab, url: z.string().trim().min(1).max(2048) }).strict(),
  z.object({ type: z.literal("layout"), tab, bounds: bounds.nullable() }).strict(),
  z.object({ type: z.enum(["back", "forward", "reload", "stop", "focus", "close-tab", "share", "unshare"]), tab }).strict(),
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
/** local: a loopback development server, pinned to its origin. web: a public https site, checked on every request. */
export type BrowserKind = "local" | "web";
export type BrowserState = { tab: string; kind?: BrowserKind; url: string; loading: boolean; failed: boolean; back: boolean; forward: boolean;
  agent?: "idle" | "working" | "stopped"; picking?: boolean };

/** One element the person pointed at: what the page said it is, where it was, and a small picture for the panel. */
export const elementPickId = /^pick-[0-9a-f]{8}$/;
export type ElementPick = {
  id: string; tab: string; url: string; selector: string; tag: string; text: string;
  box: { x: number; y: number; width: number; height: number };
  /** A data URL for the panel only; the agent reads the full picture through browser_screenshot with this id. */
  thumbnail?: string;
};

const LOOPBACK_WITH_PORT = /^(localhost|127\.0\.0\.1|\[::1\]):\d+(?:[/?#].*)?$/i;
const NON_WEB_SCHEME = /^(javascript|data|file|blob|about|mailto|ftp|view-source|chrome|devtools|ws|wss):/i;

/**
 * What the person typed in the address box. A loopback address with a port is a local page (http), a public https
 * address is a web page; anything else (another scheme, http on a public name, credentials, private or single-label
 * names, IP literals) is null. A box with no scheme gets http for a loopback address and https for the rest.
 */
export function classifyBrowserAddress(input: string): { kind: BrowserKind; url: URL } | null {
  const text = input.trim();
  if (!text || text.length > 2048 || /[\u0000-\u001f\u007f-\u009f\s]/.test(text) || NON_WEB_SCHEME.test(text)) return null;
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : (LOOPBACK_WITH_PORT.test(text) ? "http://" : "https://") + text;
  const local = loopbackBrowserUrl(full);
  if (local) return { kind: "local", url: local };
  const web = linkViewUrl(full);
  return web ? { kind: "web", url: web } : null;
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
