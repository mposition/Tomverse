import { computerAgentRequest, type ComputerAgentReply, type ComputerAgentRequest } from "../../../tomverse-cli/src/computer-tools";
import { computerCommand, type ComputerCommand, type ComputerNotice, type ComputerResult, type ComputerState, type ComputerWindowRow } from "../computer-contract";
import type { ActOutcome, BackendAction, ComputerBackend, WindowRef } from "./computer-backend";
import { windowDenial } from "./computer-deny";
import { computerRequestRefusal, isUserIntervention, keyInput, mapPoint, partialText, refusalText, type ComputerSelection, type ComputerShot } from "./computer-policy";

/**
 * The host side of the computer tools: the one window the person chose, the screenshot and the input, and every check before the
 * agent touches it. The agent is given the window of its own task, only while the task's run is live and only while the person has
 * not taken control; every request is checked against all of that here, again, before the operating system is asked.
 */

/** The longest side of the picture the agent gets. Larger windows are scaled down; its coordinates are pixels of that picture. */
export const COMPUTER_IMAGE_EDGE = 1568;
/** A mouse or keyboard input newer than this, after the agent's own last input or the person's approval, was the person's. */
export const USER_INPUT_GRACE_MS = 400;
export const COMPUTER_STOP_KEY = "CommandOrControl+Alt+Shift+X";
const MAX_LISTED = 60;

export type ComputerRun = { runId: string | null; taskId: string | null; running: boolean; apiExecution: boolean; suspended: boolean; scope: string | null };

export type ComputerHostDeps = {
  /** The backend of this operating system, or null where there is none (the feature then says it is not supported). */
  createBackend(): ComputerBackend | null;
  /** The person's switch (off by default). */
  enabled(): boolean;
  setEnabled(value: boolean): void;
  run(): ComputerRun;
  /** The processes of Tomverse Desktop itself: their windows are never chosen, and the window may be handed back from them. */
  ownPids(): number[];
  publish(state: ComputerState): void;
  reply(runId: string, requestId: string, reply: ComputerAgentReply): void;
  clean(text: string): string;
  /** The key that stops the agent from anywhere. Returns false when it could not be registered. */
  registerStopKey(handler: () => void): boolean;
  unregisterStopKey(): void;
  now(): number;
};

const fail = (message: string): ComputerAgentReply => ({ status: "error", message });

export function createComputerHost(deps: ComputerHostDeps) {
  let backend: ComputerBackend | null | undefined;
  let selection: ComputerSelection | undefined;
  let shot: ComputerShot | undefined;
  let control: "active" | "stopped" = "active";
  let notice: ComputerNotice | null = null;
  let stopKeyReady = false;
  let busy = 0;
  let baseline = deps.now();
  const inflight = new Set<AbortController>();

  const getBackend = () => (backend === undefined ? (backend = deps.createBackend()) : backend);
  const supported = () => getBackend() !== null;
  const ref = (value: ComputerSelection): WindowRef => ({ id: value.id, pid: value.pid, cls: value.cls });

  function state(): ComputerState {
    return {
      supported: supported(), enabled: deps.enabled(),
      selected: selection ? { id: selection.id, title: deps.clean(selection.title), app: deps.clean(selection.app) } : null,
      control: control === "stopped" ? "stopped" : busy > 0 ? "working" : "idle",
      stopKey: stopKeyReady ? COMPUTER_STOP_KEY.replace("CommandOrControl", "Ctrl") : null, notice,
    };
  }
  const publish = () => deps.publish(state());

  /** `except`: the request that is deciding this itself; it answers with its own reason instead of being cut off. */
  function stopAgent(why: ComputerNotice, except?: AbortController) {
    control = "stopped";
    notice = why;
    for (const item of inflight) if (item !== except) item.abort();
    publish();
  }

  function revoke(except?: AbortController) {
    selection = undefined;
    shot = undefined;
    control = "active";
    for (const item of inflight) if (item !== except) item.abort();
    deps.unregisterStopKey();
    stopKeyReady = false;
  }

  /** The window left: it was closed, or it can no longer be reached. */
  function lost(except?: AbortController) {
    revoke(except);
    notice = "window-closed";
    publish();
  }

  const info = (value: ComputerSelection, title?: string) => ({ id: value.id, title: (title ?? value.title).slice(0, 300), app: value.app.slice(0, 120) });

  /** `phase.sending`: the backend was asked to send input, so a request that ends early may already have done part of it. */
  async function execute(request: ComputerAgentRequest, chosen: ComputerSelection, signal: AbortSignal, self: AbortController, phase: { sending: boolean }): Promise<ComputerAgentReply> {
    const os = getBackend()!;
    const target = ref(chosen);
    if (request.tool === "screenshot") {
      baseline = deps.now();
      const result = await os.capture(target, COMPUTER_IMAGE_EDGE);
      signal.throwIfAborted();
      if ("gone" in result) { lost(self); return fail("The window was closed. Ask the user to choose a window again."); }
      const { status, image } = result;
      const denied = windowDenial({ app: status.app || chosen.app, cls: chosen.cls, pid: chosen.pid }, deps.ownPids());
      if (denied) { lost(self); return fail("That window can no longer be used."); }
      const window = info(chosen, status.title || chosen.title);
      if (status.minimized) return { status: "ok", window, position: "minimized", note: "The window is minimized, so there is no picture. Ask the user to restore it." };
      const position = status.foreground && !status.covered ? "front" : "behind";
      const note = position === "behind" ? "The window is not in front (it is behind another window, or another window covers part of it), so clicks and typing are refused until the user brings it to the front." : undefined;
      if (!image) return { status: "ok", window, position, ...(note ? { note } : {}) };
      shot = { imageWidth: image.imageWidth, imageHeight: image.imageHeight, width: image.width, height: image.height };
      return { status: "ok", window, position, width: image.imageWidth, height: image.imageHeight, image: { mediaType: image.mediaType, base64: image.base64 }, ...(note ? { note } : {}) };
    }

    // An action: look at the window and at the person's own input first.
    if (request.window !== chosen.id) return fail("That is not the window the user chose; nothing was done.");
    let action: BackendAction;
    if (request.tool === "type") {
      if (deps.clean(request.text) !== request.text) return fail("That text looks like a credential and is never typed into a window.");
      action = { kind: "type", text: request.text };
    } else if (request.tool === "key") {
      const keys = keyInput(request.key);
      if (!keys) return fail("That key is not allowed.");
      action = { kind: "key", ...keys };
    } else {
      if (!shot) return fail("Take a screenshot first; coordinates are pixels of the latest picture.");
      const point = mapPoint(shot, request.x, request.y);
      if (!point) return fail("That point is outside the window's picture. Nothing was done.");
      action = request.tool === "click"
        ? { kind: "click", ...point, button: request.button, double: request.double }
        : { kind: "scroll", ...point, dx: request.dx, dy: request.dy };
    }
    const current = await os.info(target);
    signal.throwIfAborted();
    if (current.gone) { lost(self); return fail(refusalText("gone")); }
    if (current.minimized) return fail(refusalText("minimized"));
    // Only Tomverse's own window may hand the front back; a window of any other program in front is the person's.
    if (!current.foreground && !deps.ownPids().includes(current.foregroundPid)) return fail(refusalText("not-front"));
    const idle = await os.idleMs();
    signal.throwIfAborted();
    if (deps.now() - idle > baseline + USER_INPUT_GRACE_MS) {
      stopAgent("user-input", self);
      return fail("The user used the mouse or keyboard, so the agent stopped. Wait for the user to hand control back.");
    }
    const size = shot && (request.tool === "click" || request.tool === "scroll") ? { width: shot.width, height: shot.height } : { width: current.width, height: current.height };
    signal.throwIfAborted();
    phase.sending = true;
    const outcome: ActOutcome = await os.act(target, size, action, process.pid, signal);
    signal.throwIfAborted();
    const reason = outcome.reason ?? "";
    const part = { typed: outcome.typed ?? 0, delivered: outcome.delivered ?? 0, planned: outcome.planned ?? 0 };
    const partial = !outcome.performed && (part.typed > 0 || part.delivered > 0);
    // Only input the agent really sent moves the baseline: a refusal that sent nothing must not hide what the person did meanwhile.
    if (outcome.performed || partial) baseline = deps.now();
    const window = info(chosen, current.title);
    if (outcome.performed) return { status: "ok", window, position: "front", note: "Done." };
    // The pointer or the window was changed under the input: that was the person, so it ends like any other use of the mouse.
    if (isUserIntervention(reason, current.foreground)) {
      stopAgent("user-input", self);
      const stopped = "The user used the mouse or keyboard, so the agent stopped. Wait for the user to hand control back.";
      return partial ? { status: "error", message: `${stopped} ${partialText(reason, part)}`.slice(0, 500), window } : fail(`${stopped} Nothing was done.`);
    }
    if (partial) return { status: "error", message: partialText(reason, part), window };
    return fail(refusalText(reason));
  }

  return {
    state,

    /** Whether a run gets the computer tools: the switch is on, the system is supported, and the window can be chosen at all. */
    toolsAvailable() { return deps.enabled() && supported(); },

    /** One request of the running task's agent. Always answers the runner, with the reason when it does not do what was asked. */
    async handle(event: { runId: string; requestId: string; request: unknown }) {
      const respond = (reply: ComputerAgentReply) => {
        const cleanWindow = (value: { id: string; title: string; app: string }) => ({ ...value, title: deps.clean(value.title), app: deps.clean(value.app) });
        const clean: ComputerAgentReply = reply.status === "error"
          ? { ...reply, message: deps.clean(reply.message), ...(reply.window ? { window: cleanWindow(reply.window) } : {}) }
          : { ...reply, ...(reply.note ? { note: deps.clean(reply.note) } : {}), window: cleanWindow(reply.window) };
        try { deps.reply(event.runId, event.requestId, clean); } catch { /* The task ended before the reply. */ }
      };
      const parsed = computerAgentRequest.safeParse(event.request);
      if (!parsed.success) { respond(fail("The window request was not valid.")); return; }
      const request = parsed.data;
      const run = deps.run();
      const refusal = computerRequestRefusal({
        enabled: deps.enabled(), supported: supported(), eventRunId: event.runId, activeRunId: run.runId, taskId: run.taskId, taskRunning: run.running,
        apiExecution: run.apiExecution, suspended: run.suspended, scope: run.scope, tool: request.tool,
        requestWindow: request.tool === "screenshot" ? null : request.window, selection, control, stopKey: stopKeyReady,
      });
      if (refusal || !selection) { respond(fail(refusal ?? "No window is available for this task.")); return; }
      // The first run of a task adopts the window that was chosen before the task had an id.
      if (selection.taskId === null && run.taskId) selection = { ...selection, taskId: run.taskId };
      const chosen = selection;
      const controller = new AbortController();
      inflight.add(controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(request.tool === "screenshot" ? 30_000 : 20_000)]);
      busy += 1;
      publish();
      let reply: ComputerAgentReply;
      const phase = { sending: false };
      const mayHaveActed = () => phase.sending ? " Part of the action may already have been done: take a screenshot before doing it again." : "";
      try { reply = await execute(request, chosen, signal, controller, phase); }
      catch { reply = fail((controller.signal.aborted ? "The user stopped the agent." : signal.aborted ? "The window did not answer in time." : "The window request could not be completed.") + mayHaveActed()); }
      finally {
        inflight.delete(controller);
        busy -= 1;
      }
      publish();
      // A reply to a run that has ended, or to a task that is no longer this one, is dropped.
      const after = deps.run();
      if (after.runId === event.runId && after.scope === run.scope) respond(controller.signal.aborted ? fail("The user stopped the agent." + mayHaveActed()) : reply);
    },

    /** The person's own commands. Everything about the window is looked up here; the renderer only names an id it was shown. */
    async command(value: unknown): Promise<ComputerResult> {
      const command: ComputerCommand = computerCommand.parse(value);
      if (command.type === "state") return { state: state() };
      if (command.type === "enable") {
        if (command.enabled && !command.confirmed) throw new Error("Confirm that the agent may see and operate the window you choose.");
        if (command.enabled && !supported()) throw new Error("Operating a desktop window is not supported on this operating system.");
        deps.setEnabled(command.enabled);
        if (!command.enabled) {
          revoke();
          notice = null;
          backend?.dispose();
          backend = undefined;
        }
        publish();
        return { state: state() };
      }
      if (command.type === "revoke") { revoke(); notice = null; publish(); return { state: state() }; }
      if (command.type === "take") { stopAgent("taken"); return { state: state() }; }
      if (command.type === "give") {
        if (selection) { control = "active"; notice = null; baseline = deps.now(); }
        publish();
        return { state: state() };
      }
      const os = getBackend();
      if (!deps.enabled() || !os) throw new Error("The computer tools are not turned on.");
      const own = deps.ownPids();
      const rows = await os.list();
      if (command.type === "list") {
        const allowed = rows.filter((row) => !windowDenial(row, own));
        const windows: ComputerWindowRow[] = allowed.slice(0, MAX_LISTED).map((row) => ({ id: row.id, title: deps.clean(row.title).slice(0, 200), app: deps.clean(row.app).slice(0, 80) }));
        return { state: state(), windows, hidden: rows.length - allowed.length };
      }
      // select: the window must be in the list the host reads now and must not be one that is never allowed.
      const wanted = "id" in command ? command.id : "";
      const row = rows.find((candidate) => candidate.id === wanted);
      if (!row || windowDenial(row, own)) throw new Error("That window cannot be chosen.");
      const run = deps.run();
      if (!run.scope) throw new Error("Open a project first.");
      revoke();
      selection = { id: row.id, pid: row.pid, cls: row.cls, title: row.title, app: row.app, scope: run.scope, taskId: run.taskId };
      notice = null;
      baseline = deps.now();
      stopKeyReady = deps.registerStopKey(() => stopAgent("stop-key"));
      if (!stopKeyReady) notice = "stop-key-unavailable";
      // The person has just chosen it: bringing it forward is theirs, and the agent will need it in front.
      try { await os.bringToFront(ref(selection)); } catch { /* The agent is told the window is not in front when it asks. */ }
      baseline = deps.now();
      publish();
      return { state: state() };
    },

    /** The person answered an approval card: their click is not interference. */
    noteApprovalAnswered() { baseline = deps.now(); },

    /** The open task or account changed: a window chosen for another task or account does not carry over. */
    refresh() {
      if (!selection) return;
      const run = deps.run();
      const stale = run.scope !== selection.scope
        || (selection.taskId !== null && run.taskId !== selection.taskId)
        || (selection.taskId === null && run.taskId !== null && !run.running);
      if (stale) { revoke(); notice = null; publish(); }
    },

    /** The run was stopped or ended: whatever the agent was doing in the window ends. */
    abortAll() { for (const item of inflight) item.abort(); },

    dispose() {
      revoke();
      backend?.dispose();
      backend = undefined;
    },
  };
}
