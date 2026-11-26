import { renderChange, UndoError } from "../../../tomverse-cli/src/runtime.js";
import { remoteCanUndoRecord, remoteUndoChange, remoteViewChange } from "../../../tomverse-cli/src/remote-changes.js";
import { parseRemoteTarget, RemoteError } from "../../../tomverse-cli/src/remote-target.js";
import { RemoteWorkspace } from "../../../tomverse-cli/src/remote-workspace.js";
import type { Journal } from "../../../tomverse-cli/src/session.js";
import type { ChangeInspection } from "../contract";
import type { ProjectRoot } from "./project-root";
import { readRemoteSettings, sshRunnerFor } from "./remote-project";

/**
 * What the Code runtime does for a project on another machine (the parts that are not the agent's own tools): finding the machine,
 * showing and putting back the changes the task made there. The runtime process has a small environment of its own, so what ssh
 * needs (where the person's agent and files are) and the switch arrive through the variables the main process sets.
 */

export class RemoteRunError extends Error {
  constructor(readonly notice: "remoteDisabled" | "remoteUnavailable", message: string) {
    super(message);
  }
}

const fixtureRunner = (text: string | undefined) => {
  try {
    const parsed = text ? JSON.parse(text) as { file?: unknown; args?: unknown } : null;
    if (parsed && typeof parsed.file === "string" && Array.isArray(parsed.args) && parsed.args.every((arg) => typeof arg === "string")) {
      return { file: parsed.file, args: parsed.args as string[] };
    }
  } catch { /* not a fixture */ }
  return undefined;
};

/** Whether remote projects are switched on, as the runtime reads it (the main process refuses first; this is a second lock). */
export const remoteProjectsEnabled = (env: NodeJS.ProcessEnv = process.env) => readRemoteSettings(env.TOMVERSE_DESKTOP_REMOTE_SETTINGS).enabled;

/** Connects to the machine of a remote project. Throws RemoteRunError (switch off) or RemoteError (what is wrong with the connection). */
export async function openRemoteWorkspace(project: ProjectRoot, options: { env?: NodeJS.ProcessEnv; fixtureAllowed: boolean; signal?: AbortSignal }): Promise<RemoteWorkspace> {
  const env = options.env ?? process.env;
  if (!project.remote) throw new RemoteRunError("remoteUnavailable", "This project is not on a remote machine.");
  if (!remoteProjectsEnabled(env)) throw new RemoteRunError("remoteDisabled", "Remote projects are turned off in Settings.");
  const target = parseRemoteTarget(project.remote);
  const runner = sshRunnerFor({
    forwardedEnvironment: env.TOMVERSE_DESKTOP_SSH_ENV,
    fixture: options.fixtureAllowed ? fixtureRunner(env.TOMVERSE_DESKTOP_SSH_FIXTURE) : undefined,
  });
  const remote = new RemoteWorkspace(target, runner);
  await remote.connect(options.signal);
  return remote;
}

/** A change of a remote task, as the change list shows it: where it stands on the remote machine now, its diff, and whether it can be put back. */
export async function inspectRemoteChange(journal: Journal, id: string, project: ProjectRoot, options: {
  clean: (text: string) => string; unknown: boolean; fixtureAllowed: boolean; undoAvailable?: boolean;
}): Promise<ChangeInspection | null> {
  const change = journal.state.changes.find((item) => item.changeId === id);
  if (!change) return null;
  let current = "outside";
  let reachable = false;
  try {
    const remote = await openRemoteWorkspace(project, { fixtureAllowed: options.fixtureAllowed, signal: AbortSignal.timeout(30_000) });
    current = (await remoteViewChange(remote, change, AbortSignal.timeout(30_000))).current;
    reachable = true;
  } catch { /* an unreachable machine shows nothing about the file, and offers no undo */ }
  let text: string | null = null;
  if ((change.state === "applied" || change.state === "undone") && (change.postimage.backup !== undefined || change.postimage.sha256 === null)) {
    try { text = options.clean(renderChange(journal, change)); }
    catch { /* The saved diff may be unavailable on an older record. */ }
  }
  return { current, text, canUndo: reachable && options.undoAvailable !== false && !options.unknown && current === "as_written" && remoteCanUndoRecord(journal, change) };
}

/** Puts one change of a remote task back on the remote machine. */
export async function undoRemoteChange(journal: Journal, id: string, project: ProjectRoot, options: { fixtureAllowed: boolean }): Promise<"undone" | "conflict" | "unavailable"> {
  let remote: RemoteWorkspace;
  try {
    remote = await openRemoteWorkspace(project, { fixtureAllowed: options.fixtureAllowed, signal: AbortSignal.timeout(30_000) });
  } catch {
    return "unavailable";
  }
  try {
    await remoteUndoChange(journal, remote, id, AbortSignal.timeout(60_000), true);
    return "undone";
  } catch (error) {
    if (error instanceof UndoError) return "conflict";
    if (error instanceof RemoteError) throw error;
    throw error;
  }
}
