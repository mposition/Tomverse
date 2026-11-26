import assert from "node:assert/strict";
import test from "node:test";
import type { ComputerAgentReply } from "../../tomverse-cli/src/computer-tools";
import type { ComputerState } from "../src/computer-contract";
import { DENIED_CLASSES, DENIED_PROGRAMS, windowDenial } from "../src/host/computer-deny";
import { createComputerHost, USER_INPUT_GRACE_MS, type ComputerHostDeps, type ComputerRun } from "../src/host/computer-host";
import { createFixtureBackend, FIXTURE_BLOCKED, FIXTURE_WINDOW } from "../src/host/computer-fixture-backend";
import { computerRequestRefusal, keyInput, mapPoint, type ComputerGateInput } from "../src/host/computer-policy";

const OWN = 777;

// ── The deny list ─────────────────────────────────────────────────────────

test("windows that can never be chosen: terminals, browsers, password managers, system, prompts, remote control, the desktop shell and Tomverse itself", () => {
  const denied = (app: string, cls = "Anything", pid = 1) => windowDenial({ app, cls, pid }, [OWN]);
  for (const [app, why] of [
    ["cmd", "terminal"], ["powershell", "terminal"], ["pwsh", "terminal"], ["WindowsTerminal", "terminal"], ["wsl", "terminal"], ["bash.exe", "terminal"],
    ["chrome", "browser"], ["msedge", "browser"], ["firefox", "browser"], ["brave", "browser"], ["Opera", "browser"],
    ["1Password", "secrets"], ["Bitwarden", "secrets"], ["KeePassXC", "secrets"], ["lastpass", "secrets"],
    ["SystemSettings", "system"], ["regedit", "system"], ["taskmgr", "system"], ["mmc", "system"], ["ApplicationFrameHost", "system"],
    ["consent", "prompt"], ["LogonUI", "prompt"], ["CredentialUIBroker", "prompt"], ["explorer", "shell"],
    ["mstsc", "remote"], ["AnyDesk", "remote"], ["TeamViewer", "remote"], ["Tomverse", "self"], ["tomverse-desktop", "self"], ["", "system"],
  ] as const) assert.equal(denied(app), why, app);
  assert.equal(denied("anything", "Shell_TrayWnd"), "shell", "the taskbar, by class");
  assert.equal(denied("anything", "Progman"), "shell", "the desktop itself, by class");
  assert.equal(denied("anything", "ConsoleWindowClass"), "terminal");
  assert.equal(denied("anything", "CASCADIA_HOSTING_WINDOW_CLASS"), "terminal");
  assert.equal(denied("renamed", "Chrome_WidgetWin_1", OWN), "self", "Tomverse's own process is refused by process id whatever it is called");
  // Ordinary programs, including Electron apps an agent builds, are allowed.
  for (const [app, cls] of [["fixture-calc", "FixtureWindow"], ["electron", "Chrome_WidgetWin_1"], ["notepad", "Notepad"], ["MyApp", "WindowsForms10.Window.8.app.0.141b42a_r6_ad1"]] as const) {
    assert.equal(denied(app, cls), null, app);
  }
});

test("the deny list is one list with no duplicates, in lower case, and the picker, the selection and the screenshot all read it", () => {
  const names = DENIED_PROGRAMS.map(([name]) => name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => name === name.toLowerCase() && !name.endsWith(".exe")));
  assert.equal(new Set(DENIED_CLASSES.map(([cls]) => cls)).size, DENIED_CLASSES.length);
  for (const required of ["cmd", "powershell", "pwsh", "windowsterminal", "chrome", "msedge", "firefox", "1password", "bitwarden", "keepass", "systemsettings", "taskmgr", "regedit", "consent", "logonui", "explorer"]) {
    assert.ok(names.includes(required), required);
  }
});

// ── Pure decisions ────────────────────────────────────────────────────────

test("a point of the agent's picture maps into the real window and nothing outside the picture is a point", () => {
  const shot = { imageWidth: 200, imageHeight: 100, width: 400, height: 200 };
  assert.deepEqual(mapPoint(shot, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(mapPoint(shot, 100, 50), { x: 200, y: 100 });
  assert.deepEqual(mapPoint(shot, 199, 99), { x: 398, y: 198 });
  for (const [x, y] of [[-1, 0], [0, -1], [200, 0], [0, 100], [1000, 1000], [1.5, 2], [Number.NaN, 0]]) assert.equal(mapPoint(shot, x!, y!), null, `${x},${y}`);
  assert.deepEqual(mapPoint({ imageWidth: 3, imageHeight: 3, width: 4, height: 4 }, 2, 2), { x: 2, y: 2 });
});

test("a key becomes a virtual key only from the allowed list", () => {
  assert.deepEqual(keyInput("ctrl+a"), { ctrl: true, shift: false, vk: 0x41 });
  assert.deepEqual(keyInput("shift+tab"), { ctrl: false, shift: true, vk: 0x09 });
  assert.deepEqual(keyInput("enter"), { ctrl: false, shift: false, vk: 0x0d });
  assert.deepEqual(keyInput("ctrl+shift+z"), { ctrl: true, shift: true, vk: 0x5a });
  for (const refused of ["alt+f4", "win+r", "ctrl+alt+delete", "f5", "ctrl+v", "ctrl+w", "x"]) assert.equal(keyInput(refused), null, refused);
});

const gate = (over: Partial<ComputerGateInput> = {}): ComputerGateInput => ({
  enabled: true, supported: true, eventRunId: "run", activeRunId: "run", taskId: "task", taskRunning: true, apiExecution: true, suspended: false, scope: "acct",
  tool: "click", requestWindow: "w:1", control: "active", stopKey: true,
  selection: { id: "w:1", pid: 5, cls: "C", title: "T", app: "a", scope: "acct", taskId: "task" }, ...over,
});

test("the gate refuses unless the switch, the system, the run, the task, the window, the control and the stop key all agree", () => {
  assert.equal(computerRequestRefusal(gate()), null);
  assert.equal(computerRequestRefusal(gate({ tool: "screenshot", requestWindow: null, stopKey: false })), null, "looking needs no stop key");
  assert.match(computerRequestRefusal(gate({ enabled: false }))!, /not turned on/);
  assert.match(computerRequestRefusal(gate({ supported: false }))!, /not supported/);
  assert.match(computerRequestRefusal(gate({ eventRunId: "other" }))!, /not running/);
  assert.match(computerRequestRefusal(gate({ taskRunning: false }))!, /not running/);
  assert.match(computerRequestRefusal(gate({ apiExecution: false }))!, /not running/);
  assert.match(computerRequestRefusal(gate({ suspended: true }))!, /not running/);
  assert.match(computerRequestRefusal(gate({ scope: null }))!, /No window is available/);
  assert.match(computerRequestRefusal(gate({ selection: undefined }))!, /not chosen a window/);
  assert.match(computerRequestRefusal(gate({ taskId: "another" }))!, /not chosen a window/, "a window chosen for another task does not carry over");
  assert.match(computerRequestRefusal(gate({ scope: "acct2" }))!, /not chosen a window/, "nor to another account");
  assert.equal(computerRequestRefusal(gate({ selection: { ...gate().selection!, taskId: null } })), null, "a window chosen before the task had an id is adopted by it");
  assert.match(computerRequestRefusal(gate({ control: "stopped" }))!, /took control/);
  assert.match(computerRequestRefusal(gate({ requestWindow: "w:2" }))!, /not the window the user chose/);
  assert.match(computerRequestRefusal(gate({ stopKey: false }))!, /stop key/);
});

// ── The host, against a fake desktop ──────────────────────────────────────

type Rig = ReturnType<typeof rig>;
function rig(over: { enabled?: boolean; backend?: boolean; stopKey?: boolean; clean?: (text: string) => string } = {}) {
  const backend = createFixtureBackend();
  let enabled = over.enabled ?? true;
  let clock = 1_000_000;
  let runNow: ComputerRun = { runId: "run", taskId: "task", running: true, apiExecution: true, suspended: false, scope: "acct" };
  const replies: ComputerAgentReply[] = [];
  const states: ComputerState[] = [];
  let stopHandler: (() => void) | undefined;
  const registered: string[] = [];
  const deps: ComputerHostDeps = {
    createBackend: () => (over.backend === false ? null : backend),
    enabled: () => enabled, setEnabled: (value) => { enabled = value; },
    run: () => runNow, ownPids: () => [OWN], publish: (state) => states.push(state),
    reply: (_run, _request, reply) => replies.push(reply), clean: over.clean ?? ((text) => text),
    registerStopKey: (handler) => { if (over.stopKey === false) return false; stopHandler = handler; registered.push("on"); return true; },
    unregisterStopKey: () => { registered.push("off"); stopHandler = undefined; }, now: () => clock,
  };
  const host = createComputerHost(deps);
  const ask = async (request: unknown, runId = "run") => { const before = replies.length; await host.handle({ runId, requestId: "r" + before, request }); return replies.slice(before); };
  return { host, backend, replies, states, registered, ask, tick: (ms: number) => { clock += ms; }, stop: () => stopHandler?.(), setRun: (next: Partial<ComputerRun>) => { runNow = { ...runNow, ...next }; },
    setEnabled: (value: boolean) => { enabled = value; }, hasStopHandler: () => stopHandler !== undefined };
}
const choose = async (r: Rig) => r.host.command({ type: "select", id: FIXTURE_WINDOW.id });
const errorOf = (replies: ComputerAgentReply[]) => (replies[0]!.status === "error" ? replies[0]!.message : "ok");

test("the picker offers only windows that may be chosen and says how many it kept back", async () => {
  const r = rig();
  const listed = await r.host.command({ type: "list" });
  assert.deepEqual(listed.windows?.map((row) => row.title), [FIXTURE_WINDOW.title]);
  assert.equal(listed.hidden, 1, "the browser window is not offered");
});

test("a window that is never allowed cannot be chosen even by its id, and a window that is not in the list cannot either", async () => {
  const r = rig();
  await assert.rejects(() => r.host.command({ type: "select", id: FIXTURE_BLOCKED.id }), /cannot be chosen/);
  await assert.rejects(() => r.host.command({ type: "select", id: "ffff:1" }), /cannot be chosen/);
  await assert.rejects(() => r.host.command({ type: "select", id: "not an id" }));
  assert.equal(r.host.state().selected, null);
});

test("turning the tools on needs the confirmation, and nothing works while they are off or on a system without a backend", async () => {
  const off = rig({ enabled: false });
  await assert.rejects(() => off.host.command({ type: "list" }), /not turned on/);
  assert.equal(off.host.toolsAvailable(), false, "a run gets no computer tools while the switch is off");
  await assert.rejects(() => off.host.command({ type: "enable", enabled: true, confirmed: false }), /Confirm/);
  assert.equal(off.host.toolsAvailable(), false);
  await off.host.command({ type: "enable", enabled: true, confirmed: true });
  assert.equal(off.host.toolsAvailable(), true);
  const none = rig({ backend: false });
  assert.equal(none.host.state().supported, false);
  assert.equal(none.host.toolsAvailable(), false);
  await assert.rejects(() => none.host.command({ type: "enable", enabled: true, confirmed: true }), /not supported/);
  assert.match(errorOf(await none.ask({ tool: "screenshot" })), /not supported/);
});

test("without a chosen window the agent gets a reason and nothing is done", async () => {
  const r = rig();
  assert.match(errorOf(await r.ask({ tool: "screenshot" })), /not chosen a window/);
  assert.match(errorOf(await r.ask({ tool: "click", window: FIXTURE_WINDOW.id, x: 1, y: 1, button: "left", double: false })), /not chosen a window/);
  assert.deepEqual(r.backend.done, []);
});

test("a screenshot is the chosen window only; a click inside it is mapped and done; a point outside the picture is not", async () => {
  const r = rig();
  await choose(r);
  const [shot] = await r.ask({ tool: "screenshot" });
  assert.equal(shot!.status, "ok");
  assert.ok(shot!.status === "ok" && shot.image && shot.width === 200 && shot.height === 120 && shot.position === "front");
  assert.deepEqual(r.states.at(-1)!.selected && [r.states.at(-1)!.selected!.title, r.states.at(-1)!.control], [FIXTURE_WINDOW.title, "idle"]);
  const click = (x: number, y: number) => ({ tool: "click", window: FIXTURE_WINDOW.id, x, y, button: "left", double: false });
  assert.equal((await r.ask(click(100, 60)))[0]!.status, "ok");
  assert.deepEqual(r.backend.done.at(-1), { window: FIXTURE_WINDOW.id, action: { kind: "click", x: 200, y: 120, button: "left", double: false } }, "the point is in the window's own pixels");
  for (const [x, y] of [[200, 10], [10, 120], [5000, 5000]]) assert.match(errorOf(await r.ask(click(x!, y!))), /outside/);
  assert.equal(r.backend.done.length, 1, "nothing outside the picture was clicked");
});

test("an action before any screenshot has no coordinates to map and is refused", async () => {
  const r = rig();
  await choose(r);
  assert.match(errorOf(await r.ask({ tool: "click", window: FIXTURE_WINDOW.id, x: 1, y: 1, button: "left", double: false })), /screenshot first/);
  assert.match(errorOf(await r.ask({ tool: "scroll", window: FIXTURE_WINDOW.id, x: 1, y: 1, dx: 0, dy: 1 })), /screenshot first/);
  assert.equal((await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" }))[0]!.status, "ok", "a key needs no point");
});

test("an action that names another window than the chosen one is not done", async () => {
  const r = rig();
  await choose(r);
  assert.match(errorOf(await r.ask({ tool: "type", window: "3c4d:4243", text: "hi" })), /not the window the user chose/);
  assert.deepEqual(r.backend.done, []);
});

test("the window is not in front: nothing is done, and the same holds when another program's window has the focus", async () => {
  const r = rig();
  await choose(r);
  await r.ask({ tool: "screenshot" });
  r.backend.state.foreground = false;
  const [shot] = await r.ask({ tool: "screenshot" });
  assert.ok(shot!.status === "ok" && shot.position === "behind" && /not in front/.test(shot.note ?? ""), "the screenshot says it is behind");
  assert.match(errorOf(await r.ask({ tool: "type", window: FIXTURE_WINDOW.id, text: "hi" })), /not in front/);
  assert.deepEqual(r.backend.done, [], "nothing reached any window");
  r.backend.state.foreground = true;
  assert.equal((await r.ask({ tool: "type", window: FIXTURE_WINDOW.id, text: "hi" }))[0]!.status, "ok");
});

test("a closed window ends the choice; a minimized or resized one refuses", async () => {
  const r = rig();
  await choose(r);
  await r.ask({ tool: "screenshot" });
  r.backend.state.closed = true;
  assert.match(errorOf(await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" })), /closed/);
  assert.equal(r.host.state().selected, null);
  assert.equal(r.host.state().notice, "window-closed");
});

test("text that looks like a credential is not typed, whatever the CLI did", async () => {
  const r = rig({ clean: (text) => text.replace(/sk-[A-Za-z0-9]{16,}/g, "[redacted]") });
  await choose(r);
  assert.match(errorOf(await r.ask({ tool: "type", window: FIXTURE_WINDOW.id, text: "sk-ABCDEFGHIJKLMNOPQRSTUV" })), /credential/);
  assert.deepEqual(r.backend.done, []);
});

test("a key outside the allowed list is refused by the host too", async () => {
  const r = rig();
  await choose(r);
  const [reply] = await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "alt+f4" });
  assert.equal(reply!.status, "error", "the contract itself does not accept it");
  assert.deepEqual(r.backend.done, []);
});

test("the person touching the mouse or keyboard stops the agent; their approval click does not", async () => {
  const r = rig();
  await choose(r);
  await r.ask({ tool: "screenshot" });
  // The person's last input was a minute ago: fine.
  assert.equal((await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" }))[0]!.status, "ok");
  // They click the approval card, which the host is told about: not interference.
  r.backend.state.idleMs = 5;
  r.host.noteApprovalAnswered();
  assert.equal((await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" }))[0]!.status, "ok");
  // They move the mouse while the agent thinks.
  r.tick(2_000);
  r.backend.state.idleMs = 300;
  const [stopped] = await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" });
  assert.match(errorOf([stopped!]), /used the mouse or keyboard/);
  assert.equal(r.host.state().control, "stopped");
  assert.equal(r.host.state().notice, "user-input");
  assert.equal(r.backend.done.length, 2);
  // Even when the person is idle again, the agent stays stopped until they hand control back.
  r.backend.state.idleMs = 60_000;
  assert.match(errorOf(await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" })), /took control/);
  assert.match(errorOf(await r.ask({ tool: "screenshot" })), /took control/, "it cannot even look");
  await r.host.command({ type: "give" });
  assert.equal(r.host.state().control, "idle");
  assert.equal((await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" }))[0]!.status, "ok");
  assert.ok(USER_INPUT_GRACE_MS > 0);
});

test("Take control stops the agent, and so does the global stop key", async () => {
  const r = rig();
  await choose(r);
  await r.ask({ tool: "screenshot" });
  await r.host.command({ type: "take" });
  assert.equal(r.host.state().control, "stopped");
  assert.match(errorOf(await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" })), /took control/);
  await r.host.command({ type: "give" });
  assert.ok(r.hasStopHandler(), "the stop key is registered while a window is chosen");
  r.stop();
  assert.equal(r.host.state().control, "stopped");
  assert.equal(r.host.state().notice, "stop-key");
  assert.deepEqual(r.backend.done, []);
});

test("without the global stop key the agent can look but does not act", async () => {
  const r = rig({ stopKey: false });
  await choose(r);
  assert.equal(r.host.state().stopKey, null);
  assert.equal(r.host.state().notice, "stop-key-unavailable");
  assert.equal((await r.ask({ tool: "screenshot" }))[0]!.status, "ok");
  assert.match(errorOf(await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" })), /stop key/);
  assert.deepEqual(r.backend.done, []);
});

test("the choice lasts for that task: another task, a finished run's leftovers and revoking all end it", async () => {
  const r = rig();
  await choose(r);
  assert.ok(r.registered.includes("on"));
  r.setRun({ taskId: "other-task" });
  assert.match(errorOf(await r.ask({ tool: "screenshot" })), /not chosen a window/);
  r.host.refresh();
  assert.equal(r.host.state().selected, null);
  assert.ok(r.registered.includes("off"), "the stop key is released with it");
  r.setRun({ taskId: "task" });
  await choose(r);
  await r.host.command({ type: "revoke" });
  assert.equal(r.host.state().selected, null);
  assert.match(errorOf(await r.ask({ tool: "screenshot" })), /not chosen a window/);
});

test("a window chosen before the task had an id belongs to its first run, and not to a task opened from the history", async () => {
  const r = rig();
  r.setRun({ taskId: null, running: false });
  await choose(r);
  r.setRun({ taskId: "new-task", running: true });
  assert.equal((await r.ask({ tool: "screenshot" }))[0]!.status, "ok");
  r.host.refresh();
  assert.ok(r.host.state().selected, "adopted by the running task");
  const other = rig();
  other.setRun({ taskId: null, running: false });
  await choose(other);
  other.setRun({ taskId: "old-task", running: false });
  other.host.refresh();
  assert.equal(other.host.state().selected, null, "opening another task from the history drops it");
});

test("a request of a run that is not the live one, a stopped task or a task that left the Tomverse API path is refused", async () => {
  const r = rig();
  await choose(r);
  assert.match(errorOf(await r.ask({ tool: "screenshot" }, "old-run")), /not running/);
  r.setRun({ apiExecution: false });
  assert.match(errorOf(await r.ask({ tool: "screenshot" })), /not running/);
  r.setRun({ apiExecution: true, running: false });
  assert.match(errorOf(await r.ask({ tool: "screenshot" })), /not running/);
  r.setRun({ running: true });
  assert.equal((await r.ask({ tool: "screenshot" }))[0]!.status, "ok");
  assert.equal((await r.ask({ nonsense: true }))[0]!.status, "error");
});

test("turning the switch off ends the choice and releases the stop key", async () => {
  const r = rig();
  await choose(r);
  await r.host.command({ type: "enable", enabled: false, confirmed: false });
  assert.equal(r.host.state().selected, null);
  assert.equal(r.hasStopHandler(), false);
  assert.match(errorOf(await r.ask({ tool: "screenshot" })), /not turned on/);
});

test("the stop key, Take control and revoking the window abort the input that is being sent and the agent is told it was stopped", async () => {
  for (const how of ["stop-key", "take", "revoke"] as const) {
    const r = rig();
    await choose(r);
    await r.ask({ tool: "screenshot" });
    let seen: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    // A backend that is in the middle of sending input and ends only when it is told to stop.
    r.backend.act = (_window, _size, _action, _handBackFrom, signal) => {
      seen = signal;
      entered();
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    };
    const pending = r.ask({ tool: "click", window: FIXTURE_WINDOW.id, x: 10, y: 10, button: "left", double: true });
    await started;
    assert.ok(seen, `${how}: the backend is given the abort signal`);
    assert.equal(seen.aborted, false);
    if (how === "stop-key") r.stop();
    else if (how === "take") await r.host.command({ type: "take" });
    else await r.host.command({ type: "revoke" });
    assert.equal(seen.aborted, true, `${how}: the signal is aborted at once`);
    assert.match(errorOf(await pending), /stopped/, how);
  }
});

test("a request that is already stopped never reaches the backend's input", async () => {
  const r = rig();
  await choose(r);
  await r.ask({ tool: "screenshot" });
  let called = 0;
  r.backend.act = async () => { called += 1; return { performed: true }; };
  const idle = r.backend.idleMs.bind(r.backend);
  // The stop key is pressed while the host is still reading the person's last input.
  r.backend.idleMs = async () => { r.stop(); return idle(); };
  const replies = await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" });
  assert.equal(replies[0]!.status, "error");
  assert.equal(called, 0);
});

// ── A refusal that the person caused, and an action that went out only in part ──

const CLICK = { tool: "click", window: FIXTURE_WINDOW.id, x: 10, y: 10, button: "left", double: true } as const;

test("a refusal that sent nothing does not move the baseline, so the person's input during the refused call still stops the agent", async () => {
  const r = rig();
  await choose(r);
  await r.ask({ tool: "screenshot" });
  r.backend.act = async () => {
    // The person grabs the mouse a second into the call; the backend then refuses for a standing reason.
    r.tick(1_200);
    r.backend.state.idleMs = 200;
    return { performed: false, reason: "covered-point" };
  };
  const refused = await r.ask(CLICK);
  assert.match(errorOf(refused), /Another window is over that point/);
  assert.equal(r.host.state().control, "idle", "a standing condition is not the person");
  r.tick(500);
  r.backend.state.idleMs = 700;
  assert.match(errorOf(await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" })), /used the mouse or keyboard/);
  assert.equal(r.host.state().control, "stopped");
});

test("a refusal because the pointer, the window or the focus changed under the input is the person's: the agent stops", async () => {
  for (const reason of ["cursor-moved", "moved", "minimized", "focus-lost"]) {
    const r = rig();
    await choose(r);
    await r.ask({ tool: "screenshot" });
    r.backend.act = async () => ({ performed: false, reason });
    const [reply] = await r.ask(CLICK);
    assert.match(errorOf([reply!]), /used the mouse or keyboard, so the agent stopped/, reason);
    assert.match(errorOf([reply!]), /Nothing was done/, reason);
    assert.equal(r.host.state().control, "stopped", reason);
    assert.equal(r.host.state().notice, "user-input", reason);
    assert.match(errorOf(await r.ask({ tool: "key", window: FIXTURE_WINDOW.id, key: "enter" })), /took control/, `${reason}: it stays stopped`);
  }
  // The window left the front between the host's look and the input: the person. Already not in front, but Tomverse may hand it back: not the person.
  const front = rig();
  await choose(front);
  await front.ask({ tool: "screenshot" });
  front.backend.act = async () => ({ performed: false, reason: "not-front" });
  await front.ask(CLICK);
  assert.equal(front.host.state().control, "stopped");
  const handback = rig();
  await choose(handback);
  await handback.ask({ tool: "screenshot" });
  const status = handback.backend.info.bind(handback.backend);
  handback.backend.info = async (window) => { const value = await status(window); return value.gone ? value : { ...value, foreground: false, covered: false, foregroundPid: OWN }; };
  handback.backend.act = async () => ({ performed: false, reason: "not-front" });
  assert.match(errorOf(await handback.ask(CLICK)), /not in front/);
  assert.equal(handback.host.state().control, "idle");
});

test("standing refusals do not stop the agent", async () => {
  for (const reason of ["covered", "covered-point", "resized", "outside", "cursor-failed", "something-new"]) {
    const r = rig();
    await choose(r);
    await r.ask({ tool: "screenshot" });
    r.backend.act = async () => ({ performed: false, reason });
    assert.equal((await r.ask(CLICK))[0]!.status, "error", reason);
    assert.equal(r.host.state().control, "idle", reason);
  }
});

test("a double click or a two-axis scroll that went out in part is reported as partial and is not to be repeated", async () => {
  const r = rig();
  await choose(r);
  await r.ask({ tool: "screenshot" });
  r.backend.act = async () => ({ performed: false, reason: "covered-point", delivered: 1, planned: 2 });
  const [reply] = await r.ask(CLICK);
  assert.equal(reply!.status, "error");
  const message = errorOf([reply!]);
  assert.match(message, /Only part of the action was done: 1 of 2 inputs/);
  assert.match(message, /Do not repeat it; take a screenshot/);
  assert.doesNotMatch(message, /nothing was done/i, "it never says that nothing happened");
  assert.equal(reply!.status === "error" && reply!.window?.id, FIXTURE_WINDOW.id);
  assert.equal(r.host.state().control, "idle", "another window coming over the point is not the person");
  // The same for a scroll, and the person's hand in it still stops the agent while telling what went out.
  r.backend.act = async () => ({ performed: false, reason: "cursor-moved", delivered: 1, planned: 2 });
  const scrolled = errorOf(await r.ask({ tool: "scroll", window: FIXTURE_WINDOW.id, x: 10, y: 10, dx: 3, dy: 3 }));
  assert.match(scrolled, /used the mouse or keyboard, so the agent stopped/);
  assert.match(scrolled, /1 of 2 inputs went out before the mouse pointer was moved away/);
  assert.match(scrolled, /Do not repeat it/);
  assert.equal(r.host.state().control, "stopped");
});

test("typing that stopped part-way says how much was typed, whether the focus left or Windows stopped taking the input", async () => {
  for (const [reason, stops] of [["focus-lost", true], ["input-failed", false]] as const) {
    const r = rig();
    await choose(r);
    await r.ask({ tool: "screenshot" });
    r.backend.act = async () => ({ performed: false, reason, typed: 32 });
    const message = errorOf(await r.ask({ tool: "type", window: FIXTURE_WINDOW.id, text: "x".repeat(100) }));
    assert.match(message, /Only part of the text was typed: 32 characters went in before/, reason);
    assert.match(message, /Do not type it again/, reason);
    assert.equal(r.host.state().control, stops ? "stopped" : "idle", reason);
  }
  // Nothing typed is a plain refusal.
  const none = rig();
  await choose(none);
  await none.ask({ tool: "screenshot" });
  none.backend.act = async () => ({ performed: false, reason: "focus-lost", typed: 0 });
  assert.doesNotMatch(errorOf(await none.ask({ tool: "type", window: FIXTURE_WINDOW.id, text: "abc" })), /Only part/);
});

test("a request that ends while input may be going out tells the agent part of it may be done; one that was only looking does not", async () => {
  const r = rig();
  await choose(r);
  await r.ask({ tool: "screenshot" });
  r.backend.act = async () => { throw new Error("PowerShell ended."); };
  assert.match(errorOf(await r.ask(CLICK)), /could not be completed\. Part of the action may already have been done/);
  r.backend.capture = async () => { throw new Error("no picture"); };
  const looked = errorOf(await r.ask({ tool: "screenshot" }));
  assert.match(looked, /could not be completed/);
  assert.doesNotMatch(looked, /already have been done/);
});
