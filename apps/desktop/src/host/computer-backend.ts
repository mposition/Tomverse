/**
 * What the host needs from the operating system to see and operate one window. Windows has an implementation (computer-backend-windows.ts);
 * a fake one serves the tests. Another platform has none, and the feature says so instead of pretending.
 */

export type RawWindow = { id: string; pid: number; cls: string; title: string; app: string };

/** One window as the operating system sees it right now. `foreground`: it is the window that receives the keyboard. */
export type WindowStatus = {
  gone: false;
  title: string;
  app: string;
  minimized: boolean;
  foreground: boolean;
  /** Another window is over a visible part of it. */
  covered: boolean;
  /** The process of the foreground window: Tomverse's own windows may hand the foreground back, anything else may not. */
  foregroundPid: number;
  width: number;
  height: number;
};
export type WindowGone = { gone: true };

export type WindowImage = { mediaType: "image/png" | "image/jpeg"; base64: string; imageWidth: number; imageHeight: number; width: number; height: number };

/** The window a call is about: the backend checks that it is still this window (same handle, process and class). */
export type WindowRef = { id: string; pid: number; cls: string };

export type BackendAction =
  | { kind: "click"; x: number; y: number; button: "left" | "right"; double: boolean }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "key"; ctrl: boolean; shift: boolean; vk: number }
  | { kind: "type"; text: string };

/**
 * `performed: false` with `reason` means the action stopped. Whatever had already gone out is not undone: `typed` is the characters
 * typed, and `delivered` of `planned` is the clicks or wheel inputs of a double click or a two-axis scroll (both absent when nothing went out).
 */
export type ActOutcome = {
  performed: boolean; reason?: string; typed?: number; delivered?: number; planned?: number;
  /** The operating system's input clock (a 32-bit millisecond tick) right after the agent's own last input went out. Absent when none did. */
  sentTick?: number;
};

/** The system's last mouse or keyboard input, by anyone: how long ago, and when on the same 32-bit tick clock that `sentTick` is read from. */
export type LastInput = { idleMs: number; inputTick: number };

export interface ComputerBackend {
  list(): Promise<RawWindow[]>;
  info(window: WindowRef): Promise<WindowStatus | WindowGone>;
  /** The picture of the window alone, scaled so its longer side is at most `maxEdge`. Not taken while it is minimized. */
  capture(window: WindowRef, maxEdge: number): Promise<{ status: WindowStatus; image?: WindowImage } | WindowGone>;
  /**
   * Does the action only if, at that moment and in the same call, the window is the same one, not minimized, the same size as at the
   * last picture (`size`), in front, and (for a point) the window itself is under the point. `handBackFrom`: when the foreground
   * window belongs to that process (Tomverse itself), the window may be brought to the front first. `signal`: when it aborts, the
   * backend stops what it is sending at once (no further input goes out) and the call rejects.
   */
  act(window: WindowRef, size: { width: number; height: number }, action: BackendAction, handBackFrom: number, signal?: AbortSignal): Promise<ActOutcome>;
  /** Brings the window forward: only when the person has just chosen it. */
  bringToFront(window: WindowRef): Promise<boolean>;
  /** The last mouse or keyboard input of the person (or of any program, the agent's own included). */
  lastInput(): Promise<LastInput>;
  dispose(): void;
}
