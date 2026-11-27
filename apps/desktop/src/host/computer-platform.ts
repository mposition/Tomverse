import type { ComputerBackend } from "./computer-backend";
import { createWindowsBackend } from "./computer-backend-windows";
import { createX11Backend, x11Missing } from "./computer-backend-x11";

/**
 * Which operating systems can see and operate a window.
 *
 * Windows has the implementation that was run and checked. Linux on an X11 session has one built from the X11 command line tools
 * (computer-backend-x11.ts) that has only been run against a model of those tools in tests, never on a real X server; code that
 * was never run is not left switched on, so it starts only when `TOMVERSE_DESKTOP_COMPUTER_UNVERIFIED_LINUX=1` is set for the
 * app, the session is X11 (not Wayland) and every tool it needs is installed. Without all of that the feature says "not
 * supported" and its switch cannot be turned on, as before. macOS (Screen Recording and Accessibility permissions) has none.
 */
export const COMPUTER_UNVERIFIED_LINUX = "TOMVERSE_DESKTOP_COMPUTER_UNVERIFIED_LINUX";

export function createBackendFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env, probe?: Parameters<typeof x11Missing>[1]): ComputerBackend | null {
  if (platform === "win32") return createWindowsBackend();
  if (platform === "linux" && env[COMPUTER_UNVERIFIED_LINUX] === "1") return x11Missing(env, probe)?.length === 0 ? createX11Backend() : null;
  return null;
}
