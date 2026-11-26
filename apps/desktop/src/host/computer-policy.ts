import { parseComputerKey } from "../../../tomverse-cli/src/computer-tools";

/**
 * The decisions the host takes before the agent touches a desktop window, kept apart from Electron and from the operating system so
 * they can be tested. The agent never names a window: it gets the one window the person chose for the task, and only while the
 * task's run is live.
 */

/** The chosen window. `taskId` is null while the person chose it before the task had an id: the first run of that task adopts it. */
export type ComputerSelection = {
  /** `<hwnd>:<pid>`, the handle the agent and the approval card use. */
  id: string;
  pid: number;
  cls: string;
  title: string;
  app: string;
  /** The account and project the choice was made under; another account never reaches it. */
  scope: string;
  taskId: string | null;
};

/** The last picture the agent was given: what the agent's coordinates are measured in, and how that maps to the real window. */
export type ComputerShot = { imageWidth: number; imageHeight: number; width: number; height: number };

export type ComputerGateInput = {
  enabled: boolean;
  supported: boolean;
  eventRunId: string;
  activeRunId: string | null;
  taskId: string | null;
  taskRunning: boolean;
  /** The task runs on the Tomverse API path (the only path that has these tools). */
  apiExecution: boolean;
  suspended: boolean;
  scope: string | null;
  tool: "screenshot" | "click" | "type" | "key" | "scroll";
  /** The window the request names (not the screenshot, which names none). */
  requestWindow: string | null;
  selection: ComputerSelection | undefined;
  /** stopped: the person took control, or touched the mouse or keyboard; nothing is done until they hand it back. */
  control: "active" | "stopped";
  /** The global stop key is registered. An action is not done without it. */
  stopKey: boolean;
};

/** Why a request is refused, or null when it may go on. */
export function computerRequestRefusal(input: ComputerGateInput): string | null {
  if (!input.supported) return "Operating a desktop window is not supported on this operating system.";
  if (!input.enabled) return "The computer tools are not turned on.";
  if (!input.scope || !input.taskId) return "No window is available for this task.";
  if (input.eventRunId !== input.activeRunId || !input.taskRunning || !input.apiExecution || input.suspended) return "The task is not running.";
  const own = input.selection && input.selection.scope === input.scope && (input.selection.taskId === input.taskId || input.selection.taskId === null) ? input.selection : undefined;
  if (!own) return "The user has not chosen a window for this task. Ask them to choose one with Choose window.";
  if (input.control === "stopped") return "The user took control of the window. Ask them before using it again.";
  if (input.tool === "screenshot") return null;
  if (input.requestWindow !== own.id) return "That is not the window the user chose; nothing was done.";
  if (!input.stopKey) return "The global stop key could not be registered, so the agent does not act on the desktop.";
  return null;
}

/** A point of the agent's picture as a point of the real window, or null when it is outside the picture. */
export function mapPoint(shot: ComputerShot, x: number, y: number): { x: number; y: number } | null {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= shot.imageWidth || y >= shot.imageHeight) return null;
  return { x: Math.min(shot.width - 1, Math.floor(x * shot.width / shot.imageWidth)), y: Math.min(shot.height - 1, Math.floor(y * shot.height / shot.imageHeight)) };
}

const VIRTUAL_KEYS: Record<string, number> = {
  enter: 0x0d, tab: 0x09, escape: 0x1b, backspace: 0x08, delete: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, space: 0x20,
};

/** The Windows virtual key and modifiers of a canonical key name from the allowed list, or null for anything else. */
export function keyInput(key: string): { ctrl: boolean; shift: boolean; vk: number } | null {
  const canonical = parseComputerKey(key);
  if (!canonical) return null;
  const parts = canonical.split("+");
  const name = parts.at(-1)!;
  const vk = VIRTUAL_KEYS[name] ?? (/^[a-z]$/.test(name) ? name.toUpperCase().charCodeAt(0) : undefined);
  return vk === undefined ? null : { ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), vk };
}

/** What the agent is told when the window refused an action, by the reason the backend gave. */
export function refusalText(reason: string): string {
  switch (reason) {
    case "gone": return "The window was closed. Ask the user to choose a window again.";
    case "minimized": return "The window is minimized. Nothing was done; ask the user to restore it.";
    case "resized": return "The window changed size since the last screenshot. Nothing was done; take a new screenshot.";
    case "not-front": return "The window is not in front, so nothing was done (input could land in another window). Ask the user to bring it to the front.";
    case "covered": return "Another window is over the window, so nothing was done (input could land in it). Ask the user to bring the window to the front.";
    case "outside": return "That point is outside the window. Nothing was done.";
    case "covered-point": return "Another window is over that point. Nothing was done; ask the user to bring the window to the front.";
    case "focus-lost": return "The window lost the focus while typing. Typing stopped; take a screenshot to see what was typed.";
    default: return "The action was not done.";
  }
}
