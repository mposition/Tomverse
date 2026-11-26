import { parseRemoteTarget, RemoteError, targetLabel, type RemoteTarget } from "../../../tomverse-cli/src/remote-target.js";
import type { SshRunner } from "../../../tomverse-cli/src/remote-ssh.js";
import type { RemoteConnectionState, RemoteProjectInput, RemoteProjectReply, RemoteResult, RemoteSnapshot, RemoteView } from "../remote-contract";
import { bindProjectRoot, type ProjectRoot } from "./project-root";
import { describeRemoteFailure, ensureRemoteShadow, readRemoteSettings, testRemote, withRecent, writeRemoteSettings } from "./remote-project";

/**
 * The main process side of the remote-project screen: the switch, the connection test, opening a remote folder as the project and
 * reconnecting. Every request is checked here whatever the screen sent; with the switch off nothing here starts ssh.
 */

export type RemoteHostDeps = {
  settingsDirectory(): string;
  /** The runner that starts the person's ssh in this process. */
  runner(): SshRunner;
  /** The OS command sandbox is switched on (so commands of a remote project, which it cannot cover, are worth a word). */
  sandboxOn(): boolean;
  /** Nothing is running or being chosen: the project may change. */
  canChange(): boolean;
  /** Makes the project the open one. False when the window refused (a task started meanwhile). */
  open(project: ProjectRoot, target: RemoteTarget): Promise<boolean>;
  /** The open project, when it is a remote one. */
  current(): { project: ProjectRoot; target: RemoteTarget } | null;
  changed(): void;
};

export function createRemoteProjectHost(deps: RemoteHostDeps) {
  /** What was last known of the machine of the open remote project. */
  let connection: RemoteConnectionState = "unknown";
  let key = "";
  let working = false;

  const settings = () => readRemoteSettings(deps.settingsDirectory());
  /** The switch, read once: the window asks on every update. */
  let enabledNow: boolean | null = null;
  const enabled = () => (enabledNow ??= settings().enabled);
  const keyOf = (target: RemoteTarget) => `${target.destination}|${target.port ?? ""}|${target.folder}`;
  const state = (): RemoteConnectionState => {
    const current = deps.current();
    return current && keyOf(current.target) === key ? connection : "unknown";
  };

  const snapshot = (): RemoteSnapshot | null => {
    const current = deps.current();
    return current ? { label: targetLabel(current.target), folder: current.target.folder, state: state(), sandboxOutside: deps.sandboxOn() } : null;
  };

  const view = (): RemoteView => {
    const saved = settings();
    const current = deps.current();
    return {
      enabled: enabled(), recent: saved.recent,
      current: current ? { label: targetLabel(current.target), folder: current.target.folder, state: state() } : null,
      sandboxOutside: deps.sandboxOn(),
    };
  };

  const parse = (input: { destination: string; port?: string | number; folder: string }): { target: RemoteTarget } | { result: RemoteResult } => {
    try {
      return { target: parseRemoteTarget(input) };
    } catch (error) {
      return { result: error instanceof RemoteError ? describeRemoteFailure(error) : { ok: false, failure: "invalid-target", message: "The target is not valid." } };
    }
  };

  const remember = (target: RemoteTarget, next: RemoteConnectionState) => {
    key = keyOf(target);
    connection = next;
    deps.changed();
  };

  return {
    view,
    snapshot,
    enabled,
    /** A task of the open remote project saw the connection go. */
    markLost() {
      const current = deps.current();
      if (current) remember(current.target, "lost");
    },
    async run(input: RemoteProjectInput): Promise<RemoteProjectReply> {
      if (input.action === "read") return { view: view() };
      if (input.action === "set-enabled") {
        if (!deps.canChange()) return { view: view(), result: { ok: false, failure: "busy", message: "A task is running." } };
        writeRemoteSettings(deps.settingsDirectory(), { ...settings(), enabled: input.enabled });
        enabledNow = input.enabled;
        deps.changed();
        return { view: view() };
      }
      if (!enabled()) return { view: view(), result: { ok: false, failure: "disabled", message: "Remote projects are turned off." } };
      if (working) return { view: view(), result: { ok: false, failure: "busy", message: "Another connection is being tested." } };
      working = true;
      try {
        if (input.action === "reconnect") {
          const current = deps.current();
          if (!current) return { view: view() };
          const result = await testRemote(current.target, deps.runner(), AbortSignal.timeout(60_000));
          remember(current.target, result.ok ? "connected" : "lost");
          return { view: view(), result };
        }
        const parsed = parse(input.target);
        if ("result" in parsed) return { view: view(), result: parsed.result };
        const { target } = parsed;
        if (input.action === "open" && !deps.canChange()) return { view: view(), result: { ok: false, failure: "busy", message: "A task is running." } };
        const result = await testRemote(target, deps.runner(), AbortSignal.timeout(60_000));
        if (input.action === "test") {
          const current = deps.current();
          if (current && keyOf(current.target) === keyOf(target)) remember(target, result.ok ? "connected" : "lost");
          return { view: view(), result };
        }
        if (!result.ok) return { view: view(), result };
        // The same folder, as the machine itself names it: the real path decides what the project is.
        const real = parseRemoteTarget({ ...target, folder: result.folder });
        const project = bindProjectRoot(ensureRemoteShadow(real));
        if (!project.remote) return { view: view(), result: { ok: false, failure: "failed", message: "The remote project could not be set up on this computer." } };
        if (!deps.canChange() || !(await deps.open(project, real))) return { view: view(), result: { ok: false, failure: "busy", message: "A task is running." } };
        writeRemoteSettings(deps.settingsDirectory(), withRecent(settings(), real));
        remember(real, "connected");
        return { view: view(), result };
      } catch (error) {
        return { view: view(), result: describeRemoteFailure(error) };
      } finally {
        working = false;
      }
    },
  };
}
