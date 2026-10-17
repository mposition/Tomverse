import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";

import {
  DM_LAUNCHER_SPECS,
  DM_OUTPUT_SCHEMA_PATH,
  DM_OUTPUT_SCHEMA_SHA256,
  DM_RECORDED_EXECUTION_DIGESTS,
  dmCommandRefusals,
  dmExecutionDigest,
  dmStateTargets,
  dmTransmitIntentRefusal,
  type DmCleanupOutcome,
  type DmCleanupResidue,
  type DmCommand,
  type DmExecutionPlan,
  type DmLaunchRefusal,
  type DmOutputFileRead,
  type DmRequestPaths,
} from "./decisionMakerLauncherCore.ts";
import type { DmInstanceScope } from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker launcher's filesystem half:
 * docs/policy/amux-decision-maker.md policy version 2, §5 (request directory
 * deletion, `cleanup_unknown`) and §5a (root-owned executables and their
 * sha256, the schema file, the managed-settings check, the per-request state
 * deletion and its verification), stage S2-3a.
 *
 * Every policy path is an absolute POSIX path and is used as written on the
 * system host. Tests re-root them under a temporary directory with
 * `dmTestHost()`; the argv, environment and digest never change with the
 * host, only where the filesystem is read. A test host is the only place a
 * caller may supply another expected executable sha256.
 *
 * Nothing here follows a symbolic link it was not asked to: a link where a
 * directory, a kept file or an output file should be is residue or
 * unreadable, never something to read through or delete behind.
 */

export type DmLauncherHost = { readonly root: string | null };

/** Policy paths as written. */
export const DM_SYSTEM_HOST: DmLauncherHost = Object.freeze({ root: null });

/** Policy paths re-rooted under `root`, for tests. */
export const dmTestHost = (root: string): DmLauncherHost => {
  if (typeof root !== "string" || root === "") throw new Error("AMUX Decision Maker test host needs a root");
  return Object.freeze({ root });
};

export const dmHostPath = (host: DmLauncherHost, posixPath: string): string =>
  host.root === null ? posixPath : join(host.root, ...posixPath.split("/").filter((segment) => segment !== ""));

type Probe = { state: "absent" } | { state: "error" } | { state: "present"; stats: Stats };

const probe = (path: string): Probe => {
  try {
    return { state: "present", stats: lstatSync(path) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "error" };
  }
};

/** Opens without following a final symbolic link, where the platform can say so. */
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

/** The sha256 of a regular file, read without following a link; null when it is not one or cannot be read. */
export const dmFileSha256 = (path: string): string | null => {
  const found = probe(path);
  if (found.state !== "present" || !found.stats.isFile()) return null;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    if (!fstatSync(descriptor).isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
};

/**
 * §5a: codex's `-o` file, read once, before cleanup deletes it. A link or
 * anything but a regular file is unreadable: the vendor account writes this
 * file and must not be able to point the launcher at another one.
 */
export const dmReadOutputFile = (path: string, maxBytes: number): DmOutputFileRead => {
  const found = probe(path);
  if (found.state === "absent") return { state: "absent" };
  if (found.state === "error" || !found.stats.isFile()) return { state: "unreadable" };
  if (found.stats.size > maxBytes) return { state: "too_large" };
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    if (!fstatSync(descriptor).isFile()) return { state: "unreadable" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) return { state: "too_large" };
    }
    return { state: "read", bytes: buffer.subarray(0, length) };
  } catch {
    return { state: "unreadable" };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
};

// ---------------------------------------------------------------------------
// §5a: managed settings (claude)
// ---------------------------------------------------------------------------

export const dmManagedSettingsRefusal = (
  host: DmLauncherHost,
  instance: DmInstanceScope,
): "managed_settings_present" | "managed_settings_unverifiable" | null => {
  const directory = DM_LAUNCHER_SPECS[instance].managedSettingsDirectory;
  if (directory === null) return null;
  const found = probe(dmHostPath(host, directory));
  if (found.state === "absent") return null;
  return found.state === "present" ? "managed_settings_present" : "managed_settings_unverifiable";
};

// ---------------------------------------------------------------------------
// §5a: the vendor account's CLI state
// ---------------------------------------------------------------------------

type Walked =
  | { state: "absent" }
  | { state: "residue"; residue: DmCleanupResidue }
  | { state: "present"; hostPath: string; virtualPath: string; stats: Stats };

/** A target under the home, refusing to pass through a link on the way. */
const walkTarget = (host: DmLauncherHost, home: string, relative: string): Walked => {
  const segments = relative.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const virtualPath = `${home}/${segments.slice(0, index).join("/")}`;
    const ancestor = probe(dmHostPath(host, virtualPath));
    if (ancestor.state === "absent") return { state: "absent" };
    if (ancestor.state === "error") return { state: "residue", residue: { kind: "state_unreadable", path: virtualPath } };
    if (ancestor.stats.isSymbolicLink()) {
      return { state: "residue", residue: { kind: "state_ancestor_not_directory", path: virtualPath } };
    }
    // A regular file where a directory would be: the target cannot exist under it.
    if (!ancestor.stats.isDirectory()) return { state: "absent" };
  }
  const virtualPath = `${home}/${relative}`;
  const hostPath = dmHostPath(host, virtualPath);
  const found = probe(hostPath);
  if (found.state === "absent") return { state: "absent" };
  if (found.state === "error") return { state: "residue", residue: { kind: "state_unreadable", path: virtualPath } };
  return { state: "present", hostPath, virtualPath, stats: found.stats };
};

const remove = (hostPath: string) => {
  try {
    rmSync(hostPath, { recursive: true, force: true });
  } catch {
    // Verification decides; a failed delete is residue there.
  }
};

const homeResidue = (host: DmLauncherHost, home: string): DmCleanupResidue | null => {
  const found = probe(dmHostPath(host, home));
  return found.state === "present" && found.stats.isDirectory() && !found.stats.isSymbolicLink()
    ? null
    : { kind: "home_not_directory", path: home };
};

/**
 * §5a: "남김 목록 밖에 아무것도 없음". Everything found under the targets
 * that is not a kept regular file, and anything the walk could not see.
 */
export const dmVerifyCliState = (host: DmLauncherHost, instance: DmInstanceScope): DmCleanupResidue[] => {
  const home = DM_LAUNCHER_SPECS[instance].home;
  const missingHome = homeResidue(host, home);
  if (missingHome) return [missingHome];
  const residue: DmCleanupResidue[] = [];
  for (const target of dmStateTargets(instance)) {
    const walked = walkTarget(host, home, target.path);
    if (walked.state === "absent") continue;
    if (walked.state === "residue") {
      residue.push(walked.residue);
      continue;
    }
    if (target.kind === "whole") {
      residue.push({ kind: "state_entry_present", path: walked.virtualPath });
      continue;
    }
    if (walked.stats.isSymbolicLink() || !walked.stats.isDirectory()) {
      residue.push({ kind: "state_root_not_directory", path: walked.virtualPath });
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(walked.hostPath);
    } catch {
      residue.push({ kind: "state_unreadable", path: walked.virtualPath });
      continue;
    }
    for (const name of names.sort()) {
      const virtualPath = `${walked.virtualPath}/${name}`;
      if (!target.keep.includes(name)) {
        residue.push({ kind: "state_entry_present", path: virtualPath });
        continue;
      }
      const kept = probe(join(walked.hostPath, name));
      if (kept.state !== "present" || !kept.stats.isFile()) {
        residue.push({ kind: "state_keep_not_regular_file", path: virtualPath });
      }
    }
  }
  return residue;
};

/**
 * §5a "요청마다 지운다": delete every target but the kept authentication file.
 * A target reached through a link, a state root that is not a real directory
 * and a kept entry that is not a regular file are left alone -- they are
 * residue for verification to report, not something to delete behind.
 */
export const dmDeleteCliState = (host: DmLauncherHost, instance: DmInstanceScope): void => {
  const home = DM_LAUNCHER_SPECS[instance].home;
  if (homeResidue(host, home)) return;
  for (const target of dmStateTargets(instance)) {
    const walked = walkTarget(host, home, target.path);
    if (walked.state !== "present") continue;
    if (target.kind === "whole") {
      remove(walked.hostPath);
      continue;
    }
    if (walked.stats.isSymbolicLink() || !walked.stats.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(walked.hostPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!target.keep.includes(name)) remove(join(walked.hostPath, name));
    }
  }
};

// ---------------------------------------------------------------------------
// §5: the request's own directories
// ---------------------------------------------------------------------------

/** The request directory exists; the temporary directory exists and is empty (so no stale `-o` file). */
export const dmRequestDirectoriesUsable = (host: DmLauncherHost, paths: DmRequestPaths): boolean => {
  const request = probe(dmHostPath(host, paths.requestDirectory));
  if (request.state !== "present" || !request.stats.isDirectory()) return false;
  const temporary = probe(dmHostPath(host, paths.temporaryDirectory));
  if (temporary.state !== "present" || !temporary.stats.isDirectory()) return false;
  try {
    return readdirSync(dmHostPath(host, paths.temporaryDirectory)).length === 0;
  } catch {
    return false;
  }
};

export const dmDeleteRequestPaths = (host: DmLauncherHost, paths: DmRequestPaths): void => {
  remove(dmHostPath(host, paths.requestDirectory));
  remove(dmHostPath(host, paths.temporaryDirectory));
};

export const dmVerifyRequestPaths = (host: DmLauncherHost, paths: DmRequestPaths): DmCleanupResidue[] =>
  [paths.requestDirectory, paths.temporaryDirectory].flatMap((path): DmCleanupResidue[] => {
    const found = probe(dmHostPath(host, path));
    if (found.state === "absent") return [];
    return [{ kind: found.state === "error" ? "request_path_unreadable" : "request_path_present", path }];
  });

/**
 * §5 and §5a, on every exit path: delete the request's directories and the
 * account's CLI state, then check that nothing outside the kept file is left.
 * Anything left, or anything that could not be checked, is
 * `cleanup_unknown` -- which §5 turns into the instance's `off` latch (the
 * app's, not this module's). Paths that failed validation cannot be deleted
 * safely and are reported as such.
 */
export const dmCleanup = (
  host: DmLauncherHost,
  instance: DmInstanceScope,
  paths: DmRequestPaths | null,
): DmCleanupOutcome => {
  if (paths !== null) dmDeleteRequestPaths(host, paths);
  dmDeleteCliState(host, instance);
  const residue: DmCleanupResidue[] = [
    ...(paths === null ? [{ kind: "request_paths_invalid" as const, path: "" }] : dmVerifyRequestPaths(host, paths)),
    ...dmVerifyCliState(host, instance),
  ];
  return residue.length === 0 ? { status: "verified" } : { status: "cleanup_unknown", residue };
};

// ---------------------------------------------------------------------------
// The preflight
// ---------------------------------------------------------------------------

export type DmPreflightInput = {
  plan: DmExecutionPlan;
  /** The exact command the launcher would start. */
  command: DmCommand;
  evidence: unknown;
  requestKey: unknown;
  payload: Uint8Array;
};

/** Only a test host may expect another executable than §5a's. */
export const dmExpectedExecutableSha256 = (
  host: DmLauncherHost,
  instance: DmInstanceScope,
  override: string | undefined,
): string => {
  if (override === undefined) return DM_LAUNCHER_SPECS[instance].executableSha256;
  if (host.root === null) throw new Error("AMUX Decision Maker executable sha256 is fixed on the system host");
  return override;
};

/**
 * Every check of §5 and §5a that must pass before a process starts, all of
 * them run, every failure reported. An empty list is the only permission to
 * start.
 */
export const dmPreflightRefusals = (
  host: DmLauncherHost,
  input: DmPreflightInput,
  options: { expectedExecutableSha256?: string } = {},
): DmLaunchRefusal[] => {
  const { plan } = input;
  const expectedExecutable = dmExpectedExecutableSha256(host, plan.instance, options.expectedExecutableSha256);
  const refusals: DmLaunchRefusal[] = [];
  if (dmExecutionDigest(plan.instance) !== DM_RECORDED_EXECUTION_DIGESTS[plan.instance]) {
    refusals.push("execution_digest_mismatch");
  }
  const executable = dmFileSha256(dmHostPath(host, plan.executable));
  if (executable === null) refusals.push("executable_unreadable");
  else if (executable !== expectedExecutable) refusals.push("executable_sha256_mismatch");
  const schema = dmFileSha256(dmHostPath(host, DM_OUTPUT_SCHEMA_PATH));
  if (schema === null) refusals.push("schema_unreadable");
  else if (schema !== DM_OUTPUT_SCHEMA_SHA256) refusals.push("schema_sha256_mismatch");
  const managed = dmManagedSettingsRefusal(host, plan.instance);
  if (managed) refusals.push(managed);
  if (dmVerifyCliState(host, plan.instance).length > 0) refusals.push("cli_state_residue");
  if (!dmRequestDirectoriesUsable(host, plan.paths)) refusals.push("request_directories_unusable");
  const intent = dmTransmitIntentRefusal(plan.instance, input.evidence, input.requestKey, input.payload);
  if (intent) refusals.push(intent);
  refusals.push(...dmCommandRefusals(plan, input.command));
  return refusals;
};
