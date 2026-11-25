import { z } from "zod";

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
]);
export type BrowserCommand = z.infer<typeof browserCommand>;
/** agent: the tab belongs to the agent of the running task; working while one of its requests runs, stopped once the person took it back. */
export type BrowserState = { tab: string; url: string; loading: boolean; failed: boolean; back: boolean; forward: boolean;
  agent?: "idle" | "working" | "stopped"; picking?: boolean };

/** One element the person pointed at: what the page said it is, where it was, and a small picture for the panel. */
export const elementPickId = /^pick-[0-9a-f]{8}$/;
export type ElementPick = {
  id: string; tab: string; url: string; selector: string; tag: string; text: string;
  box: { x: number; y: number; width: number; height: number };
  /** A data URL for the panel only; the agent reads the full picture through browser_screenshot with this id. */
  thumbnail?: string;
};

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
