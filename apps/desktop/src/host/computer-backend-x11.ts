import { spawn, spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { basename } from "node:path";
import type { ActOutcome, BackendAction, ComputerBackend, LastInput, RawWindow, WindowGone, WindowImage, WindowRef, WindowStatus } from "./computer-backend";

/**
 * The Linux backend, for an X11 session: the command line tools of the X11 world (xdotool, xprop, xwininfo, xprintidle and
 * ImageMagick's `import`), one run per question. Nothing is installed or built, nothing is written to a file (a picture travels
 * through a pipe), and a program is always started with an argument array, never a shell string.
 *
 * What it keeps from the Windows backend, check by check: the window is identified by its X id, its process id and its class and is
 * "gone" if any differ; an action is refused unless the window is not minimized, has the size of the picture, is the active window
 * (or Tomverse's own window is, and then the window is brought to the front first) and nothing covers it: every window the window
 * manager stacks above it, and every window that no window manager manages (a menu, a tooltip, a popup of another program, found from
 * the root's own list of children), is looked at, and what cannot be read counts as covering (only a window that is gone is left
 * out); a point must be inside the window, and the window under the pointer, read back after the pointer is put there and before
 * each click and wheel step, must be this window or a part of it; a pointer that moved is the person's; typing goes in short pieces
 * with the window checked between them; the person's keyboard and mouse are noticed by the idle time of the X server, which the
 * agent's own input also resets, so the agent's own last input is the baseline, and input that came after the end of the agent's
 * command and before the idle time was read is the person's. A picture is only taken of a window that nothing covers, because a screen
 * grab of a covered window would carry the pixels of whatever is above it.
 *
 * Not covered, said plainly: Wayland (native windows cannot be listed, captured or driven by these tools, so the backend does not
 * start there), and any desktop whose window manager does not set `_NET_ACTIVE_WINDOW`, `_NET_CLIENT_LIST_STACKING` and
 * `_NET_WM_PID`. A window that no window manager manages and that is below the chosen one is counted as covering too (their order is
 * not known), which only refuses more; a window of that kind as big as the screen covers too, whatever it carries, unless the person
 * set TOMVERSE_DESKTOP_COMPUTER_X11_TRUST_OVERLAY=1 to say that a property-less one is their compositor's overlay (on a compositing
 * desktop the window then always counts as covered until they do; nothing can tell the overlay from a window made to look like it).
 * The check and the input are separate program runs, so a window that changes between them is caught by the next check, not by
 * the input. It has been run against a model of the tools in tests, never on a real X server.
 */

export type X11Result = { code: number | null; stdout: Buffer; stderr: string };
export type X11Run = (file: string, args: string[], options?: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number }) => Promise<X11Result>;

/** What the backend needs installed, with the arguments that make each one print and exit. */
export const X11_TOOLS: ReadonlyArray<readonly [name: string, probe: string[]]> = [
  ["xdotool", ["--version"]], ["xprop", ["-version"]], ["xwininfo", ["-version"]], ["xprintidle", []], ["import", ["-version"]],
];

const CALL_TIMEOUT_MS = 10_000;
const CAPTURE_TIMEOUT_MS = 20_000;
/** Characters typed between two looks at the window. */
const TYPE_PIECE = 24;
/** Wheel notches sent between two looks at the pointer. */
const WHEEL_PIECE = 4;
/** The idle time of the X server is read around process starts; a reset smaller than this is jitter, not the person. */
const IDLE_SLACK_MS = 40;

const toolEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { LC_ALL: "C.UTF-8" };
  for (const name of ["DISPLAY", "XAUTHORITY", "PATH", "HOME", "XDG_RUNTIME_DIR"]) if (process.env[name]) env[name] = process.env[name];
  return env;
};

export const runTool: X11Run = (file, args, options = {}) => new Promise((resolve, reject) => {
  options.signal?.throwIfAborted();
  const child = spawn(file, args, { env: toolEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const chunks: Buffer[] = [];
  let held = 0;
  let errors = "";
  let settled = false;
  const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); action(); };
  const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } finish(() => reject(new Error("The request was stopped."))); };
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } finish(() => reject(new Error(`${file} timed out.`))); }, options.timeoutMs ?? CALL_TIMEOUT_MS);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    held += chunk.length;
    if (held > (options.maxBytes ?? 4 * 1024 * 1024)) { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } finish(() => reject(new Error(`${file} printed too much.`))); return; }
    chunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString("utf8")).slice(-400); });
  child.on("error", (error) => finish(() => reject(new Error(`${file} could not start (${error.message}).`))));
  child.on("close", (code) => finish(() => resolve({ code, stdout: Buffer.concat(chunks), stderr: errors })));
});

/** The tools this session has, found by running each once. Null where the session is not X11 or a tool is missing. */
export function x11Missing(env: NodeJS.ProcessEnv = process.env, probe: (file: string, args: string[]) => boolean = defaultProbe): string[] | null {
  if (!env.DISPLAY || env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) return null;
  return X11_TOOLS.filter(([name, args]) => !probe(name, args)).map(([name]) => name);
}

function defaultProbe(file: string, args: string[]): boolean {
  const done = spawnSync(file, args, { env: toolEnvironment(), timeout: 4_000, stdio: "ignore", windowsHide: true });
  return !done.error;
}

// ── reading what the tools print ───────────────────────────────────────────

/**
 * `NAME(TYPE) = value` lines of xprop (a window id reads `NAME(WINDOW): window id # 0x...`, with a colon); a property that is
 * missing reads `NAME(TYPE):  not found.` and is left out.
 */
export function parseXprop(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const found = /^([A-Za-z0-9_]+)(?:\([A-Za-z0-9_]+\))?(?:\s*=\s*|:\s+)(.*)$/.exec(line);
    if (found && !/^not found\.?\s*$/.test(found[2]!)) out.set(found[1]!, found[2]!);
  }
  return out;
}

/** `"a", "b\"c"` as its strings. */
export function quotedStrings(value: string | undefined): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  for (let match = pattern.exec(value ?? ""); match; match = pattern.exec(value ?? "")) out.push(match[1]!.replace(/\\(.)/g, "$1"));
  return out;
}

const windowIds = (value: string | undefined) => [...(value ?? "").matchAll(/0x[0-9a-fA-F]+/g)].map((match) => Number.parseInt(match[0], 16)).filter((id) => Number.isSafeInteger(id) && id > 0);

type Geometry = { x: number; y: number; width: number; height: number; viewable: boolean; inputOutput: boolean; overrideRedirect: boolean };

export function parseWinInfo(text: string): Geometry | null {
  const read = (label: RegExp) => { const found = label.exec(text); return found ? Number(found[1]) : Number.NaN; };
  const x = read(/Absolute upper-left X:\s+(-?\d+)/);
  const y = read(/Absolute upper-left Y:\s+(-?\d+)/);
  const width = read(/^\s*Width:\s+(\d+)/m);
  const height = read(/^\s*Height:\s+(\d+)/m);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x, y, width, height, viewable: /Map State:\s+IsViewable/.test(text),
    inputOutput: !/Class:\s+InputOnly/.test(text), overrideRedirect: /Override Redirect State:\s+yes/.test(text),
  };
}

/**
 * The direct children of the root window as `xwininfo -root -children` lists them, with their absolute rectangles. A line reads
 * `0x... "name": ("instance" "Class")  WxH+X+Y  +AX+AY` and a negative coordinate is printed with its own sign (`-20`, never `+-20`):
 * the sign is part of the number in both pairs.
 */
export function parseRootChildren(text: string): Array<{ xid: number; x: number; y: number; width: number; height: number }> {
  const out: Array<{ xid: number; x: number; y: number; width: number; height: number }> = [];
  for (const line of text.split("\n")) {
    const found = /^\s+(0x[0-9a-fA-F]+)\s.*?\s(\d+)x(\d+)([+-]\d+)([+-]\d+)\s+([+-]\d+)([+-]\d+)\s*$/.exec(line);
    if (found) out.push({ xid: Number.parseInt(found[1]!, 16), width: Number(found[2]), height: Number(found[3]), x: Number(found[6]), y: Number(found[7]) });
  }
  return out;
}

const overlaps = (a: Geometry, b: Geometry) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (g: Geometry, x: number, y: number) => x >= g.x && y >= g.y && x < g.x + g.width && y < g.y + g.height;

/** The ids this backend hands out: the X window id in hex and the process id, as the window picker's command expects. */
export function parseX11WindowId(id: string): { xid: number; pid: number } {
  const match = /^([0-9a-f]{1,8}):([0-9]{1,10})$/.exec(id);
  if (!match) throw new Error("Not a window id.");
  const xid = Number.parseInt(match[1]!, 16);
  if (!Number.isSafeInteger(xid) || xid <= 0) throw new Error("Not a window id.");
  return { xid, pid: Number(match[2]) };
}

/** The keys of the allowed list (computer-policy keyInput) as xdotool names. Anything else is refused here too. */
const KEY_NAMES: Record<number, string> = {
  0x0d: "Return", 0x09: "Tab", 0x1b: "Escape", 0x08: "BackSpace", 0x2e: "Delete", 0x24: "Home", 0x23: "End", 0x21: "Prior", 0x22: "Next",
  0x25: "Left", 0x26: "Up", 0x27: "Right", 0x28: "Down", 0x20: "space",
};
export function xdotoolKey(key: { ctrl: boolean; shift: boolean; vk: number }): string | null {
  const name = KEY_NAMES[key.vk] ?? (key.vk >= 0x41 && key.vk <= 0x5a ? String.fromCharCode(key.vk + 32) : undefined);
  if (!name) return null;
  // Ctrl+V pastes the clipboard, which cannot be checked: never sent, whatever asked.
  if (key.ctrl && name === "v") return null;
  return [...(key.ctrl ? ["ctrl"] : []), ...(key.shift ? ["shift"] : []), name].join("+");
}

const pngSize = (png: Buffer) => (png.length > 24 && png.readUInt32BE(0) === 0x89504e47 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null);

export type X11Options = {
  run?: X11Run;
  /** The program name of a process; the default reads `/proc/<pid>/exe`. */
  processName?: (pid: number) => string | null;
  now?: () => number;
  /**
   * The person says that a window as big as the screen with no class, name or process id, which nothing but the server's compositor
   * makes on their desktop, is the compositor's overlay and not a window of a program. Off: such a window cannot be told from one
   * that was made to look like the overlay, so it counts as covering whatever it is (on a compositing desktop that means the window
   * always counts as covered, and the backend refuses to act or take a picture until the person has checked their own desktop).
   */
  trustCompositorOverlay?: boolean;
};

const exeName = (pid: number): string | null => {
  try { return basename(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "")); } catch { return null; }
};

export function createX11Backend(options: X11Options = {}): ComputerBackend {
  const run = options.run ?? runTool;
  const nameOf = options.processName ?? exeName;
  const now = options.now ?? Date.now;

  const text = async (file: string, args: string[], signal?: AbortSignal, timeoutMs?: number) => {
    const done = await run(file, args, { signal, timeoutMs });
    return { ok: done.code === 0, out: done.stdout.toString("utf8"), err: done.stderr };
  };
  const hex = (xid: number) => `0x${xid.toString(16)}`;

  async function props(xid: number, signal?: AbortSignal) {
    const done = await text("xprop", ["-id", hex(xid), "_NET_WM_PID", "WM_CLASS", "_NET_WM_NAME", "WM_NAME", "_NET_WM_STATE", "_NET_WM_WINDOW_TYPE"], signal);
    return done.ok ? parseXprop(done.out) : null;
  }
  async function geometry(xid: number, signal?: AbortSignal): Promise<Geometry | null> {
    const done = await text("xwininfo", ["-id", hex(xid)], signal);
    return done.ok ? parseWinInfo(done.out) : null;
  }
  /** What a question about another window came to: an answer, "the window is gone" (only that), or "could not tell". */
  type Looked<T> = { kind: "ok"; value: T } | { kind: "vanished" } | { kind: "error" };
  const vanished = (error: string) => /BadWindow|No such window/i.test(error);
  async function propsOf(xid: number, signal?: AbortSignal): Promise<Looked<Map<string, string>>> {
    const done = await text("xprop", ["-id", hex(xid), "_NET_WM_STATE", "_NET_WM_WINDOW_TYPE"], signal);
    return done.ok ? { kind: "ok", value: parseXprop(done.out) } : vanished(done.err) ? { kind: "vanished" } : { kind: "error" };
  }
  async function rectOf(xid: number, signal?: AbortSignal): Promise<Looked<Geometry>> {
    const done = await text("xwininfo", ["-id", hex(xid)], signal);
    if (!done.ok) return vanished(done.err) ? { kind: "vanished" } : { kind: "error" };
    const rect = parseWinInfo(done.out);
    return rect ? { kind: "ok", value: rect } : { kind: "error" };
  }
  async function stacking(signal?: AbortSignal): Promise<number[]> {
    const done = await text("xprop", ["-root", "_NET_CLIENT_LIST_STACKING"], signal);
    return done.ok ? windowIds(parseXprop(done.out).get("_NET_CLIENT_LIST_STACKING")) : [];
  }
  async function active(signal?: AbortSignal): Promise<{ xid: number; pid: number } | null> {
    const done = await text("xprop", ["-root", "_NET_ACTIVE_WINDOW"], signal);
    const xid = done.ok ? windowIds(parseXprop(done.out).get("_NET_ACTIVE_WINDOW"))[0] : undefined;
    if (!xid) return null;
    const found = await props(xid, signal);
    return { xid, pid: Number(found?.get("_NET_WM_PID") ?? 0) || 0 };
  }

  const classOf = (found: Map<string, string>) => { const names = quotedStrings(found.get("WM_CLASS")); return names[1] ?? names[0] ?? ""; };
  const titleOf = (found: Map<string, string>) => quotedStrings(found.get("_NET_WM_NAME"))[0] ?? quotedStrings(found.get("WM_NAME"))[0] ?? "";
  const hidden = (found: Map<string, string>) => /_NET_WM_STATE_HIDDEN/.test(found.get("_NET_WM_STATE") ?? "");
  /** A window the person can choose is an ordinary one (or a dialog); a dock, the desktop, a menu or a notification is not. */
  const ordinary = (found: Map<string, string>) => {
    const type = found.get("_NET_WM_WINDOW_TYPE");
    return type === undefined || /_NET_WM_WINDOW_TYPE_(NORMAL|DIALOG)\b/.test(type) && !/_NET_WM_WINDOW_TYPE_(DOCK|DESKTOP|MENU|DROPDOWN_MENU|POPUP_MENU|TOOLTIP|NOTIFICATION|COMBO|DND|SPLASH)\b/.test(type);
  };

  /**
   * Is something above the window over this rectangle (or this point)? Everything the window manager stacks above it is looked at,
   * and so is every window that no window manager manages (a menu, a tooltip, a popup of another program), which the stacking list
   * does not hold. What cannot be read counts as covering: only a window that is gone is left out.
   */
  async function coveredBy(xid: number, own: Geometry, point?: { x: number; y: number }, signal?: AbortSignal) {
    const order = await stacking(signal);
    const at = order.indexOf(xid);
    // A window that is not in the list cannot be told to be uncovered.
    if (at < 0) return { covered: true, point: true };
    let covered = false;
    let pointCovered = false;
    const consider = (rect: Geometry) => {
      if (overlaps(own, rect)) covered = true;
      if (point && contains(rect, point.x, point.y)) pointCovered = true;
    };
    for (const above of order.slice(at + 1)) {
      const [found, rect] = await Promise.all([propsOf(above, signal), rectOf(above, signal)]);
      if (found.kind === "vanished" || rect.kind === "vanished") continue;
      if (found.kind === "error" || rect.kind === "error") return { covered: true, point: true };
      if (!rect.value.viewable || hidden(found.value)) continue;
      consider(rect.value);
    }
    const loose = await unmanagedOver(own, signal);
    if (loose === null) return { covered: true, point: true };
    for (const rect of loose) consider(rect);
    return { covered, point: pointCovered };
  }

  /**
   * The mapped windows of the root that the window manager does not manage (override-redirect) and that overlap the window, or null
   * when that cannot be found out. A window as big as the screen covers, unless the person said (`trustCompositorOverlay`) that
   * a property-less one is their compositor's overlay. A window of this kind below the chosen one is counted too (the order among
   * them is not known), which only refuses more.
   */
  async function unmanagedOver(own: Geometry, signal?: AbortSignal): Promise<Geometry[] | null> {
    const [root, tree] = await Promise.all([text("xwininfo", ["-root"], signal), text("xwininfo", ["-root", "-children"], signal)]);
    const screen = root.ok ? parseWinInfo(root.out) : null;
    if (!screen || !tree.ok) return null;
    const found: Geometry[] = [];
    for (const child of parseRootChildren(tree.out)) {
      if (!overlaps(own, { ...child, viewable: true, inputOutput: true, overrideRedirect: false })) continue;
      const rect = await rectOf(child.xid, signal);
      if (rect.kind === "vanished") continue;
      if (rect.kind === "error") return null;
      if (!rect.value.viewable || !rect.value.inputOutput || !rect.value.overrideRedirect) continue;
      if (rect.value.width >= screen.width && rect.value.height >= screen.height && options.trustCompositorOverlay === true) {
        // As big as the screen, and the person trusts the overlay of their compositor: it is that overlay only if it has no property of
        // a program (no class, name or process id). A full-screen popup, a lock screen or a splash of a program has them and is a
        // window like any other. Without that trust a window like this is never looked through: it covers.
        const named = await text("xprop", ["-id", hex(child.xid), "WM_CLASS", "WM_NAME", "_NET_WM_NAME", "_NET_WM_PID"], signal);
        if (!named.ok) {
          if (vanished(named.err)) continue;
          return null;
        }
        if (parseXprop(named.out).size === 0) continue;
      }
      found.push(rect.value);
    }
    return found;
  }

  /** The window as it is now, or null when it is not the same window any more. */
  async function look(window: WindowRef, signal?: AbortSignal) {
    const { xid, pid } = parseX11WindowId(window.id);
    const found = await props(xid, signal);
    if (!found || Number(found.get("_NET_WM_PID") ?? 0) !== pid || classOf(found) !== window.cls) return null;
    const rect = await geometry(xid, signal);
    if (!rect) return null;
    const front = await active(signal);
    const minimized = hidden(found) || !rect.viewable;
    const covered = minimized ? false : (await coveredBy(xid, rect, undefined, signal)).covered;
    const status: WindowStatus = {
      gone: false, title: titleOf(found), app: nameOf(pid) ?? quotedStrings(found.get("WM_CLASS"))[0] ?? "", minimized,
      foreground: front?.xid === xid, covered, foregroundPid: front?.pid ?? 0, width: rect.width, height: rect.height,
    };
    return { xid, pid, rect, status };
  }

  // ── the person's input: the idle time of the X server ──
  let seen: { tick: number; sampledAt: number } | undefined;
  async function idleSample(signal?: AbortSignal) {
    const before = now();
    const done = await text("xprintidle", [], signal);
    const after = now();
    const idle = Number(done.out.trim());
    if (!done.ok || !Number.isFinite(idle) || idle < 0) throw new Error("The idle time could not be read.");
    const at = (before + after) / 2;
    // `last`: when the server last saw input, on this process's own millisecond clock. `tick`: the same cut to 32 bits, which is
    // what the host compares; times are compared on `last`, which is not cut.
    const last = Math.round(at - idle);
    return { idle, at, last, tick: last >>> 0 };
  }
  /**
   * Notes that the agent's own input just went out, and returns the tick the host takes as the end of it. The idle time is read a
   * moment later, so a key the person pressed in that gap would look like the last input of the agent's own: when the last input
   * the server saw is later than the end of the agent's command, it was not the agent's, and `person` says so.
   */
  async function ownInput(signal?: AbortSignal): Promise<{ tick: number | undefined; person: boolean }> {
    const ended = now();
    try {
      const sample = await idleSample(signal);
      seen = { tick: sample.tick, sampledAt: sample.at };
      return { tick: ended >>> 0, person: sample.last - ended > IDLE_SLACK_MS };
    } catch { return { tick: undefined, person: false }; }
  }
  /** Whether anything moved the pointer or pressed a key since the last time this was looked at. */
  async function inputSince(signal?: AbortSignal) {
    const sample = await idleSample(signal);
    const previous = seen;
    const moved = previous === undefined ? false : sample.idle + IDLE_SLACK_MS < sample.at - previous.sampledAt;
    seen = { tick: moved || !previous ? sample.tick : previous.tick, sampledAt: sample.at };
    return moved;
  }

  async function pointer(signal?: AbortSignal): Promise<{ x: number; y: number } | null> {
    const done = await text("xdotool", ["getmouselocation", "--shell"], signal);
    const x = /^X=(-?\d+)$/m.exec(done.out);
    const y = /^Y=(-?\d+)$/m.exec(done.out);
    return done.ok && x && y ? { x: Number(x[1]), y: Number(y[1]) } : null;
  }

  /** The checks every input goes through, in the order of the Windows backend. */
  async function gate(window: WindowRef, size: { width: number; height: number }, point: { x: number; y: number } | undefined, handBackFrom: number, signal?: AbortSignal):
    Promise<{ ok: false; reason: string } | { ok: true; screen: { x: number; y: number } | undefined }> {
    let seenNow = await look(window, signal);
    if (!seenNow) return { ok: false, reason: "gone" };
    if (seenNow.status.minimized) return { ok: false, reason: "minimized" };
    if (seenNow.rect.width !== size.width || seenNow.rect.height !== size.height) return { ok: false, reason: "resized" };
    if (!seenNow.status.foreground) {
      // Only Tomverse's own window may hand the front back.
      if (seenNow.status.foregroundPid !== handBackFrom) return { ok: false, reason: "not-front" };
      await text("xdotool", ["windowactivate", "--sync", hex(seenNow.xid)], signal);
      seenNow = await look(window, signal);
      if (!seenNow) return { ok: false, reason: "gone" };
      if (!seenNow.status.foreground) return { ok: false, reason: "not-front" };
    }
    if (seenNow.status.covered) return { ok: false, reason: "covered" };
    if (point) {
      if (point.x < 0 || point.y < 0 || point.x >= seenNow.rect.width || point.y >= seenNow.rect.height) return { ok: false, reason: "outside" };
      const screen = { x: seenNow.rect.x + point.x, y: seenNow.rect.y + point.y };
      if ((await coveredBy(seenNow.xid, seenNow.rect, screen, signal)).point) return { ok: false, reason: "covered-point" };
      return { ok: true, screen };
    }
    return { ok: true, screen: undefined };
  }

  /**
   * Whether the window under the pointer is the chosen window or a part of it. The pointer window is the deepest window at the
   * pointer that takes input, so a popup, a menu or a tooltip over the point is what is found, whether or not a window manager
   * manages it. The chain of parents is followed up to the root.
   */
  async function pointerIsOver(target: number, signal?: AbortSignal): Promise<boolean> {
    const done = await text("xdotool", ["getmouselocation", "--shell"], signal);
    const found = /^WINDOW=(\d+)$/m.exec(done.out);
    if (!done.ok || !found) return false;
    let current = Number(found[1]);
    for (let depth = 0; depth < 12 && Number.isSafeInteger(current) && current > 0; depth += 1) {
      if (current === target) return true;
      const tree = await text("xwininfo", ["-id", hex(current), "-children"], signal);
      const parent = tree.ok ? /Parent window id:\s+(0x[0-9a-fA-F]+)/.exec(tree.out) : null;
      if (!parent) return false;
      current = Number.parseInt(parent[1]!, 16);
    }
    return false;
  }

  /** Puts the pointer on the target and reads it back. */
  async function place(screen: { x: number; y: number }, signal?: AbortSignal) {
    await text("xdotool", ["mousemove", "--sync", String(screen.x), String(screen.y)], signal);
    const at = await pointer(signal);
    return at !== null && at.x === screen.x && at.y === screen.y;
  }

  const buttonOf = (button: "left" | "right") => (button === "right" ? "3" : "1");

  return {
    async list() {
      const out: RawWindow[] = [];
      for (const xid of (await stacking()).reverse()) {
        const found = await props(xid);
        const pid = Number(found?.get("_NET_WM_PID") ?? 0);
        // A window with no process id cannot be told from another one later, so it is never offered.
        if (!found || !pid || !ordinary(found) || hidden(found)) continue;
        out.push({ id: `${xid.toString(16)}:${pid}`, pid, cls: classOf(found), title: titleOf(found), app: nameOf(pid) ?? quotedStrings(found.get("WM_CLASS"))[0] ?? "" });
        if (out.length >= 120) break;
      }
      return out;
    },

    async info(window): Promise<WindowStatus | WindowGone> {
      const current = await look(window);
      return current ? current.status : { gone: true };
    },

    async capture(window, maxEdge) {
      const current = await look(window);
      if (!current) return { gone: true as const };
      // A grab of the screen under a covered or minimized window would carry what is above it: no picture then.
      if (current.status.minimized || current.status.covered) return { status: current.status };
      const edge = Math.max(64, Math.min(4096, Math.floor(maxEdge)));
      const done = await run("import", ["-window", hex(current.xid), "-resize", `${edge}x${edge}>`, "png:-"], { timeoutMs: CAPTURE_TIMEOUT_MS, maxBytes: 24 * 1024 * 1024 });
      if (done.code !== 0) throw new Error("The picture of the window could not be taken.");
      const size = pngSize(done.stdout);
      if (!size) throw new Error("The picture of the window could not be read.");
      // The picture is only worth sending if nothing came over the window while it was taken.
      const after = await look(window);
      if (!after || after.status.covered || after.status.minimized) return { status: after?.status ?? current.status };
      const image: WindowImage = { mediaType: "image/png", base64: done.stdout.toString("base64"), imageWidth: size.width, imageHeight: size.height, width: current.rect.width, height: current.rect.height };
      return { status: after.status, image };
    },

    async act(window, size, action: BackendAction, handBackFrom, signal): Promise<ActOutcome> {
      signal?.throwIfAborted();
      const refuse = (reason: string, extra: Partial<ActOutcome> = {}): ActOutcome => ({ performed: false, reason, ...extra });
      const withTick = (tick: number | undefined): Partial<ActOutcome> => (tick !== undefined ? { sentTick: tick } : {});

      if (action.kind === "key") {
        const name = xdotoolKey(action);
        if (!name) return refuse("input-failed");
        const checked = await gate(window, size, undefined, handBackFrom, signal);
        if (!checked.ok) return refuse(checked.reason);
        signal?.throwIfAborted();
        if (await inputSince(signal)) return refuse("user-input");
        const sent = await text("xdotool", ["key", "--clearmodifiers", name], signal);
        const own = await ownInput(signal);
        return sent.ok ? { performed: true, ...withTick(own.tick) } : refuse("input-failed", withTick(own.tick));
      }

      if (action.kind === "type") {
        const pieces = Array.from(action.text);
        let typed = 0;
        let lastTick: number | undefined;
        // Set when the person's input was seen right after a piece went out: the next piece is not sent.
        let person = false;
        if (await inputSince(signal)) return refuse("user-input", { typed });
        for (let at = 0; at < pieces.length; at += TYPE_PIECE) {
          signal?.throwIfAborted();
          if (person) return refuse("user-input", { typed, ...withTick(lastTick) });
          const piece = pieces.slice(at, at + TYPE_PIECE).join("");
          const checked = await gate(window, size, undefined, handBackFrom, signal);
          // Before the first piece a refusal is the same as for any input; between pieces the window changed under the typing.
          if (!checked.ok) return refuse(typed > 0 && checked.reason === "not-front" ? "focus-lost" : checked.reason, { typed, ...withTick(lastTick) });
          if (typed > 0 && await inputSince(signal)) return refuse("user-input", { typed, ...withTick(lastTick) });
          const sent = await text("xdotool", ["type", "--delay", "12", "--", piece], signal);
          const own = await ownInput(signal);
          lastTick = own.tick ?? lastTick;
          person = own.person;
          if (!sent.ok) return refuse("input-failed", { typed, ...withTick(lastTick) });
          typed += Array.from(piece).length;
        }
        return { performed: true, typed, ...withTick(lastTick) };
      }

      // click and scroll: a point of the window
      const checked = await gate(window, size, { x: action.x, y: action.y }, handBackFrom, signal);
      if (!checked.ok) return refuse(checked.reason);
      if (!checked.screen) return refuse("outside");
      const screen = checked.screen;
      const target = parseX11WindowId(window.id).xid;
      signal?.throwIfAborted();
      if (await inputSince(signal)) return refuse("user-input");
      const placed = await place(screen, signal);
      if (!placed) return refuse("cursor-failed");
      // What is under the pointer must be this window (or a part of it): a popup that no window manager manages is found this way.
      if (!await pointerIsOver(target, signal)) return refuse("covered-point");
      // Moving the pointer was the agent's own input: the person's input is told from it again from here on.
      const placedAt = await ownInput(signal);
      if (placedAt.person) return refuse("user-input", withTick(placedAt.tick));
      /**
       * The input itself: the pointer goes to the checked point in the same program run as the click or the wheel, so a pointer the
       * person moved since the last look is put back and the input lands on the point that was checked. What remains between the
       * last look and the program's start is a few milliseconds, which a separate run cannot close.
       */
      const atPoint = ["mousemove", "--sync", String(screen.x), String(screen.y)];

      /** The window and the pointer, looked at again before the next input goes out, the first one included. */
      const stillThere = async (): Promise<string | null> => {
        const again = await gate(window, size, { x: action.x, y: action.y }, handBackFrom, signal);
        if (!again.ok) return again.reason;
        const at = await pointer(signal);
        if (!at || at.x !== screen.x || at.y !== screen.y) return "cursor-moved";
        if (!await pointerIsOver(target, signal)) return "covered-point";
        return (await inputSince(signal)) ? "user-input" : null;
      };

      if (action.kind === "click") {
        const planned = action.double ? 2 : 1;
        let delivered = 0;
        let lastTick: number | undefined = placedAt.tick;
        let person = false;
        for (let index = 0; index < planned; index += 1) {
          signal?.throwIfAborted();
          const why = person ? "user-input" : await stillThere();
          if (why) return refuse(why, { delivered, planned, ...withTick(lastTick) });
          const sent = await text("xdotool", [...atPoint, "click", buttonOf(action.button)], signal);
          const own = await ownInput(signal);
          lastTick = own.tick ?? lastTick;
          person = own.person;
          if (!sent.ok) return refuse("input-failed", { delivered, planned, ...withTick(lastTick) });
          delivered += 1;
        }
        return { performed: true, delivered, planned, ...withTick(lastTick) };
      }

      // scroll: wheel buttons 4 up, 5 down, 6 left, 7 right, a few notches between two looks at the pointer
      const steps: Array<{ button: string; notches: number }> = [];
      if (action.dy) steps.push({ button: action.dy > 0 ? "5" : "4", notches: Math.abs(action.dy) });
      if (action.dx) steps.push({ button: action.dx > 0 ? "7" : "6", notches: Math.abs(action.dx) });
      const planned = steps.reduce((sum, step) => sum + step.notches, 0);
      let delivered = 0;
      let lastTick: number | undefined = placedAt.tick;
      let person = false;
      for (const step of steps) {
        for (let left = step.notches; left > 0; left -= WHEEL_PIECE) {
          signal?.throwIfAborted();
          const why = person ? "user-input" : await stillThere();
          if (why) return refuse(why, { delivered, planned, ...withTick(lastTick) });
          const count = Math.min(WHEEL_PIECE, left);
          const sent = await text("xdotool", [...atPoint, "click", "--repeat", String(count), "--delay", "30", step.button], signal);
          const own = await ownInput(signal);
          lastTick = own.tick ?? lastTick;
          person = own.person;
          if (!sent.ok) return refuse("input-failed", { delivered, planned, ...withTick(lastTick) });
          delivered += count;
        }
      }
      return { performed: true, delivered, planned, ...withTick(lastTick) };
    },

    async bringToFront(window) {
      const current = await look(window);
      if (!current) return false;
      await text("xdotool", ["windowactivate", "--sync", hex(current.xid)]);
      return (await look(window))?.status.foreground === true;
    },

    async lastInput(): Promise<LastInput> {
      const sample = await idleSample();
      const previous = seen;
      const moved = previous === undefined || sample.idle + IDLE_SLACK_MS < sample.at - previous.sampledAt;
      const tick = moved ? sample.tick : previous.tick;
      seen = { tick, sampledAt: sample.at };
      return { idleMs: sample.idle, inputTick: tick };
    },

    dispose() { seen = undefined; },
  };
}

