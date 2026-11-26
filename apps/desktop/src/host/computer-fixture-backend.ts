import type { ActOutcome, BackendAction, ComputerBackend, RawWindow, WindowImage, WindowRef, WindowStatus } from "./computer-backend";

/**
 * A fake desktop for the tests: two windows, a picture, and a list of what was done to them. Only a test descriptor turns it on
 * (the same gate as the other fixtures); it never touches the real desktop.
 */

/** One transparent pixel; the picture's declared size is what the coordinates are measured in. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const FIXTURE_WINDOW: RawWindow = { id: "1a2b:4242", pid: 4242, cls: "FixtureWindow", title: "Fixture calculator", app: "fixture-calc" };
export const FIXTURE_BLOCKED: RawWindow = { id: "3c4d:4243", pid: 4243, cls: "Chrome_WidgetWin_1", title: "Fixture bank", app: "chrome" };

/** `inputTick`: when the system last saw input, on the same clock as `clock`. `userInput(agoMs)`: the person's input, `agoMs` before now. */
export type FixtureComputer = ComputerBackend & {
  done: Array<{ window: string; action: BackendAction }>;
  state: { foreground: boolean; inputTick: number; closed: boolean };
  userInput(agoMs?: number): void;
};

/** `clock`: the system's millisecond tick; a test passes the one its host clock runs on, so both move together. */
export function createFixtureBackend(clock: () => number = () => Date.now() >>> 0): FixtureComputer {
  const done: FixtureComputer["done"] = [];
  const state = { foreground: true, inputTick: (clock() - 60_000) >>> 0, closed: false };
  const status = (): WindowStatus => ({ gone: false, title: FIXTURE_WINDOW.title, app: FIXTURE_WINDOW.app, minimized: false, foreground: state.foreground,
    covered: !state.foreground, foregroundPid: state.foreground ? FIXTURE_WINDOW.pid : 1, width: 400, height: 240 });
  const known = (window: WindowRef) => window.id === FIXTURE_WINDOW.id && !state.closed;
  return {
    done, state,
    userInput(agoMs = 0) { state.inputTick = (clock() - agoMs) >>> 0; },
    async list() { return state.closed ? [FIXTURE_BLOCKED] : [FIXTURE_WINDOW, FIXTURE_BLOCKED]; },
    async info(window) { return known(window) ? status() : { gone: true }; },
    async capture(window) {
      if (!known(window)) return { gone: true as const };
      const image: WindowImage = { mediaType: "image/png", base64: PIXEL, imageWidth: 200, imageHeight: 120, width: 400, height: 240 };
      return { status: status(), image };
    },
    async act(window, _size, action, _handBackFrom, signal): Promise<ActOutcome> {
      signal?.throwIfAborted();
      if (!known(window)) return { performed: false, reason: "gone" };
      if (!state.foreground) return { performed: false, reason: "not-front" };
      done.push({ window: window.id, action });
      // The agent's own input is input the system sees: it is the last one, and its tick is what the agent reports.
      const sentTick = clock() >>> 0;
      state.inputTick = sentTick;
      return { performed: true, sentTick };
    },
    async bringToFront() { return true; },
    async lastInput() { return { idleMs: Math.max(0, clock() - state.inputTick), inputTick: state.inputTick }; },
    dispose() { /* Nothing is held. */ },
  };
}
