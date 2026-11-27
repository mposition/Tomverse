import assert from "node:assert/strict";
import test from "node:test";
import type { WindowRef } from "../src/host/computer-backend";
import { createX11Backend, parseWinInfo, parseX11WindowId, parseXprop, quotedStrings, x11Missing, xdotoolKey, X11_TOOLS, type X11Run } from "../src/host/computer-backend-x11";
import { COMPUTER_UNVERIFIED_LINUX, createBackendFor } from "../src/host/computer-platform";
import { windowDenial } from "../src/host/computer-deny";
import { keyInput } from "../src/host/computer-policy";
import { INPUT_TICK_MS, tickDistance } from "../src/host/computer-host";

// The Linux (X11) backend against a model of the tools it runs. Nothing here touches a real X server; that is what the backend's
// own documentation says is not verified. What these tests fix is every check it makes before a program that sends input is run.

type FakeWindow = {
  xid: number; pid: number; cls: string; instance: string; title: string; type?: string; hidden?: boolean; mapped?: boolean;
  x: number; y: number; w: number; h: number;
};
type Call = { file: string; args: string[] };

const PNG = (width: number, height: number) => {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
};

function fakeX(initial: FakeWindow[]) {
  let clock = 1_000_000;
  const windows = new Map<number, FakeWindow>(initial.map((window) => [window.xid, { ...window }]));
  let stack = initial.map((window) => window.xid);
  let active = initial.at(-1)?.xid ?? 0;
  let pointer = { x: 5, y: 5 };
  /** The X server's own idea of the last input, by anyone: the agent's input counts too. */
  let lastInputAt = clock - 60_000;
  const calls: Call[] = [];
  const hooks: Array<(call: Call) => void> = [];
  const inputCalls = () => calls.filter((call) => call.file === "xdotool" && ["mousemove", "click", "key", "type"].includes(call.args[0]!));

  const out = (stdout: string, code = 0): { code: number; stdout: Buffer; stderr: string } => ({ code, stdout: Buffer.from(stdout), stderr: "" });
  const bad = () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "xprop: error: X Error of failed request:  BadWindow" });
  const idOf = (text: string) => Number.parseInt(text, 16);

  const run: X11Run = async (file, args, options) => {
    options?.signal?.throwIfAborted();
    clock += 5;
    const call = { file, args: [...args] };
    calls.push(call);
    for (const hook of hooks) hook(call);
    if (file === "xprop" && args[0] === "-root") {
      if (args[1] === "_NET_CLIENT_LIST_STACKING") return out(`_NET_CLIENT_LIST_STACKING(WINDOW): window id # ${stack.map((id) => `0x${id.toString(16)}`).join(", ")}\n`);
      return out(`_NET_ACTIVE_WINDOW(WINDOW): window id # 0x${active.toString(16)}\n`);
    }
    if (file === "xprop" && args[0] === "-id") {
      const window = windows.get(idOf(args[1]!));
      if (!window) return bad();
      const lines = [`_NET_WM_PID(CARDINAL) = ${window.pid}`, `WM_CLASS(STRING) = "${window.instance}", "${window.cls}"`,
        `_NET_WM_NAME(UTF8_STRING) = "${window.title}"`, `WM_NAME(STRING) = "${window.title}"`,
        window.hidden ? "_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN" : "_NET_WM_STATE(ATOM) = ",
        window.type ? `_NET_WM_WINDOW_TYPE(ATOM) = ${window.type}` : "_NET_WM_WINDOW_TYPE(ATOM):  not found."];
      return out(lines.join("\n") + "\n");
    }
    if (file === "xwininfo") {
      const window = windows.get(idOf(args[1]!));
      if (!window) return bad();
      return out(`xwininfo: Window id: ${args[1]}\n  Absolute upper-left X:  ${window.x}\n  Absolute upper-left Y:  ${window.y}\n  Width: ${window.w}\n  Height: ${window.h}\n  Map State: ${window.mapped === false ? "IsUnMapped" : "IsViewable"}\n`);
    }
    if (file === "xprintidle") return out(`${clock - lastInputAt}\n`);
    if (file === "xdotool") {
      switch (args[0]) {
        case "getmouselocation": return out(`X=${pointer.x}\nY=${pointer.y}\nSCREEN=0\nWINDOW=0\n`);
        case "mousemove": pointer = { x: Number(args[2]), y: Number(args[3]) }; lastInputAt = clock; return out("");
        case "windowactivate": active = idOf(args[2]!); stack = [...stack.filter((id) => id !== active), active]; return out("");
        case "click": case "key": case "type": lastInputAt = clock; return out("");
        default: return { code: 1, stdout: Buffer.alloc(0), stderr: "unknown" };
      }
    }
    if (file === "import") return { code: 0, stdout: PNG(784, 392), stderr: "" };
    return { code: 127, stdout: Buffer.alloc(0), stderr: "no such tool" };
  };

  return {
    run, calls, inputCalls, windows,
    now: () => clock,
    onCall: (hook: (call: Call) => void) => hooks.push(hook),
    /** The person: moves the mouse or presses a key now. */
    person: (kind: "mouse" | "key" = "key") => { lastInputAt = clock; if (kind === "mouse") pointer = { x: pointer.x + 40, y: pointer.y + 7 }; },
    pointerAt: () => pointer,
    activate: (xid: number) => { active = xid; stack = [...stack.filter((id) => id !== xid), xid]; },
    /** The stacking order, bottom to top, without changing which window is active. */
    restack: (ids: number[]) => { stack = ids; },
    advance: (ms: number) => { clock += ms; },
  };
}

const EDITOR: FakeWindow = { xid: 0x4a00003, pid: 4321, cls: "Gedit", instance: "gedit", title: "notes.txt", x: 100, y: 80, w: 800, h: 400 };
const ref = (window: FakeWindow = EDITOR): WindowRef => ({ id: `${window.xid.toString(16)}:${window.pid}`, pid: window.pid, cls: window.cls });
const OWN_PID = process.pid;
const FRONT_APP: FakeWindow = { xid: 0x5000001, pid: 999, cls: "Other", instance: "other", title: "Other app", x: 0, y: 0, w: 300, h: 200 };

function setup(extra: FakeWindow[] = [], options: { activeIsEditor?: boolean } = {}) {
  const x = fakeX([...extra, EDITOR]);
  const backend = createX11Backend({ run: x.run, now: x.now, processName: (pid) => ({ 4321: "gedit", 999: "other", 100: "gnome-shell" } as Record<number, string>)[pid] ?? null });
  if (options.activeIsEditor === false) x.activate(extra[0]!.xid);
  return { x, backend };
}
const size = { width: EDITOR.w, height: EDITOR.h };

test("the output of xprop and xwininfo is read for the values it names and nothing else", () => {
  const props = parseXprop('_NET_WM_PID(CARDINAL) = 77\nWM_CLASS(STRING) = "a", "B c"\n_NET_WM_STATE(ATOM):  not found.\n');
  assert.equal(props.get("_NET_WM_PID"), "77");
  assert.deepEqual(quotedStrings(props.get("WM_CLASS")), ["a", "B c"]);
  assert.equal(props.has("_NET_WM_STATE"), false);
  assert.deepEqual(quotedStrings('"he said \\"hi\\""'), ['he said "hi"']);
  assert.deepEqual(parseWinInfo("  Absolute upper-left X:  -5\n  Absolute upper-left Y:  10\n  Width: 640\n  Height: 480\n  Map State: IsViewable\n"), { x: -5, y: 10, width: 640, height: 480, viewable: true });
  assert.equal(parseWinInfo("garbage"), null);
  assert.deepEqual(parseX11WindowId("4a00003:4321"), { xid: 0x4a00003, pid: 4321 });
  for (const bad of ["", "zz:1", "4a00003", "4a00003:abc", "123456789:1", "0:1", "4a00003:4321;rm"]) assert.throws(() => parseX11WindowId(bad), /Not a window id/, bad);
});

test("the window list holds ordinary windows with a process id, top first, and never a dock, menu, desktop, hidden window or one with no pid", async () => {
  const { backend } = setup([
    { ...FRONT_APP, xid: 0x1, type: "_NET_WM_WINDOW_TYPE_DOCK", title: "panel" },
    { ...FRONT_APP, xid: 0x2, type: "_NET_WM_WINDOW_TYPE_DESKTOP", title: "desktop" },
    { ...FRONT_APP, xid: 0x3, type: "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU, _NET_WM_WINDOW_TYPE_NORMAL", title: "menu" },
    { ...FRONT_APP, xid: 0x4, pid: 0, title: "no process" },
    { ...FRONT_APP, xid: 0x5, hidden: true, title: "minimized" },
    { ...FRONT_APP, xid: 0x6, type: "_NET_WM_WINDOW_TYPE_DIALOG", title: "A dialog" },
  ]);
  const rows = await backend.list();
  assert.deepEqual(rows.map((row) => row.title), ["notes.txt", "A dialog"]);
  assert.deepEqual(rows[0], { id: "4a00003:4321", pid: 4321, cls: "Gedit", title: "notes.txt", app: "gedit" });
  // What it hands out is what the picker's command accepts.
  assert.match(rows[0]!.id, /^[0-9a-f]{1,16}:[0-9]{1,10}$/);
});

test("the deny list holds the Linux terminals, browsers, password managers, settings, prompts and file managers as it holds the Windows ones", () => {
  const denied = (app: string, cls = "X") => windowDenial({ app, cls, pid: 1 }, [OWN_PID]);
  for (const [app, why] of [["gnome-terminal-server", "terminal"], ["konsole", "terminal"], ["xterm", "terminal"], ["bash", "terminal"], ["firefox", "browser"],
    ["google-chrome", "browser"], ["chromium-browser", "browser"], ["keepassxc", "secrets"], ["seahorse", "secrets"], ["gnome-control-center", "system"],
    ["polkit-gnome-authentication-agent-1", "prompt"], ["pinentry-gnome3", "prompt"], ["nautilus", "shell"], ["plasmashell", "shell"], ["remmina", "remote"], ["ssh", "remote"]] as const) {
    assert.equal(denied(app), why, app);
  }
  assert.equal(denied("gedit"), null);
  assert.equal(denied("something", "Gnome-terminal"), "terminal", "by window class too, whatever the program is called");
  assert.equal(denied("something", "Firefox"), "browser");
  assert.equal(denied("anything", "X", ), null);
  assert.equal(windowDenial({ app: "gedit", cls: "Gedit", pid: OWN_PID }, [OWN_PID]), "self");
  assert.equal(windowDenial({ app: "", cls: "Gedit", pid: 5 }, [OWN_PID]), "system", "a window whose program is unknown is never offered");
});

test("a window is told from another by its X id, its process and its class", async () => {
  const { backend, x } = setup();
  assert.equal((await backend.info(ref())).gone, false);
  assert.deepEqual(await backend.info({ ...ref(), cls: "Else" }), { gone: true }, "same id, another class");
  assert.deepEqual(await backend.info({ id: `4a00003:1`, pid: 1, cls: "Gedit" }), { gone: true }, "same id, another process");
  assert.deepEqual(await backend.info({ id: "ffff:4321", pid: 4321, cls: "Gedit" }), { gone: true }, "no such window");
  x.windows.delete(EDITOR.xid);
  assert.deepEqual(await backend.info(ref()), { gone: true });
});

test("front, minimized and covered are read from the window manager, and a window that nothing overlaps is not covered", async () => {
  const over: FakeWindow = { ...FRONT_APP, xid: 0x6000001, x: 150, y: 100, w: 100, h: 100 };
  const { backend, x } = setup();
  const clear = await backend.info(ref());
  assert.ok(!clear.gone);
  if (!clear.gone) { assert.equal(clear.foreground, true); assert.equal(clear.covered, false); assert.equal(clear.minimized, false); assert.deepEqual([clear.width, clear.height], [800, 400]); assert.equal(clear.app, "gedit"); }

  x.windows.set(over.xid, over);
  x.activate(over.xid);
  const covered = await backend.info(ref());
  assert.ok(!covered.gone);
  if (!covered.gone) { assert.equal(covered.foreground, false); assert.equal(covered.covered, true); assert.equal(covered.foregroundPid, 999); }
  // A window above that is somewhere else, or not mapped, covers nothing.
  over.x = 1000;
  assert.equal(((await backend.info(ref())) as { covered: boolean }).covered, false);
  over.x = 150;
  over.mapped = false;
  assert.equal(((await backend.info(ref())) as { covered: boolean }).covered, false);
  over.mapped = true;
  over.hidden = true;
  assert.equal(((await backend.info(ref())) as { covered: boolean }).covered, false);

  x.windows.get(EDITOR.xid)!.hidden = true;
  assert.equal(((await backend.info(ref())) as { minimized: boolean }).minimized, true);
});

test("a picture is taken only of a window nothing covers, scaled to the edge, and a covered or minimized window gets none", async () => {
  const over: FakeWindow = { ...FRONT_APP, xid: 0x6000001, x: 150, y: 100, w: 100, h: 100 };
  const { backend, x } = setup();
  const shot = await backend.capture(ref(), 1568);
  assert.ok(!("gone" in shot));
  if (!("gone" in shot)) {
    assert.ok(shot.image);
    assert.deepEqual([shot.image!.imageWidth, shot.image!.imageHeight, shot.image!.width, shot.image!.height], [784, 392, 800, 400]);
    assert.equal(Buffer.from(shot.image!.base64, "base64").subarray(1, 4).toString(), "PNG");
  }
  const grab = x.calls.find((call) => call.file === "import")!;
  assert.deepEqual(grab.args, ["-window", "0x4a00003", "-resize", "1568x1568>", "png:-"]);
  x.calls.length = 0;
  x.windows.set(over.xid, over);
  x.activate(over.xid);
  const behind = await backend.capture(ref(), 1568);
  assert.ok(!("gone" in behind) && behind.image === undefined && behind.status.covered === true);
  assert.equal(x.calls.some((call) => call.file === "import"), false, "no grab was made");
  x.windows.get(EDITOR.xid)!.hidden = true;
  const minimized = await backend.capture(ref(), 1568);
  assert.ok(!("gone" in minimized) && minimized.image === undefined && minimized.status.minimized === true);
  // Something came over the window while the picture was being taken: the picture is dropped.
  x.windows.get(EDITOR.xid)!.hidden = false;
  x.windows.delete(over.xid);
  x.activate(EDITOR.xid);
  x.onCall((call) => { if (call.file === "import") { x.windows.set(over.xid, over); x.activate(over.xid); } });
  const late = await backend.capture(ref(), 1568);
  assert.ok(!("gone" in late) && late.image === undefined && late.status.covered === true);
  assert.deepEqual(await createX11Backend({ run: x.run }).capture({ id: "ffff:1", pid: 1, cls: "x" }, 100), { gone: true });
});

test("a click is refused before any input unless the window is the same, in front, whole, the size of the picture and the point is inside", async () => {
  const over: FakeWindow = { ...FRONT_APP, xid: 0x6000001, x: 0, y: 0, w: 300, h: 200 };
  const click = { kind: "click" as const, x: 50, y: 60, button: "left" as const, double: false };

  const { backend, x } = setup([over], { activeIsEditor: false });
  // Another program's window is in front: nothing is sent.
  assert.equal((await backend.act(ref(), size, click, OWN_PID)).reason, "not-front");
  // It covers the editor and is in front as well as above: still nothing.
  x.activate(EDITOR.xid);
  x.windows.get(over.xid)!.x = 120;
  x.windows.get(over.xid)!.y = 90;
  x.restack([EDITOR.xid, over.xid]);
  const covered = await backend.act(ref(), size, click, OWN_PID);
  assert.deepEqual([covered.performed, covered.reason], [false, "covered"], "the window is active but something above it covers it");
  x.windows.delete(over.xid);
  x.activate(EDITOR.xid);

  assert.equal((await backend.act(ref(), { width: 801, height: 400 }, click, OWN_PID)).reason, "resized");
  assert.equal((await backend.act(ref(), size, { ...click, x: 800, y: 10 }, OWN_PID)).reason, "outside");
  assert.equal((await backend.act(ref(), size, { ...click, x: -1, y: 10 }, OWN_PID)).reason, "outside");
  assert.equal((await backend.act({ ...ref(), cls: "Else" }, size, click, OWN_PID)).reason, "gone");
  x.windows.get(EDITOR.xid)!.hidden = true;
  assert.equal((await backend.act(ref(), size, click, OWN_PID)).reason, "minimized");
  x.windows.get(EDITOR.xid)!.hidden = false;
  assert.deepEqual(x.inputCalls(), [], "none of those sent input");

  // The point is under another window although the window as a whole is not covered by anything in front of it.
  const popup: FakeWindow = { ...FRONT_APP, xid: 0x6000002, x: 140, y: 130, w: 20, h: 20 };
  x.windows.set(popup.xid, popup);
  x.activate(EDITOR.xid);
  x.restack([EDITOR.xid, popup.xid]);
  x.calls.length = 0;
  const under = await backend.act(ref(), size, { ...click, x: 50, y: 60 }, OWN_PID);
  assert.equal(under.performed, false);
  assert.ok(["covered", "covered-point"].includes(under.reason!));
  assert.deepEqual(x.inputCalls(), []);
});

test("a click puts the pointer on the point, reads it back, clicks, and reports the system's tick of its own input", async () => {
  const { backend, x } = setup();
  const done = await backend.act(ref(), size, { kind: "click", x: 50, y: 60, button: "right", double: false }, OWN_PID);
  assert.equal(done.performed, true, done.reason);
  assert.deepEqual(x.inputCalls().map((call) => call.args), [["mousemove", "--sync", "150", "140"], ["click", "3"]]);
  assert.deepEqual([done.delivered, done.planned], [1, 1]);
  assert.equal(typeof done.sentTick, "number");
  assert.ok(Math.abs(tickDistance(done.sentTick!, x.now() >>> 0)) < 200);
  // A pointer that cannot be put where it was asked stops the action before any click.
  const stuck = setup();
  stuck.x.onCall((call) => { if (call.file === "xdotool" && call.args[0] === "getmouselocation") stuck.x.person("mouse"); });
  const refused = await stuck.backend.act(ref(), size, { kind: "click", x: 50, y: 60, button: "left", double: false }, OWN_PID);
  assert.equal(refused.reason, "cursor-failed");
  assert.equal(stuck.x.inputCalls().some((call) => call.args[0] === "click"), false);
});

test("a double click stops after the first click if the person moved the pointer, and says how much went out", async () => {
  const { backend, x } = setup();
  x.onCall((call) => { if (call.file === "xdotool" && call.args[0] === "click") x.person("mouse"); });
  const done = await backend.act(ref(), size, { kind: "click", x: 50, y: 60, button: "left", double: true }, OWN_PID);
  assert.equal(done.performed, false);
  assert.ok(["cursor-moved", "user-input"].includes(done.reason!), done.reason);
  assert.deepEqual([done.delivered, done.planned], [1, 2]);
  assert.equal(x.inputCalls().filter((call) => call.args[0] === "click").length, 1);
});

test("the person's own input before an action stops it, and the agent's own input does not look like the person's", async () => {
  const { backend, x } = setup();
  const click = { kind: "click" as const, x: 10, y: 10, button: "left" as const, double: false };
  // The host reads the baseline first, as it does before every action.
  const before = await backend.lastInput();
  const first = await backend.act(ref(), size, click, OWN_PID);
  assert.equal(first.performed, true);
  // Between two actions of the agent nothing the person did: the baseline is the agent's own tick, within one timer tick.
  x.advance(300);
  const quiet = await backend.lastInput();
  assert.ok(tickDistance(quiet.inputTick, first.sentTick!) <= INPUT_TICK_MS, `${tickDistance(quiet.inputTick, first.sentTick!)}`);
  assert.ok(tickDistance(first.sentTick!, before.inputTick) >= 0);
  // The person presses a key: the next reading is later than the agent's own input by more than a timer tick.
  x.advance(300);
  x.person("key");
  x.advance(200);
  const loud = await backend.lastInput();
  assert.ok(tickDistance(loud.inputTick, first.sentTick!) > INPUT_TICK_MS);
  // And an action that finds the person's input since it last looked sends nothing.
  x.calls.length = 0;
  x.advance(300);
  x.person("key");
  x.advance(200);
  const refused = await backend.act(ref(), size, click, OWN_PID);
  assert.deepEqual([refused.performed, refused.reason], [false, "user-input"]);
  assert.deepEqual(x.inputCalls(), []);
});

test("the window may be brought back to the front only from Tomverse's own window", async () => {
  const { backend, x } = setup([FRONT_APP], { activeIsEditor: false });
  const click = { kind: "click" as const, x: 400, y: 300, button: "left" as const, double: false };
  assert.equal((await backend.act(ref(), size, click, 12345)).reason, "not-front");
  assert.equal(x.calls.some((call) => call.args[0] === "windowactivate"), false, "another program's window is never put aside");
  x.windows.get(FRONT_APP.xid)!.pid = OWN_PID;
  const done = await backend.act(ref(), size, click, OWN_PID);
  assert.equal(done.performed, true, done.reason);
  assert.ok(x.calls.some((call) => call.args[0] === "windowactivate"));
});

test("keys go out only from the allowed list, as the combination, and Ctrl+V never", async () => {
  const { backend, x } = setup();
  for (const [name, sent] of [["Enter", "Return"], ["ctrl+a", "ctrl+a"], ["ctrl+shift+z", "ctrl+shift+z"], ["shift+Tab", "shift+Tab"], ["PageDown", "Next"], ["Delete", "Delete"], ["ctrl+Left", "ctrl+Left"]] as const) {
    const keys = keyInput(name)!;
    assert.ok(keys, name);
    assert.equal(xdotoolKey(keys), sent, name);
  }
  assert.equal(xdotoolKey({ ctrl: true, shift: false, vk: 0x56 }), null, "Ctrl+V");
  assert.equal(xdotoolKey({ ctrl: false, shift: false, vk: 0x70 }), null, "F1");
  assert.equal(xdotoolKey({ ctrl: false, shift: false, vk: 0x5b }), null, "the Windows key");
  const sentKey = await backend.act(ref(), size, { kind: "key", ctrl: true, shift: false, vk: 0x41 }, OWN_PID);
  assert.equal(sentKey.performed, true);
  assert.deepEqual(x.inputCalls().map((call) => call.args), [["key", "--clearmodifiers", "ctrl+a"]]);
  x.calls.length = 0;
  const paste = await backend.act(ref(), size, { kind: "key", ctrl: true, shift: false, vk: 0x56 }, OWN_PID);
  assert.equal(paste.performed, false);
  assert.deepEqual(x.inputCalls(), [], "no program that sends input was run");
});

test("text is typed in pieces with the window checked between them, after `--`, and stops if the window or the person changes", async () => {
  const text = "x".repeat(60);
  const a = setup();
  const done = await a.backend.act(ref(), size, { kind: "type", text }, OWN_PID);
  assert.deepEqual([done.performed, done.typed], [true, 60]);
  const typed = a.x.inputCalls();
  assert.equal(typed.length, 3, "24 + 24 + 12 characters");
  assert.ok(typed.every((call) => call.args[0] === "type" && call.args[3] === "--" || (call.args[0] === "type" && call.args[1] === "--delay" && call.args[3] === "--")));
  assert.equal(typed.map((call) => call.args[4]).join(""), text);
  // Text that looks like an option is still text.
  const dashed = setup();
  await dashed.backend.act(ref(), size, { kind: "type", text: "-n --version $(id) `id` ; rm -rf /" }, OWN_PID);
  const pieces = dashed.x.inputCalls();
  assert.ok(pieces.every((call) => call.args.slice(0, 4).join(" ") === "type --delay 12 --"));
  assert.equal(pieces.map((call) => call.args[4]).join(""), "-n --version $(id) `id` ; rm -rf /");
  assert.equal(pieces[0]!.args[4]!.startsWith("-n"), true, "a piece that starts with a dash is still text");

  // The window loses the front after the first piece.
  const lost = setup([FRONT_APP]);
  lost.x.onCall((call) => { if (call.file === "xdotool" && call.args[0] === "type") lost.x.activate(FRONT_APP.xid); });
  const stopped = await lost.backend.act(ref(), size, { kind: "type", text }, OWN_PID);
  assert.deepEqual([stopped.performed, stopped.reason, stopped.typed], [false, "focus-lost", 24]);
  assert.equal(lost.x.inputCalls().length, 1);

  // The person presses a key after the first piece.
  const person = setup();
  // Between two pieces: the first has gone out, then the person presses a key before the window is looked at again.
  let afterFirst = false;
  person.x.onCall((call) => {
    if (call.file === "xdotool" && call.args[0] === "type") afterFirst = true;
    else if (afterFirst && call.file === "xprop" && call.args[0] === "-id") { afterFirst = false; person.x.advance(400); person.x.person("key"); person.x.advance(200); }
  });
  const interrupted = await person.backend.act(ref(), size, { kind: "type", text }, OWN_PID);
  assert.deepEqual([interrupted.performed, interrupted.reason, interrupted.typed], [false, "user-input", 24]);
  assert.equal(typeof interrupted.sentTick, "number");

  // Unicode is one character each.
  const unicode = setup();
  const done2 = await unicode.backend.act(ref(), size, { kind: "type", text: "한국어 😀" }, OWN_PID);
  assert.equal(done2.typed, 5);
});

test("a scroll sends a few notches at a time on the wheel buttons, checking the pointer between them", async () => {
  const { backend, x } = setup();
  const done = await backend.act(ref(), size, { kind: "scroll", x: 400, y: 200, dx: -3, dy: 10 }, OWN_PID);
  assert.deepEqual([done.performed, done.delivered, done.planned], [true, 13, 13]);
  const wheel = x.inputCalls().filter((call) => call.args[0] === "click").map((call) => [call.args[2], call.args[5]]);
  assert.deepEqual(wheel, [["4", "5"], ["4", "5"], ["2", "5"], ["3", "6"]]);
  // The person moves the mouse after the first step.
  const other = setup();
  other.x.onCall((call) => { if (call.file === "xdotool" && call.args[0] === "click") other.x.person("mouse"); });
  const stopped = await other.backend.act(ref(), size, { kind: "scroll", x: 400, y: 200, dx: 0, dy: 10 }, OWN_PID);
  assert.equal(stopped.performed, false);
  assert.deepEqual([stopped.delivered, stopped.planned], [4, 10]);
  assert.ok(["cursor-moved", "user-input"].includes(stopped.reason!));
});

test("aborting a request stops it before the next program is run", async () => {
  const { backend, x } = setup();
  const stop = new AbortController();
  x.onCall((call) => { if (call.file === "xdotool" && call.args[0] === "click") stop.abort(); });
  await assert.rejects(backend.act(ref(), size, { kind: "click", x: 5, y: 5, button: "left", double: true }, OWN_PID, stop.signal));
  assert.equal(x.inputCalls().filter((call) => call.args[0] === "click").length, 1, "the second click never went out");
});

test("only the five tools are ever run, and only the window id, numbers and the typed text are in their arguments", async () => {
  const { backend, x } = setup();
  await backend.list();
  await backend.capture(ref(), 800);
  await backend.act(ref(), size, { kind: "click", x: 5, y: 5, button: "left", double: false }, OWN_PID);
  await backend.act(ref(), size, { kind: "type", text: "hello" }, OWN_PID);
  await backend.act(ref(), size, { kind: "scroll", x: 5, y: 5, dx: 0, dy: 1 }, OWN_PID);
  await backend.lastInput();
  assert.deepEqual([...new Set(x.calls.map((call) => call.file))].sort(), ["import", "xdotool", "xprintidle", "xprop", "xwininfo"]);
  for (const call of x.calls.filter((entry) => entry.file === "xdotool" && entry.args[0] !== "type")) {
    assert.ok(call.args.every((arg) => /^(?:-?\d+|0x[0-9a-f]+|--[a-z]+|[a-z]+|ctrl\+[A-Za-z+]+)$/.test(arg)), call.args.join(" "));
  }
});

test("the backend starts only where the app was told to, on an X11 session that has every tool", () => {
  const present = () => true;
  const env = { DISPLAY: ":0", [COMPUTER_UNVERIFIED_LINUX]: "1" };
  assert.ok(createBackendFor("linux", env, present));
  assert.equal(createBackendFor("linux", { DISPLAY: ":0" }, present), null, "never run on a real X server: off unless asked for");
  assert.equal(createBackendFor("linux", { ...env, [COMPUTER_UNVERIFIED_LINUX]: "true" }, present), null);
  assert.equal(createBackendFor("linux", { ...env, XDG_SESSION_TYPE: "wayland" }, present), null);
  assert.equal(createBackendFor("linux", { ...env, WAYLAND_DISPLAY: "wayland-0" }, present), null);
  assert.equal(createBackendFor("linux", { [COMPUTER_UNVERIFIED_LINUX]: "1" }, present), null, "no X display");
  assert.equal(createBackendFor("linux", env, (file) => file !== "xprintidle"), null, "a missing tool means no backend, not a weaker one");
  assert.deepEqual(x11Missing(env, (file) => file !== "xwininfo" && file !== "import"), ["xwininfo", "import"]);
  assert.deepEqual(X11_TOOLS.map(([name]) => name), ["xdotool", "xprop", "xwininfo", "xprintidle", "import"]);
  assert.equal(createBackendFor("darwin", env, present), null, "macOS has none");
  assert.equal(createBackendFor("freebsd", env, present), null);
});
