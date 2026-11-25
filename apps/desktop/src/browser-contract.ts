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
]);
export type BrowserCommand = z.infer<typeof browserCommand>;
export type BrowserState = { tab: string; url: string; loading: boolean; failed: boolean; back: boolean; forward: boolean };

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
