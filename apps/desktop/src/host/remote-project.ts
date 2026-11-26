import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { createSshRunner, sshEnvironment, type SshRunner } from "../../../tomverse-cli/src/remote-ssh.js";
import { parseRemoteTarget, RemoteError, targetKey, type RemoteTarget } from "../../../tomverse-cli/src/remote-target.js";
import { RemoteWorkspace } from "../../../tomverse-cli/src/remote-workspace.js";
import type { RemoteFailure, RemoteRecent, RemoteResult } from "../remote-contract";

/**
 * Remote projects in the Desktop app: the switch, the recent list, the local "shadow" folder that stands for a remote project in
 * everything that keeps a folder (history, locks, permission rules, memory), and the connection test.
 *
 * A remote project's files are not on this computer. Its shadow is an empty folder of the app's own, one per target and remote
 * folder, with a marker that says which one. Nothing the agent reads or writes is ever looked for there: the tools of a remote
 * project go to the remote machine (tomverse-cli/src/remote-tools.ts), and anything that would work on a local folder (a terminal,
 * the review panel, Git, attaching files) is not offered for it.
 */

export type RemoteSettings = { enabled: boolean; recent: RemoteRecent[] };

const SETTINGS = "settings.json";
const MAX_RECENT = 8;

export function readRemoteSettings(directory: string | undefined): RemoteSettings {
  const off: RemoteSettings = { enabled: false, recent: [] };
  if (!directory) return off;
  try {
    const parsed = JSON.parse(readFileSync(join(directory, SETTINGS), "utf8")) as { enabled?: unknown; recent?: unknown };
    const recent: RemoteRecent[] = [];
    if (Array.isArray(parsed.recent)) {
      for (const item of parsed.recent.slice(0, MAX_RECENT)) {
        try {
          const target = parseRemoteTarget(item as Record<string, unknown>);
          recent.push({ destination: target.destination, ...(target.port !== undefined ? { port: target.port } : {}), folder: target.folder });
        } catch { /* a recent entry that is no longer a valid target is dropped */ }
      }
    }
    return { enabled: parsed.enabled === true, recent };
  } catch {
    return off;
  }
}

export function writeRemoteSettings(directory: string, settings: RemoteSettings) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, SETTINGS);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ enabled: settings.enabled, recent: settings.recent.slice(0, MAX_RECENT) }), { mode: 0o600 });
  renameSync(temporary, file);
}

/** The target moves to the front of the recent list. */
export const withRecent = (settings: RemoteSettings, target: RemoteTarget): RemoteSettings => {
  const entry: RemoteRecent = { destination: target.destination, ...(target.port !== undefined ? { port: target.port } : {}), folder: target.folder };
  const key = targetKey(target);
  return { ...settings, recent: [entry, ...settings.recent.filter((item) => targetKey(item) !== key)].slice(0, MAX_RECENT) };
};

// ── The shadow folder ──────────────────────────────────────────────────────

const MARKER = ".tomverse-remote.json";
let shadowBase: string | null = null;

/** Where the shadow folders live (the app's own folder, outside any project). Set once by the main process and by the runtime. */
export const setRemoteShadowBase = (directory: string | undefined) => {
  shadowBase = directory ? directory : null;
};

const shadowName = (target: RemoteTarget) => createHash("sha256").update(targetKey(target)).digest("hex").slice(0, 24);

/** Makes (or finds) the shadow folder of a target and returns its real path. */
export function ensureRemoteShadow(target: RemoteTarget): string {
  if (!shadowBase) throw new Error("The remote project folder is unavailable.");
  mkdirSync(shadowBase, { recursive: true, mode: 0o700 });
  const base = realpathSync(shadowBase);
  const folder = join(base, shadowName(target));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const marker = join(folder, MARKER);
  const text = JSON.stringify({ version: 1, destination: target.destination, ...(target.port !== undefined ? { port: target.port } : {}), folder: target.folder });
  if (!existsSync(marker) || readFileSync(marker, "utf8") !== text) writeFileSync(marker, text, { mode: 0o600 });
  return realpathSync(folder);
}

/**
 * The remote target a folder stands for, when it is one of this app's shadow folders; null for every other folder. Only a direct
 * child of the shadow base counts, and its marker must name the target its own folder name was made from, so a marker placed in a
 * project folder (or copied to another shadow) makes nothing remote.
 */
export function remoteOfPath(canonical: string): RemoteTarget | null {
  if (!shadowBase) return null;
  try {
    const base = realpathSync(shadowBase);
    const rel = relative(base, canonical);
    if (!rel || rel.startsWith("..") || rel.includes(sep) || rel.includes("/")) return null;
    const parsed = JSON.parse(readFileSync(join(canonical, MARKER), "utf8")) as Record<string, unknown>;
    if (parsed.version !== 1) return null;
    const target = parseRemoteTarget(parsed);
    return shadowName(target) === basename(canonical) && dirname(canonical) === base ? target : null;
  } catch {
    return null;
  }
}

export const isRemoteShadow = (path: string | null | undefined) => {
  if (!path) return false;
  try {
    return statSync(path).isDirectory() && remoteOfPath(realpathSync(path)) !== null;
  } catch {
    return false;
  }
};

// ── Running ssh ────────────────────────────────────────────────────────────

/** What the main process hands the runtime so its ssh finds the person's agent and files (the runtime's own environment is small). */
export const sshEnvironmentForRuntime = (env: NodeJS.ProcessEnv = process.env) => JSON.stringify(sshEnvironment(env));

/**
 * The runner that starts the person's own ssh. A test (a desktop fixture) can name a stand-in program instead; that is read only where
 * fixtures are allowed at all, by the caller.
 */
export function sshRunnerFor(options: { forwardedEnvironment?: string; fixture?: { file: string; args: string[] } } = {}): SshRunner {
  let env: Record<string, string> = {};
  try {
    const parsed = options.forwardedEnvironment ? JSON.parse(options.forwardedEnvironment) as Record<string, unknown> : {};
    env = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { /* an unreadable list forwards nothing */ }
  return options.fixture
    ? createSshRunner({ file: options.fixture.file, prefixArgs: options.fixture.args, env })
    : createSshRunner({ env });
}

// ── Describing a failure ───────────────────────────────────────────────────

const KNOWN = new Set<string>([
  "invalid-target", "ssh-missing", "auth", "host-key", "host-key-changed", "name-not-found", "unreachable", "timeout", "connection-lost",
  "folder-missing", "not-a-folder", "folder-too-broad", "unsupported-remote", "protocol",
]);

export function describeRemoteFailure(error: unknown): Extract<RemoteResult, { ok: false }> {
  if (error instanceof RemoteError) {
    const failure: RemoteFailure = KNOWN.has(error.code) ? (error.code as RemoteFailure) : error.code === "not-found" ? "folder-missing" : "failed";
    return { ok: false, failure, message: error.message.slice(0, 600) };
  }
  return { ok: false, failure: "failed", message: String((error as Error)?.message ?? error).slice(0, 600) };
}

/** What the "Test connection" button does: connect, find the folder, say what is wrong in a way the person can fix. Changes nothing remote. */
export async function testRemote(target: RemoteTarget, runner: SshRunner, signal?: AbortSignal): Promise<RemoteResult> {
  try {
    const probe = await new RemoteWorkspace(target, runner).connect(signal);
    return { ok: true, system: probe.os, folder: probe.root };
  } catch (error) {
    return describeRemoteFailure(error);
  }
}
