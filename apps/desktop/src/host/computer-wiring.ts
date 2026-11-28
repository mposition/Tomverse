import { createBackendFor } from "./computer-platform";
import { createComputerHost, COMPUTER_STOP_KEY, type ComputerHostDeps } from "./computer-host";
import { createBrowserAgentSwitch } from "./code-browser-switch";
import type { ComputerBackend } from "./computer-backend";
import type { ComputerState } from "../computer-contract";

/**
 * Connects the computer host to Electron: the person's switch (a file in the user-data folder, off by default), the global stop key,
 * the window that shows the state, and the test fixture. main.ts only passes in what it owns.
 */
export function createDesktopComputer(env: {
  switchFile: () => string;
  /** A test descriptor asked for the fake desktop (only ever true in a fixture build). */
  fixtureBackend: () => ComputerBackend | null;
  shortcuts: { register(accelerator: string, handler: () => void): boolean; unregister(accelerator: string): void };
  send(state: ComputerState): void;
  run: ComputerHostDeps["run"];
  reply: ComputerHostDeps["reply"];
  clean: ComputerHostDeps["clean"];
}) {
  const person = createBrowserAgentSwitch(env.switchFile);
  const fake = () => env.fixtureBackend();
  const host = createComputerHost({
    createBackend: () => fake() ?? createBackendFor(process.platform),
    // A fixture that brought its own desktop does not need the switch; every request is still checked.
    enabled: () => person.enabled || fake() !== null,
    setEnabled: (value) => person.set(value),
    run: env.run,
    ownPids: () => [process.pid],
    publish: env.send,
    reply: env.reply,
    clean: env.clean,
    registerStopKey: (handler) => { try { return env.shortcuts.register(COMPUTER_STOP_KEY, handler); } catch { return false; } },
    unregisterStopKey: () => { try { env.shortcuts.unregister(COMPUTER_STOP_KEY); } catch { /* Not registered. */ } },
    now: () => Date.now(),
  });
  return { host, load: () => person.load() };
}
