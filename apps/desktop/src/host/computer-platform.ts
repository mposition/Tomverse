import type { ComputerBackend } from "./computer-backend";
import { createWindowsBackend } from "./computer-backend-windows";

/**
 * Which operating systems can see and operate a window. Only Windows has an implementation that was run and checked; macOS (Screen
 * Recording and Accessibility permissions) and Linux (X11 and Wayland differ) have none yet, so there the feature reports "not
 * supported" and its switch cannot be turned on. Code that was never run is not left switched on.
 */
export function createBackendFor(platform: NodeJS.Platform): ComputerBackend | null {
  return platform === "win32" ? createWindowsBackend() : null;
}
