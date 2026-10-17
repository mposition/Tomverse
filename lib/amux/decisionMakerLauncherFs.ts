import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import {
  DM_LAUNCHER_SPECS,
  DM_OUTPUT_SCHEMA_PATH,
  DM_OUTPUT_SCHEMA_SHA256,
  DM_RECORDED_EXECUTION_DIGESTS,
  DM_REQUEST_ROOT,
  DM_SYSTEM_PATH_OWNERS,
  dmCommandRefusals,
  dmExecutionDigest,
  dmRequestPaths,
  dmScratchRoot,
  dmStateTargets,
  dmTransmitIntentRefusal,
  type DmCleanupOutcome,
  type DmCleanupResidue,
  type DmCleanupResidueKind,
  type DmCommand,
  type DmExecutionPlan,
  type DmLaunchRefusal,
  type DmOutputFileRead,
  type DmPathOwners,
} from "./decisionMakerLauncherCore.ts";
import { isDmRequestId } from "./decisionMakerRequestCore.ts";
import type { DmInstanceScope } from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker launcher's filesystem half:
 * docs/policy/amux-decision-maker.md policy version 2, §5 (request directory
 * deletion, `cleanup_unknown`) and §5a (root-owned executables and their
 * sha256, the schema file, the managed-settings check, the per-request state
 * deletion and its verification), stage S2-3a.
 *
 * Paths. A request names no path: its two directories are fixed roots plus
 * its id (lib/amux/decisionMakerLauncherCore.ts `dmRequestPaths`). Every
 * directory from `/` down to whatever is read, created or deleted is checked
 * on the way, with `lstat`: it must be a directory and not a link, belong to
 * the owner S0 gave it (root above the roots, the broker for the request
 * root and its directories, the vendor account for its home and everything
 * in it), and not be writable by its group or others -- the account's home,
 * scratch root and temporary directories not readable by them either. A
 * directory that fails is residue (`path_unsafe`): nothing is read through it
 * and nothing under it is deleted.
 *
 * Deletion. An entry is first renamed aside within its checked parent, so the
 * name a request used no longer leads to it; a link is then unlinked, never
 * followed, and a directory is opened without following links and compared
 * with what was renamed before it is removed.
 *
 * What remains. Node has no `openat`/`unlinkat`, so the checks and the
 * recursive removal go by path. Between a check and the next step, whoever
 * can write a checked directory can swap what is in it -- and the checks are
 * what make that only root or the account doing the deletion (the broker for
 * the request directory, the vendor account for its temporary directory and
 * CLI state). Inside the tree being removed the same holds: only that account
 * or root can write it. So a race can redirect a deletion only for someone
 * who could already delete the target themselves. The broker must therefore
 * delete only the request directory and the vendor account only its own
 * temporary directory and state; the two cleanups are separate functions for
 * that reason.
 *
 * Tests re-root the policy paths under a temporary directory with
 * `dmTestHost()`, whose owners are the test process's own uid. A test host
 * is the only place a caller may supply another expected executable sha256.
 */

export type DmLauncherHost = { readonly root: string | null; readonly owners: DmPathOwners | null };

/** Policy paths as written, owners as S0 created them. */
export const DM_SYSTEM_HOST: DmLauncherHost = Object.freeze({ root: null, owners: DM_SYSTEM_PATH_OWNERS });

/**
 * Policy paths re-rooted under `root`, for tests. Every expected owner is
 * this process's uid unless `owners` says otherwise; on a platform without
 * POSIX owners (Windows) owner and mode are not checked, links still are.
 */
export const dmTestHost = (root: string, options: { owners?: DmPathOwners } = {}): DmLauncherHost => {
  if (typeof root !== "string" || root === "") throw new Error("AMUX Decision Maker test host needs a root");
  if (options.owners) return Object.freeze({ root, owners: options.owners });
  const uid = typeof process.geteuid === "function" ? process.geteuid() : null;
  const owners =
    uid === null
      ? null
      : { root: uid, broker: uid, vendor: { "decision-maker-openai": uid, "decision-maker-anthropic": uid } };
  return Object.freeze({ root, owners });
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
const DIRECTORY = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : null;

const isUnder = (path: string, directory: string) => path === directory || path.startsWith(`${directory}/`);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const childOf = (directory: string, name: string) => `${directory === "/" ? "" : directory}/${name}`;
const residueOf = (kind: DmCleanupResidueKind, path: string): DmCleanupResidue => ({ kind, path });

// ---------------------------------------------------------------------------
// Checked directories
// ---------------------------------------------------------------------------

/** Whose a directory must be, and whether only its owner may even read it. */
const ruleFor = (instance: DmInstanceScope, path: string): { owner: "root" | "broker" | "vendor"; private: boolean } => {
  const home = DM_LAUNCHER_SPECS[instance].home;
  if (isUnder(path, home)) return { owner: "vendor", private: path === home || isUnder(path, dmScratchRoot(instance)) };
  if (isUnder(path, DM_REQUEST_ROOT)) return { owner: "broker", private: false };
  return { owner: "root", private: false };
};

type Checked = { state: "absent" } | { state: "ok"; stats: Stats } | { state: "residue"; residue: DmCleanupResidue };

const ownerAndModeFit = (host: DmLauncherHost, instance: DmInstanceScope, path: string, stats: Stats, mode: boolean) => {
  if (host.owners === null) return true;
  const rule = ruleFor(instance, path);
  const expected = rule.owner === "vendor" ? host.owners.vendor[instance] : host.owners[rule.owner];
  if (stats.uid !== expected) return false;
  return !mode || (stats.mode & (rule.private ? 0o077 : 0o022)) === 0;
};

/** One directory, by `lstat`. */
const checkDirectory = (host: DmLauncherHost, instance: DmInstanceScope, path: string): Checked => {
  const found = probe(dmHostPath(host, path));
  if (found.state === "absent") return { state: "absent" };
  if (found.state === "error") return { state: "residue", residue: residueOf("path_unreadable", path) };
  const { stats } = found;
  if (stats.isSymbolicLink() || !stats.isDirectory() || !ownerAndModeFit(host, instance, path, stats, true)) {
    return { state: "residue", residue: residueOf("path_unsafe", path) };
  }
  return { state: "ok", stats };
};

/** Every directory from `/` down to `path` itself, in order; the first that is missing or unsafe decides. */
const checkChain = (host: DmLauncherHost, instance: DmInstanceScope, path: string): Checked => {
  const segments = path.split("/").filter((segment) => segment !== "");
  let checked: Checked = checkDirectory(host, instance, "/");
  for (let index = 0; index < segments.length && checked.state === "ok"; index += 1) {
    checked = checkDirectory(host, instance, `/${segments.slice(0, index + 1).join("/")}`);
  }
  return checked;
};

const STAGING_PREFIX = ".amux-dm-removing-";

/** The directory at `hostPath` is still the one `lstat` saw, opened without following a link. */
const sameDirectory = (hostPath: string, seen: Stats): boolean => {
  if (DIRECTORY === null || process.platform === "win32") return true;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(hostPath, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
    const opened = fstatSync(descriptor);
    return opened.ino === seen.ino && opened.dev === seen.dev;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
};

/**
 * Delete one entry whose parent chain is checked: rename it aside in that
 * parent, then unlink a link or file, or remove a directory that is still
 * the one renamed and has the expected owner. Returns what could not be done.
 */
const safeRemove = (host: DmLauncherHost, instance: DmInstanceScope, path: string): DmCleanupResidue[] => {
  const parent = parentOf(path);
  const chain = checkChain(host, instance, parent);
  if (chain.state === "absent") return [];
  if (chain.state === "residue") return [chain.residue];
  const found = probe(dmHostPath(host, path));
  if (found.state === "absent") return [];
  if (found.state === "error") return [residueOf("path_unreadable", path)];
  const staging = childOf(parent, `${STAGING_PREFIX}${randomBytes(8).toString("hex")}`);
  const stagingHost = dmHostPath(host, staging);
  try {
    renameSync(dmHostPath(host, path), stagingHost);
  } catch {
    return [residueOf("removal_failed", path)];
  }
  const moved = probe(stagingHost);
  if (moved.state === "absent") return [];
  if (moved.state === "error") return [residueOf("removal_failed", staging)];
  try {
    if (moved.stats.isSymbolicLink() || !moved.stats.isDirectory()) {
      unlinkSync(stagingHost);
    } else if (!ownerAndModeFit(host, instance, path, moved.stats, false) || !sameDirectory(stagingHost, moved.stats)) {
      return [residueOf("path_unsafe", staging)];
    } else {
      rmSync(stagingHost, { recursive: true, force: true });
    }
  } catch {
    // Checked below.
  }
  return probe(stagingHost).state === "absent" ? [] : [residueOf("removal_failed", staging)];
};

/** Nothing at `path`, judged through a checked parent chain. */
const verifyAbsent = (
  host: DmLauncherHost,
  instance: DmInstanceScope,
  path: string,
  kind: DmCleanupResidueKind,
): DmCleanupResidue[] => {
  const chain = checkChain(host, instance, parentOf(path));
  if (chain.state === "absent") return [];
  if (chain.state === "residue") return [chain.residue];
  const found = probe(dmHostPath(host, path));
  if (found.state === "absent") return [];
  return [residueOf(found.state === "error" ? "path_unreadable" : kind, path)];
};

const listChecked = (host: DmLauncherHost, path: string): string[] | null => {
  try {
    return readdirSync(dmHostPath(host, path)).sort();
  } catch {
    return null;
  }
};

const outcomeOf = (residue: DmCleanupResidue[]): DmCleanupOutcome => {
  const unique = [...new Map(residue.map((entry) => [`${entry.kind}\0${entry.path}`, entry])).values()];
  return unique.length === 0 ? { status: "verified" } : { status: "cleanup_unknown", residue: unique };
};

// ---------------------------------------------------------------------------
// Reading files
// ---------------------------------------------------------------------------

/** The sha256 of a regular file, read without following a final link; null when it is not one or cannot be read. */
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

/** A regular file read without following a final link, within a cap. */
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

/**
 * §5a: codex's `-o` file, read once, before cleanup deletes it, only through
 * the checked temporary directory and never through a link: the vendor
 * account writes this file and must not be able to point the launcher at
 * another one.
 */
export const dmReadRequestOutput = (host: DmLauncherHost, plan: DmExecutionPlan, maxBytes: number): DmOutputFileRead | null => {
  if (plan.paths.outputFile === null) return null;
  if (checkChain(host, plan.instance, plan.paths.temporaryDirectory).state !== "ok") return { state: "unreadable" };
  return dmReadOutputFile(dmHostPath(host, plan.paths.outputFile), maxBytes);
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

/**
 * §5a: "남김 목록 밖에 아무것도 없음". Everything found under the targets that
 * is not a kept regular file of the account's own, and anything that could
 * not be checked.
 */
export const dmVerifyCliState = (host: DmLauncherHost, instance: DmInstanceScope): DmCleanupResidue[] => {
  const home = DM_LAUNCHER_SPECS[instance].home;
  const homeChecked = checkChain(host, instance, home);
  if (homeChecked.state === "absent") return [residueOf("path_unsafe", home)];
  if (homeChecked.state === "residue") return [homeChecked.residue];
  const residue: DmCleanupResidue[] = [];
  for (const target of dmStateTargets(instance)) {
    const path = `${home}/${target.path}`;
    if (target.kind === "whole") {
      residue.push(...verifyAbsent(host, instance, path, "state_entry_present"));
      continue;
    }
    const root = checkChain(host, instance, path);
    if (root.state === "absent") continue;
    if (root.state === "residue") {
      residue.push(root.residue);
      continue;
    }
    const names = listChecked(host, path);
    if (names === null) {
      residue.push(residueOf("path_unreadable", path));
      continue;
    }
    for (const name of names) {
      const entry = `${path}/${name}`;
      if (!target.keep.includes(name)) {
        residue.push(residueOf("state_entry_present", entry));
        continue;
      }
      const kept = probe(dmHostPath(host, entry));
      if (kept.state !== "present" || !kept.stats.isFile() || !ownerAndModeFit(host, instance, entry, kept.stats, false)) {
        residue.push(residueOf("state_keep_not_regular_file", entry));
      }
    }
  }
  return residue;
};

/**
 * §5a "요청마다 지운다": delete every target but the kept authentication file,
 * each through `safeRemove`. Returns what could not be deleted; verification
 * is what decides.
 */
const deleteCliState = (host: DmLauncherHost, instance: DmInstanceScope): DmCleanupResidue[] => {
  const home = DM_LAUNCHER_SPECS[instance].home;
  if (checkChain(host, instance, home).state !== "ok") return [];
  const residue: DmCleanupResidue[] = [];
  for (const target of dmStateTargets(instance)) {
    const path = `${home}/${target.path}`;
    if (target.kind === "whole") {
      residue.push(...safeRemove(host, instance, path));
      continue;
    }
    if (checkChain(host, instance, path).state !== "ok") continue;
    for (const name of listChecked(host, path) ?? []) {
      if (!target.keep.includes(name)) residue.push(...safeRemove(host, instance, `${path}/${name}`));
    }
  }
  return residue;
};

// ---------------------------------------------------------------------------
// §5: the request's directories
// ---------------------------------------------------------------------------

/** The account's scratch root holds nothing: no temporary directory of an earlier request is left. */
export const dmVerifyScratch = (host: DmLauncherHost, instance: DmInstanceScope): DmCleanupResidue[] => {
  const root = dmScratchRoot(instance);
  const checked = checkChain(host, instance, root);
  if (checked.state === "absent") return [];
  if (checked.state === "residue") return [checked.residue];
  const names = listChecked(host, root);
  if (names === null) return [residueOf("path_unreadable", root)];
  return names.map((name) => residueOf("scratch_entry_present", `${root}/${name}`));
};

/** The request directory exists behind a checked chain; the account's home is checked and its scratch root empty. */
export const dmRequestDirectoriesUsable = (host: DmLauncherHost, plan: DmExecutionPlan): boolean =>
  checkChain(host, plan.instance, plan.paths.requestDirectory).state === "ok" &&
  checkChain(host, plan.instance, DM_LAUNCHER_SPECS[plan.instance].home).state === "ok" &&
  dmVerifyScratch(host, plan.instance).length === 0;

/**
 * The vendor account makes its own temporary directory, `0700`, in its own
 * scratch root (also `0700`, made if missing), and checks the chain again
 * after making it. False when either cannot be made or fails the check.
 */
export const dmCreateTemporaryDirectory = (host: DmLauncherHost, plan: DmExecutionPlan): boolean => {
  const { instance } = plan;
  const root = dmScratchRoot(instance);
  let checked = checkChain(host, instance, root);
  if (checked.state === "absent") {
    if (checkChain(host, instance, DM_LAUNCHER_SPECS[instance].home).state !== "ok") return false;
    try {
      mkdirSync(dmHostPath(host, root), { mode: 0o700 });
    } catch {
      return false;
    }
    checked = checkChain(host, instance, root);
  }
  if (checked.state !== "ok") return false;
  try {
    mkdirSync(dmHostPath(host, plan.paths.temporaryDirectory), { mode: 0o700 });
  } catch {
    return false;
  }
  return checkChain(host, instance, plan.paths.temporaryDirectory).state === "ok";
};

/**
 * The vendor account's half of §5's cleanup, on every exit path of the
 * launcher: the request's temporary directory and §5a's CLI state, then the
 * check that the scratch root is empty and nothing outside the kept file is
 * left. Anything left or unverifiable is `cleanup_unknown` (§5 latches the
 * instance `off`; that is the app's). Run as the vendor account.
 */
export const dmCleanupVendor = (
  host: DmLauncherHost,
  instance: DmInstanceScope,
  requestId: string | null,
): DmCleanupOutcome => {
  const removal =
    requestId !== null && isDmRequestId(requestId)
      ? safeRemove(host, instance, dmRequestPaths(instance, requestId).temporaryDirectory)
      : [];
  removal.push(...deleteCliState(host, instance));
  return outcomeOf([...removal, ...dmVerifyScratch(host, instance), ...dmVerifyCliState(host, instance)]);
};

/**
 * The broker's half of §5's cleanup: the request directory under the
 * broker's root, deleted and checked gone. Run as the broker, after the
 * launcher returns, whatever it returned.
 */
export const dmCleanupRequestDirectory = (
  host: DmLauncherHost,
  instance: DmInstanceScope,
  requestId: unknown,
): DmCleanupOutcome => {
  if (!isDmRequestId(requestId)) return outcomeOf([residueOf("request_id_invalid", "")]);
  const path = dmRequestPaths(instance, requestId).requestDirectory;
  return outcomeOf([...safeRemove(host, instance, path), ...verifyAbsent(host, instance, path, "request_path_present")]);
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
  /** The launcher's own copy of the payload, the same one it would send. */
  payload: unknown;
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
  if (!dmRequestDirectoriesUsable(host, plan)) refusals.push("request_directories_unusable");
  const intent = dmTransmitIntentRefusal(plan, input.evidence, input.requestKey, input.payload);
  if (intent) refusals.push(intent);
  refusals.push(...dmCommandRefusals(plan, input.command));
  return refusals;
};
