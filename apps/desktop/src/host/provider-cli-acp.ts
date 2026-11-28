import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { commandNamesSecretPath, isSecretPath } from "../../../tomverse-cli/src/workspace.js";
import type { PermissionModeId } from "../permission-contract";
import { LIVE_CLI_LIMITS, providerConfigFolders, type CliPermissionPlan, type LiveAcpProvider } from "../provider-cli-exec-contract";
import type { CliApproval, ExecEvent, ExecFile } from "./provider-cli-exec";

/**
 * The live "ACP" adapter: Qwen Code, Grok Build, Kimi Code, Mistral Vibe, MiniMax Code and Antigravity run the person's own installed CLI as
 * an Agent Client Protocol agent (JSON-RPC over stdio) in the person's real project folder and real home, so each CLI uses its
 * own sign-in. This is not the fixture path (acp-turn.ts): no loopback model server, no temporary home, no pinned version.
 *
 * Desktop is a deliberately small client. It advertises no file-system and no terminal capability, so the agent uses its own
 * tools; the one request it serves is `session/request_permission`, answered from the permission plan below. Every other
 * request from the agent is refused. Nothing here reads or writes a project file.
 *
 * The run fails closed on the CLI's own permission mode: each CLI starts in a mode of its own choosing (Vibe in "accept-edits",
 * MiniMax Code with permissionMode "auto"), so the mode is forced on the command line where the CLI has an option for it,
 * set over the protocol where it has modes, and read back; a mode that is not on the table of known ones, or that cannot be
 * confirmed as one that asks, ends the run before the task is sent.
 */

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 4_000) => (typeof value === "string" ? value.slice(0, max) : undefined);
const hasControl = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32);

// ----------------------------------------------------------------- arguments

/**
 * The arguments that start each CLI as an ACP agent, with the permission mode the CLI is forced into where it has an option.
 * Probed on the owner's computer (initialize and session/new only): Qwen Code 1.0.0-preview.2 rejects `--approval-mode` and takes
 * `--permission-mode`; Grok Build 1.0.92 offers no modes in the session, so its top-level `--permission-mode` (placed before
 * `agent`) is the only guarantee; Kimi Code 2.8.1, Mistral Vibe 3.1.5, Antigravity 1.5.19 and MiniMax Code 0.8.0 are set over the
 * protocol (see acpSafety). Read only starts Qwen Code and Grok Build in "dontAsk" (they refuse instead of asking); the adapter
 * denies every write and command request in that mode as well.
 * - Kimi Code: the `acp` subcommand. MiniMax Code: the `acp` subcommand of its entry file (started by Node, see minimax-install.ts).
 * - Mistral Vibe: `vibe-acp` takes no arguments.
 * - Antigravity (`agy`): the `acp` subcommand with telemetry off; the fixture's profile, log and endpoint flags are left out so it uses its own
 *   sign-in under ~/.gemini.
 * - Grok Build: `--no-auto-update` keeps the run from replacing the person's file.
 */
export function acpArguments(provider: LiveAcpProvider, grants: PermissionModeId = "ask"): string[] {
  const readOnly = grants === "read_only";
  switch (provider) {
    case "qwen": return ["--acp", "--permission-mode", readOnly ? "dontAsk" : "default"];
    case "xai": return ["--permission-mode", readOnly ? "dontAsk" : "default", "--no-auto-update", "agent", "--no-leader", "stdio"];
    case "moonshot": return ["acp"];
    case "mistral": return [];
    case "minimax": return ["acp"];
    case "google": return ["acp", "--disable-telemetry"];
  }
}

/** How long the CLI has to answer `initialize` and `session/new`, how long a mode change has to be confirmed, and how long it has to exit after the turn before it is ended. */
export const ACP_HANDSHAKE_MS = 60_000;
export const ACP_MODE_CONFIRM_MS = 5_000;
export const ACP_EXIT_GRACE_MS = 1_500;

// ------------------------------------------------------------ permission modes

type ConfigRule = {
  /** The configuration option's id in the session's `configOptions`. */
  id: string;
  /** Every value the CLI is known to have. */
  known: readonly string[];
  /** The values that still ask; the first is the one set. */
  accepted: readonly string[];
};
type Safety = {
  /** Every mode id the CLI is known to have. A current mode outside it ends the run. Empty: the CLI shows no modes. */
  known: readonly string[];
  /** The modes that route each request to the client (or refuse it), by what the run was granted; the first is the one set. */
  readOnly: readonly string[];
  interactive: readonly string[];
  config?: readonly ConfigRule[];
};

/** The known permission modes of each CLI, from the owner's computer (Qwen Code 1.0.0-preview.2, Kimi Code 2.8.1, Mistral Vibe 3.1.5, Antigravity 1.5.19, MiniMax Code 0.8.0, Grok Build 1.0.92). */
export const acpSafety: Record<LiveAcpProvider, Safety> = {
  qwen: { known: ["default", "acceptEdits", "auto", "dontAsk", "yolo"], readOnly: ["dontAsk"], interactive: ["default"] },
  // Grok Build reports no modes: the `--permission-mode` argument is what holds, and a mode it does report must be a known one.
  xai: { known: [], readOnly: [], interactive: [] },
  // Read only holds the mode that refuses or plans, never default, where a CLI does what it judges safe without asking.
  moonshot: { known: ["default", "plan", "auto", "yolo"], readOnly: ["plan"], interactive: ["default"] },
  mistral: { known: ["ask", "accept-edits", "smart-approve", "auto-approve"], readOnly: ["ask"], interactive: ["ask"] },
  // MiniMax Code edits without asking in "default": Read only is held to its plan mode only (whether plan blocks edits is the CLI's own rule).
  minimax: { known: ["default", "plan"], readOnly: ["plan"], interactive: ["default"],
    config: [{ id: "permissionMode", known: ["default", "auto", "bypassPermissions"], accepted: ["default"] }] },
  // Antigravity's plan mode cannot read files at all (checked 2026-11-28), so Read only runs in default, where every write and
  // command comes as a permission request that Read only refuses.
  // Antigravity edits and reads without asking in "default", so a Read only task on it is refused before it starts (cliReadOnlyRefused); this list is for the write modes.
  google: { known: ["default", "accept-edits", "plan"], readOnly: ["default", "plan"], interactive: ["default"] },
};

// ------------------------------------------------------------ credential paths

const configFolders = new Set<string>(providerConfigFolders);
// Invisible and direction-control characters, built from code points so the source holds no escape text.
const invisibleRanges: Array<[number, number]> = [[0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
const invisible = new RegExp(`[${invisibleRanges.map(([from, to]) => String.fromCodePoint(from) + (to > from ? `-${String.fromCodePoint(to)}` : "")).join("")}]`, "g");
const credentialName = /credential|oauth|(^|[-_.])auth\.json$|api[-_]?key|(access|refresh|id)[-_]?token/i;

/**
 * Whether a path names something that can hold credentials: everything isSecretPath names, anything inside a provider CLI's
 * settings folder (~/.qwen, ~/.vibe, ~/.grok ...; auth.json, subscription_credentials.json and the like), and files named like
 * a credential store. Name-based, like isSecretPath: it refuses on the name alone, whether or not the path is under the project.
 */
export function acpSecretPath(path: string): boolean {
  if (isSecretPath(path)) return true;
  const segments = path.normalize("NFKC").replace(invisible, "").replaceAll("\\", "/").toLowerCase().split("/");
  return segments.some((segment) => configFolders.has(segment)) || credentialName.test(segments.at(-1) ?? "");
}

const commandWords = (command: string) => command.split(/[\s"'=,;<>|&()`]+/).filter(Boolean);
/** More words than this in one command, or more places in one request, are not looked at in part: the request is refused. */
const MAX_WORDS = 256;
const MAX_PLACES = 64;
const MAX_INPUT = 64 * 1024;

const windows = process.platform === "win32";
const fold = (value: string) => (windows ? value.toLowerCase() : value);
const within = (child: string, parent: string) => {
  const rel = relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The path with every link of its nearest existing folder resolved: the real path of that folder plus the part that does not
 * exist yet. A link in the project that leads to a credential file resolves to the credential file. Null when it cannot be read,
 * including a link whose target does not exist yet: where it would lead is not known until the CLI writes through it.
 */
export function realPathOf(path: string, cwd: string): string | null {
  if (hasControl(path)) return null;
  let existing = resolve(cwd, path);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(existing), ...[...rest].reverse()); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      // Something is there although its real path is missing: a link to a target that does not exist yet.
      if (code === "ENOENT") { try { lstatSync(existing); return null; } catch { /* nothing there: a part not created yet */ } }
      const parent = dirname(existing);
      if (parent === existing) return null;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

const projectRoot = (cwd: string) => { try { return realpathSync.native(cwd); } catch { return null; } };

/** Whether the path lies inside the project, after the links of the nearest existing folder are resolved. */
export function insideProject(path: string, cwd: string): boolean {
  const root = projectRoot(cwd);
  if (!root || hasControl(path)) return false;
  const target = resolve(cwd, path);
  // The path may be written with the project's real path or with the path the person opened.
  if (!within(target, cwd) && !within(target, root)) return false;
  const real = realPathOf(path, cwd);
  return real !== null && within(real, root);
}

/**
 * Whether a requested path names a credential store: by the name as written and by where it really leads (a link in the project
 * to `~/.qwen/...` resolves outside it). A path inside the project is judged by its part under the project, so a project that
 * itself lives under a folder such as `.claude` is not refused as a whole. A path that cannot be resolved counts as one.
 */
export function namesCredential(path: string, cwd: string): boolean {
  return judgeCredential(path, cwd, true);
}

function judgeCredential(path: string, cwd: string, whenUnresolved: boolean): boolean {
  const root = projectRoot(cwd);
  const real = realPathOf(path, cwd);
  if (real === null) return whenUnresolved || acpSecretPath(path);
  const judged = (value: string) => {
    for (const base of [root, cwd]) if (base && within(value, base)) return acpSecretPath(relative(base, value) || ".");
    return acpSecretPath(value);
  };
  return judged(resolve(cwd, path)) || judged(real);
}

/**
 * Whether a shell command names a credential store. Every word is judged by its name, and then as a path from the project: a word
 * that leads somewhere (a link in the project to a `.env` or to `~/.qwen/...`, a folder that is one) is judged by where it really
 * leads. The command is never run to find out; a word that is not a path, or leads nowhere, is judged by its name alone.
 */
export function commandNamesCredential(command: string, cwd: string): boolean {
  if (commandNamesSecretPath(command, { everyWord: true })) return true;
  return commandWords(command).some((word) => acpSecretPath(word) || (word.length <= 4_096 && judgeCredential(word, cwd, false)));
}

// ---------------------------------------------------------------- permissions

/** Edit arguments that say how to write and never where: they do not stop Allow all from approving an edit on its own. */
const howToWrite = new Set(["overwrite", "replace_all", "replaceall"]);
const pathKeys = new Set(["path", "file_path", "filepath", "absolute_path", "absolutepath", "file", "filename", "notebook_path", "target", "source",
  "destination", "dest", "old_path", "new_path", "directory", "dir", "cwd"]);
const listKeys = new Set(["paths", "files", "file_paths"]);
/** A request to read or search is allowed in Read only when it names where, and every place is inside the project. */
const readKinds = new Set(["read", "search"]);

// The CLIs name the same argument differently (Vibe `filePath`, Antigravity `CommandLine` and `Path`, Kimi `path`): keys are matched without case.
const commandNames = ["command", "commandline", "command_line", "cmd"];
const afterNames = ["newtext", "new_text", "new_string", "newstring", "content", "contents"];
const beforeNames = ["oldtext", "old_text", "old_string", "oldstring"];
const pathNames = ["path", "filepath", "file_path", "absolute_path", "absolutepath", "file", "filename", "notebook_path"];

function parsedInput(value: unknown): Json | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.length > 64 * 1024) return undefined;
  try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : undefined; } catch { return undefined; }
}

/** Every value of the fields with these names, whatever their case: a request may carry two names for one thing (path and filePath). */
function allFields(source: Json | undefined, names: readonly string[]): unknown[] {
  if (!source) return [];
  return Object.keys(source).filter((key) => names.includes(key.toLowerCase())).map((key) => source[key]);
}

/** The command text of a request's arguments: a string, or a list of words. */
function commandOf(source: Json | undefined): string | undefined {
  // Two command fields that disagree are no command the card can show: the request is refused as one without a command.
  const commands = unique(allFields(source, commandNames).map((value) => typeof value === "string" ? (value.trim() ? value : "")
    : Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === "string") ? value.join(" ") : ""));
  return commands.length === 1 && commands[0] ? commands[0] : undefined;
}

/** Every command text any command field of the arguments holds, whatever the other fields say: all of them are checked. */
function commandValuesOf(source: Json | undefined): string[] {
  return unique(allFields(source, commandNames).flatMap((value) => typeof value === "string" ? [value]
    : Array.isArray(value) && value.every((word) => typeof word === "string") ? [value.join(" ")] : []).filter((value) => value.trim() !== ""));
}

/** Collects the places a request's arguments name. False when it could not look at all of them (too many, or nested too deep). */
function collectPaths(value: unknown, into: string[], depth = 0): boolean {
  if (!isRecord(value)) return true;
  if (depth > 3) return false;
  let complete = true;
  for (const [key, item] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (pathKeys.has(name) && typeof item === "string") {
      into.push(item);
    } else if (Array.isArray(item)) {
      if (item.length > MAX_PLACES) complete = false;
      for (const entry of item.slice(0, MAX_PLACES)) {
        if (typeof entry === "string") { if (listKeys.has(name)) into.push(entry); } else complete = collectPaths(entry, into, depth + 1) && complete;
      }
    } else {
      complete = collectPaths(item, into, depth + 1) && complete;
    }
  }
  return complete && into.length <= MAX_PLACES;
}

type Diff = { path: string; oldText?: string | null; newText: string };

/**
 * What an agent has said of one tool call before it asks about it. Vibe asks with only a `toolCallId` (the call itself came in an
 * earlier `tool_call`); Kimi streams the call's arguments as JSON text in `tool_call_update` content before it asks, and only
 * reports `rawInput` and `locations` afterwards; MiniMax Code reports `rawInput` in an update after the call.
 */
export type TrackedCall = { kind?: string; title?: string; rawInput?: unknown; diffs: unknown[]; locations: unknown[]; streamed: string; lastChunk: string; limited?: boolean };
const STREAM_LIMIT = MAX_INPUT;

/** Adds what a `tool_call` or `tool_call_update` says to what is known of that call. */
export function trackToolCall(calls: Map<string, TrackedCall>, id: string, update: Json) {
  let known = calls.get(id);
  if (!known) {
    if (calls.size >= 5_000) return;
    known = { diffs: [], locations: [], streamed: "", lastChunk: "" };
    calls.set(id, known);
  }
  known.kind = text(update.kind, 40) ?? known.kind;
  known.title = text(update.title, 300) ?? known.title;
  if (update.rawInput !== undefined && update.rawInput !== null) known.rawInput = update.rawInput;
  // Too much to look at is remembered, and a request about the call is refused.
  if (Array.isArray(update.locations) && update.locations.length > MAX_PLACES) known.limited = true;
  if (Array.isArray(update.content) && update.content.length > MAX_PLACES) known.limited = true;
  if (Array.isArray(update.locations) && update.locations.length > 0) known.locations = update.locations.slice(0, MAX_PLACES);
  if (Array.isArray(update.content)) {
    const diffs = update.content.slice(0, MAX_PLACES).filter((entry) => isRecord(entry) && entry.type === "diff");
    if (diffs.length > 0) known.diffs = diffs;
    for (const entry of update.content.slice(0, MAX_PLACES)) {
      if (!isRecord(entry) || entry.type !== "content" || !isRecord(entry.content) || typeof entry.content.text !== "string") continue;
      known.lastChunk = entry.content.text.slice(0, STREAM_LIMIT);
      if (known.streamed.length + known.lastChunk.length <= STREAM_LIMIT) known.streamed += known.lastChunk; else known.limited = true;
    }
  }
}

/**
 * The call's arguments from the text a CLI streamed (Kimi): only a text that is, whole, one JSON object counts. The pieces added
 * together are tried first, then the last piece alone (a CLI that repeats the whole text each time).
 */
function streamedInput(tracked: TrackedCall | undefined): Json | undefined {
  for (const candidate of [tracked?.streamed, tracked?.lastChunk]) {
    const trimmed = candidate?.trim();
    if (trimmed?.startsWith("{")) { const parsed = parsedInput(trimmed); if (parsed) return parsed; }
  }
  return undefined;
}

type Facts = { kind?: string; title?: string; raw?: Json; paths: string[]; locations: string[]; diffs: Diff[]; command?: string; commandValues: string[]; named: boolean; limited: boolean };

/** What one description of a tool call (the request's own, or the tracked one) says. `limited`: it holds more than is looked at in part. */
function factsOf(call: Json, tracked?: TrackedCall): Facts {
  const paths: string[] = [];
  const places: string[] = [];
  const diffs: Diff[] = [];
  let limited = tracked?.limited === true;
  const oversized = (value: unknown) => typeof value === "string" && value.length > MAX_INPUT;
  if (oversized(call.rawInput) || oversized(call.args)) limited = true;
  const raw = parsedInput(call.rawInput) ?? (tracked ? streamedInput(tracked) : undefined) ?? parsedInput(call.args);
  // A request that carries its arguments twice (Antigravity sends `rawInput` and, in `args`, part of it) is judged on `rawInput`
  // only when `args` adds nothing: every argument there must be in `rawInput` with the same value. One that differs or is missing
  // would be run without being checked or shown, so it refuses the request.
  const args = parsedInput(call.args);
  if (args && raw && raw !== args && !Object.entries(args).every(([key, value]) => Object.hasOwn(raw, key) && sameValue(raw[key], value))) limited = true;
  if (call.args !== undefined && call.args !== null && !args) limited = true;
  // `rawInput` that is there but cannot be read is not replaced by `args` or the streamed arguments: what the CLI runs is unknown.
  if (call.rawInput !== undefined && !parsedInput(call.rawInput)) limited = true;
  if (raw && JSON.stringify(raw).length > MAX_INPUT) limited = true;
  const locations = Array.isArray(call.locations) ? call.locations : [];
  const content = Array.isArray(call.content) ? call.content : [];
  if (locations.length > MAX_PLACES || content.length > MAX_PLACES) limited = true;
  for (const location of locations.slice(0, MAX_PLACES)) {
    const path = isRecord(location) ? location.path : undefined;
    if (typeof path === "string") { if (path.length > 4_096) limited = true; paths.push(path); places.push(path); }
  }
  for (const entry of content.slice(0, MAX_PLACES)) {
    if (!isRecord(entry) || entry.type !== "diff" || typeof entry.path !== "string") continue;
    if (entry.path.length > 4_096) limited = true;
    paths.push(entry.path);
    diffs.push({ path: entry.path, oldText: typeof entry.oldText === "string" ? entry.oldText : null, newText: typeof entry.newText === "string" ? entry.newText : "" });
  }
  if (!collectPaths(raw, paths) || paths.length > MAX_PLACES) limited = true;
  const kind = text(call.kind, 40);
  const title = text(call.title, 300);
  const command = commandOf(raw);
  const commandValues = commandValuesOf(raw);
  if (commandValues.some((value) => commandWords(value).length > MAX_WORDS)) limited = true;
  return { kind, title, raw, paths, locations: places, diffs, command, commandValues, named: kind !== undefined || title !== undefined || raw !== undefined || paths.length > 0, limited };
}

const unique = (values: readonly string[]) => [...new Set(values)];

/** The places a request's arguments name as the file it works on (not the other path-like fields, which stay on the card). */
function primaryPaths(raw: Json): string[] | null {
  const values = [...allFields(raw, pathNames), ...allFields(raw, ["paths", "files", "file_paths"]).flatMap((list) => Array.isArray(list) ? list : [list])];
  // Every one is checked; a value that is not a path string cannot be compared, so the request is not shown as only its diff.
  return values.every((value) => typeof value === "string") ? values as string[] : null;
}

/**
 * Whether the diff the card shows is the same edit as the arguments the CLI will run with. A diff cannot show every field of the
 * arguments, so where they speak of the same thing they must agree: the file (compared by where it really is) and the new and old
 * text. A diff with nothing to correspond to in the arguments, or arguments that name another file or other text, are not the
 * same edit, and the request is refused rather than shown as only the diff.
 */
function diffMatchesRaw(diffs: readonly Diff[], raw: Json | undefined, cwd: string): boolean {
  if (!raw || diffs.length === 0) return true;
  const where = (path: string) => realPathOf(path, cwd) ?? resolve(cwd, path);
  const fromDiffs = new Set(diffs.map(({ path }) => fold(where(path))));
  const named = primaryPaths(raw);
  if (named === null) return false;
  if (named.length > 0) {
    const fromRaw = new Set(named.map((path) => fold(where(path))));
    if (fromRaw.size !== fromDiffs.size || [...fromRaw].some((path) => !fromDiffs.has(path))) return false;
  }
  // Every text field, under each of its names, must be the diff's own text.
  const after = allFields(raw, afterNames);
  const before = allFields(raw, beforeNames);
  if (after.length > 0 && (diffs.length !== 1 || after.some((value) => value !== diffs[0]!.newText))) return false;
  if (before.length > 0 && (diffs.length !== 1 || before.some((value) => value !== diffs[0]!.oldText))) return false;
  return true;
}

/** Whether two lists of diffs are the same edits: the same files (where they really are) with the same old and new text. */
function sameDiffs(a: readonly Diff[], b: readonly Diff[], cwd: string): boolean {
  const key = (diff: Diff) => JSON.stringify([fold(realPathOf(diff.path, cwd) ?? resolve(cwd, diff.path)), diff.oldText, diff.newText]);
  const left = new Set(a.map(key));
  const right = new Set(b.map(key));
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

/** Whether two values are the same, whatever the order of an object's keys: values are compared as they are, nothing is normalised. */
function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index], depth + 1));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key], depth + 1));
  }
  return a === b;
}

const listNames = ["paths", "files", "file_paths"];
type Group = "command" | "path" | "after" | "before";

/**
 * What the arguments say once each group of names for one thing is read as one: the command, the file (`path`, `filePath`,
 * `Path` ...), the new text, the old text. Only the groups the card shows are read (`groups`): in each of them every value must be a
 * string and all must be the same string, or the arguments are unreadable (`ok: false`) and the request is refused. The keys of a
 * group that is read as one are `consumed`: the card shows its value once. Every other key of the arguments, those of a group the
 * card does not show among them, stays on the card as it is. A list of files (`paths`) next to a file must hold just that file (and
 * is then folded into it); on its own it stays on the card.
 */
function aliasGroups(raw: Json | undefined, groups: ReadonlySet<Group>): { ok: boolean; path?: string; after?: string; before?: string; consumed: Set<string> } {
  const consumed = new Set<string>();
  if (!raw) return { ok: true, consumed };
  let ok = true;
  const keysOf = (names: readonly string[]) => Object.keys(raw).filter((key) => names.includes(key.toLowerCase()));
  const group = (which: Group, names: readonly string[]) => {
    if (!groups.has(which)) return undefined;
    const keys = keysOf(names);
    for (const key of keys) consumed.add(key);
    if (keys.length === 0) return undefined;
    const values = keys.map((key) => raw[key]);
    if (!values.every((value) => typeof value === "string") || new Set(values).size !== 1) { ok = false; return undefined; }
    return values[0] as string;
  };
  if (groups.has("command")) for (const key of keysOf(commandNames)) consumed.add(key);
  const path = group("path", pathNames);
  const after = group("after", afterNames);
  const before = group("before", beforeNames);
  const lists = groups.has("path") ? keysOf(listNames) : [];
  if (lists.length > 0) {
    const entries = lists.flatMap((key) => (Array.isArray(raw[key]) ? raw[key] as unknown[] : [raw[key]]));
    if (!entries.every((entry) => typeof entry === "string")) ok = false;
    else if (path !== undefined) {
      // A file and a list of files that is not that one file name two things: neither can stand for the other.
      if (entries.every((entry) => entry === path)) for (const key of lists) consumed.add(key); else ok = false;
    }
  }
  return { ok, path, after, before, consumed };
}

export type AcpPermission = {
  /** "allow": answered yes with no card. "deny": answered no with no card. "ask": the person's card. "refuse": no card, and the person is told. */
  verdict: "allow" | "deny" | "ask" | "refuse";
  approval: CliApproval;
  allowOption?: string;
  rejectOption?: string;
};

/** The option a request offers for an answer: by its kind, or for a CLI that sends no kind (Antigravity `allow` / `deny`) by its id. */
function optionFor(options: Json[], kind: "allow_once" | "reject_once") {
  const named = options.find((option) => option.kind === kind && typeof option.optionId === "string");
  if (named) return named.optionId as string;
  const plain = kind === "allow_once" ? /^allow(_once)?$/i : /^(deny|reject)(_once)?$/i;
  return options.find((option) => typeof option.kind !== "string" && typeof option.optionId === "string" && plain.test(option.optionId))?.optionId as string | undefined;
}

/**
 * Reads one `session/request_permission` and decides what Desktop does with it, by the permission plan. What the request says is
 * merged with what the agent said of the same `toolCallId` before (`tracked`): a field the request carries wins, but every path and
 * command from either is checked. A request that names nothing at all, with nothing tracked, is refused.
 * - Read only (no approvals): a read or search that names its places, all inside the project, is allowed; every write, command
 *   or other request is denied, and so is a read or search that names no place.
 * - Ask and Auto review: everything goes to the person's card, except a request naming a credential file or a provider CLI's
 *   settings folder (also through a link), a command request that carries no command text, or a request with no content, which is
 *   refused and never shown.
 * - Allow all: a file edit whose every path is inside the project is allowed; commands, network and anything outside the
 *   project still go to the card, as with Claude Code.
 * "Allow always" is never chosen: only `allow_once` is ever selected.
 */
export function classifyAcpPermission(params: unknown, context: { cwd: string; plan: CliPermissionPlan; tracked?: TrackedCall }): AcpPermission {
  const body = isRecord(params) ? params : {};
  const call = isRecord(body.toolCall) ? body.toolCall : {};
  const options = Array.isArray(body.options) ? body.options.filter(isRecord) : [];
  const allowOption = optionFor(options, "allow_once");
  const rejectOption = optionFor(options, "reject_once");
  const id = text(call.toolCallId, 200) ?? "unknown";
  const own = factsOf(call);
  const earlier = context.tracked ? factsOf({ kind: context.tracked.kind, title: context.tracked.title, rawInput: context.tracked.rawInput, locations: context.tracked.locations,
    content: context.tracked.diffs }, context.tracked) : undefined;
  const kind = own.kind ?? earlier?.kind ?? "other";
  const title = own.title ?? earlier?.title;
  const raw = own.raw ?? earlier?.raw;
  const diffs = own.diffs.length > 0 ? own.diffs : earlier?.diffs ?? [];
  const paths = unique([...own.paths, ...(earlier?.paths ?? [])]);
  const locations = unique([...own.locations, ...(earlier?.locations ?? [])]);
  const command = own.command ?? earlier?.command;
  // Every command text either description holds is checked, whether or not the card shows it as the command.
  const commands = unique([...own.commandValues, ...(earlier?.commandValues ?? [])]);
  const commandMissing = kind === "execute" && command === undefined;
  const blank = !own.named && !earlier?.named;
  // More than is looked at in part is not judged in part, and a diff that is not the edit the arguments describe is not shown as if it were: both are refused.
  // The request and what the agent said of the same call before must describe one action: a command, diff or file the request
  // shows that differs from the earlier one (an earlier `git push`, a request for `echo hi`) would let the card approve what it
  // does not show, so the two are compared where both speak, and a difference refuses the request.
  // Arguments the request and the earlier call both carry must be the same arguments, whole: any other field either has (a cwd, an
  // option) that the other lacks would let the card show one action and the CLI run another. Only one of them: that one is used.
  const sameAction = (own.kind === undefined || earlier?.kind === undefined || own.kind === earlier.kind) &&
    (own.diffs.length === 0 || (earlier?.diffs.length ?? 0) === 0 || sameDiffs(own.diffs, earlier!.diffs, context.cwd)) &&
    (own.raw === undefined || earlier?.raw === undefined || sameValue(own.raw, earlier.raw));
  // The card reads the groups it shows: a command card the command, a Write or Edit card the file and the texts. Any other field of the
  // arguments, a group the card does not show among them, stays on it under its own name (and a group not shown is not checked: it is seen as it is).
  const groups = new Set<Group>(kind === "execute" ? ["command"] : kind === "edit" ? ["path", "after", "before"] : []);
  const aliases = aliasGroups(raw, groups);
  // The places an edit card shows are its diffs' files, or the file of its arguments. A location of the request that is anywhere else
  // (a file outside the project) is a place the card does not show, so the request is refused rather than shown without it.
  const showsEdit = kind === "edit" && (diffs.length > 0 || (aliases.path !== undefined && aliases.after !== undefined));
  const shown = new Set((diffs.length > 0 ? diffs.map((diff) => diff.path) : aliases.path !== undefined ? [aliases.path] : []).map((path) => fold(realPathOf(path, context.cwd) ?? "")));
  const strayLocation = showsEdit && locations.some((path) => { const real = realPathOf(path, context.cwd); return real === null || !shown.has(fold(real)); });
  const limited = own.limited || earlier?.limited === true || !sameAction || !aliases.ok || strayLocation || !diffMatchesRaw(diffs, raw, context.cwd);

  // The card, from the arguments the CLI will run with; the title is a description and is never taken for them.
  // The arguments the card does not show in its own fields go under one key of their own, so none can stand in for a card field
  // (an `edits` argument replacing the diffs shown, a `file_path` replacing the file).
  const rest = Object.fromEntries(Object.entries(raw ?? {}).filter(([key]) => !aliases.consumed.has(key)));
  const extras = Object.keys(rest).length > 0 ? { otherArguments: rest } : {};
  const { path: rawPath, after, before } = aliases;
  let approval: CliApproval;
  if (kind === "execute" && command) {
    approval = { id, tool: "Bash", input: { command, ...(title && title !== command ? { description: title } : {}), ...(locations.length > 0 ? { locationPaths: locations } : {}), ...extras } };
  } else if (kind === "edit" && diffs.length === 1) {
    const [diff] = diffs;
    approval = diff.oldText === null || diff.oldText === undefined
      ? { id, tool: "Write", input: { file_path: diff.path, content: diff.newText, ...extras } }
      : { id, tool: "Edit", input: { file_path: diff.path, old_string: diff.oldText, new_string: diff.newText, ...extras } };
  } else if (kind === "edit" && diffs.length > 1) {
    approval = { id, tool: "MultiEdit", input: { file_path: diffs[0]!.path, edits: diffs.map(({ path, oldText, newText }) => ({ path, old_string: oldText ?? "", new_string: newText })), ...extras } };
  } else if (kind === "edit" && rawPath && after !== undefined) {
    approval = before === undefined ? { id, tool: "Write", input: { file_path: rawPath, content: after, ...extras } }
      : { id, tool: "Edit", input: { file_path: rawPath, old_string: before, new_string: after, ...extras } };
  } else {
    approval = { id, tool: title ?? kind, input: { kind, ...(title ? { title } : {}), ...(paths.length ? { paths } : {}), ...(raw ? { rawInput: raw } : {}) } };
  }

  const secret = paths.some((path) => namesCredential(path, context.cwd)) || commands.some((text) => commandNamesCredential(text, context.cwd));
  const inside = paths.every((path) => insideProject(path, context.cwd));
  const result = (verdict: AcpPermission["verdict"], marked = approval): AcpPermission => ({ verdict, approval: marked, allowOption, rejectOption });
  if (context.plan.approvals === "none") {
    return result(!blank && !limited && !secret && !commandMissing && inside && readKinds.has(kind) && paths.length > 0 && commands.length === 0 && allowOption ? "allow" : "deny");
  }
  if (secret || commandMissing || blank || limited) return result("refuse", { ...approval, refused: true });
  // Allow all is the person's choice to let edits inside the project run without a card, whatever they write: what it checks is
  // where an edit goes, not what it writes, so the size of a diff and an edit known only by its file (Mistral Vibe's requests carry
  // only the tool call id) do not matter. Every place the edit can name must be known and inside the project: an argument outside
  // the card's own fields (a `destination_path`, an `edits` list) may name another one, so such an edit is asked instead. The
  // exceptions are the arguments that only say how to write, never where (Antigravity's `Overwrite` on every write, checked
  // against the real CLI 2026-11-28).
  const targetsKnown = Object.keys(rest).every((key) => howToWrite.has(key.toLowerCase()));
  if (context.plan.grants === "allow_all" && kind === "edit" && paths.length > 0 && inside && targetsKnown && commands.length === 0 && allowOption) return result("allow");
  return result("ask");
}

// --------------------------------------------------------------------- client

const fileKinds: Record<string, ExecFile["kind"]> = { edit: "update", move: "update", delete: "delete" };
const toolStates: Record<string, "running" | "done" | "failed"> = { pending: "running", in_progress: "running", completed: "done", failed: "failed" };

export type AcpClientOptions = {
  provider: LiveAcpProvider;
  cwd: string;
  prompt: string;
  mode: PermissionModeId;
  plan: CliPermissionPlan;
  /** Writes one JSON-RPC frame. */
  send: (frame: Json) => void;
  emit: (event: ExecEvent) => void;
  /** Asks the person on a card; false denies. Called one request at a time. */
  approve?: (request: CliApproval, signal: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
  clientVersion?: string;
  handshakeMs?: number;
  confirmMs?: number;
};

type Tool = { kind: string; title: string; files: ExecFile[]; command?: string };

export function createAcpClient(options: AcpClientOptions) {
  let nextId = 1;
  const waiting = new Map<number, (frame: Json) => void>();
  const tools = new Map<string, Tool>();
  /** What the agent said of each tool call before it asked about it (see TrackedCall). */
  const calls = new Map<string, TrackedCall>();
  const pendingApprovals = new Set<AbortController>();
  const early: Json[] = [];
  /** The id of the session/new request, and how many early notifications came before its answer. */
  let sessionNewId = -1;
  let earlyBeforeAnswer = 0;
  /** More notifications came before the session existed than are kept: one about the mode may be among those dropped. */
  let earlyOverflow = false;
  const watchers = new Set<() => void>();
  let approvals: Promise<void> = Promise.resolve();
  let sessionId = "";
  let prompted = false;
  let finished = false;
  let reply = "";
  let messages = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** What the CLI last reported of its modes and options, from the session, its answers and its notifications. */
  const observed: { mode?: string; modeOption?: string; config: Map<string, string>; overflow?: boolean } = { config: new Map() };
  let enforced = false;
  /** How many times the CLI has reported its mode; a switch answer stands for the switch only when no report came in between. */
  let modeReports = 0;
  const rule = acpSafety[options.provider];
  const accepted = options.plan.grants === "read_only" ? rule.readOnly : rule.interactive;

  const frame = (body: Json) => options.send({ jsonrpc: "2.0", ...body });
  const request = (method: string, params: Json) => new Promise<Json>((resolvePromise) => {
    const id = nextId++;
    waiting.set(id, resolvePromise);
    frame({ id, method, params });
  });
  // The CLI's own reason when it gives one (Grok Build answers "Internal error" with the provider's refusal, such as a spent usage
  // balance, in error.data), so the task says why rather than only that it failed.
  const errorText = (answer: Json) => {
    if (!isRecord(answer.error)) return "The CLI reported an error.";
    const message = text(answer.error.message, 300) ?? "The CLI reported an error.";
    const data = answer.error.data;
    const detail = typeof data === "string" ? data : isRecord(data) ? text(data.message, 400) ?? text(data.details, 400) : undefined;
    return detail && !message.includes(detail) ? `${message}: ${detail.slice(0, 400)}` : message;
  };

  const turn = (state: "completed" | "failed", error?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    options.emit({ type: "turn", state, ...(error ? { error } : {}) });
  };
  const flush = () => {
    if (!reply.trim()) { reply = ""; return; }
    options.emit({ type: "message", id: `acp-message-${messages++}`, text: reply.slice(0, LIVE_CLI_LIMITS.message) });
    reply = "";
  };

  /** Reads what a result or a notification says about the current mode and options. */
  function observe(source: unknown) {
    if (!isRecord(source)) return;
    const modes = isRecord(source.modes) ? source.modes : undefined;
    const mode = text(source.currentModeId, 80) ?? text(modes?.currentModeId, 80);
    // The mode option of the session repeats the mode: a new mode makes the old option stale until the CLI reports it again.
    if (mode !== undefined && mode !== observed.mode) observed.modeOption = undefined;
    if (mode !== undefined) { observed.mode = mode; modeReports++; }
    // More options than are read means the mode may be among those not read: it is not confirmed.
    if (Array.isArray(source.configOptions) && source.configOptions.length > MAX_PLACES) observed.overflow = true;
    for (const option of Array.isArray(source.configOptions) ? source.configOptions.slice(0, MAX_PLACES) : []) {
      if (!isRecord(option) || typeof option.id !== "string" || typeof option.currentValue !== "string") continue;
      if (option.id === "mode") { observed.modeOption = option.currentValue; modeReports++; }
      else observed.config.set(option.id.slice(0, 80), option.currentValue.slice(0, 80));
    }
    for (const watcher of [...watchers]) watcher();
  }
  const modeOk = () => !observed.overflow && (observed.mode === undefined ? rule.known.length === 0 : accepted.includes(observed.mode)) &&
    (observed.modeOption === undefined || accepted.includes(observed.modeOption));
  const configOk = () => (rule.config ?? []).every(({ id, accepted: values }) => { const value = observed.config.get(id); return value !== undefined && values.includes(value); });
  /** Waits until the check holds on what the CLI reports, or the time is up. */
  const confirmed = (check: () => boolean) => new Promise<boolean>((done) => {
    if (check()) { done(true); return; }
    const end = (value: boolean) => { clearTimeout(wait); watchers.delete(watcher); done(value); };
    const watcher = () => { if (check()) end(true); };
    const wait = setTimeout(() => end(false), options.confirmMs ?? ACP_MODE_CONFIRM_MS);
    watchers.add(watcher);
  });

  /**
   * The session's permission mode must be one that asks (or, in Read only, one that refuses). A mode outside the table of the
   * CLI's known ones, or one that cannot be confirmed after it is set, fails the run before the task is sent.
   */
  async function enforceMode(session: Json, later: Json[]) {
    observed.mode = undefined;
    observed.modeOption = undefined;
    observed.config.clear();
    observed.overflow = false;
    observe(session);
    for (const update of later) observe(update);
    const modes = isRecord(session.modes) ? session.modes : undefined;
    const available = Array.isArray(modes?.availableModes) ? modes.availableModes.flatMap((mode) => (isRecord(mode) && typeof mode.id === "string" ? [mode.id] : [])) : [];
    const fail = (why: string) => new Error(`${why} Tomverse Desktop does not start a task in a mode it cannot confirm asks first.`);
    for (const value of [observed.mode, observed.modeOption] as Array<string | undefined>) {
      if (value !== undefined && !rule.known.includes(value)) throw fail(`The CLI is in permission mode "${value.slice(0, 40)}", which is not one Desktop knows.`);
    }
    if (observed.overflow) throw fail("The CLI reported more options than Desktop reads.");
    if (rule.known.length > 0 && observed.mode === undefined) throw fail("The CLI did not report its permission mode.");
    if (!modeOk()) {
      const target = accepted[0]!;
      if (!available.includes(target)) throw fail(`The CLI is in permission mode "${observed.mode}" and cannot switch to "${target}".`);
      const reportsBefore = modeReports;
      const switched = await request("session/set_mode", { sessionId, modeId: target });
      if (switched.error) throw fail(`The CLI refused to switch to permission mode "${target}".`);
      // ACP's set_mode answer is empty by definition: a success is the switch (Vibe, Kimi and Antigravity answer `{}`, checked
      // against the real CLIs 2026-11-28). A mode the CLI reported while switching, in the answer or after it, wins over it.
      if (modeReports === reportsBefore && observed.mode !== target) { observed.mode = target; observed.modeOption = undefined; }
      observe(switched.result);
      if (!await confirmed(modeOk)) throw fail(`The CLI did not confirm permission mode "${target}".`);
    }
    for (const { id, known, accepted: values } of rule.config ?? []) {
      const current = observed.config.get(id);
      if (current === undefined) throw fail(`The CLI did not report its "${id}" option.`);
      if (!known.includes(current)) throw fail(`The CLI's "${id}" option is "${current.slice(0, 40)}", which is not one Desktop knows.`);
      if (!values.includes(current)) {
        const switched = await request("session/set_config_option", { sessionId, configId: id, value: values[0] });
        if (switched.error) throw fail(`The CLI refused to set its "${id}" option to "${values[0]}".`);
        observe(switched.result);
        if (!await confirmed(configOk)) throw fail(`The CLI did not confirm its "${id}" option as "${values[0]}".`);
      }
    }
    // The mode and every option together, after all the switches: a mode the CLI moved to while an option was set counts too.
    if (!modeOk() || !configOk()) throw fail("The CLI's permission mode or options changed while Desktop set them.");
    enforced = true;
  }

  function toolEvents(id: string, update: Json): ExecEvent[] {
    const known = tools.get(id);
    const kind = text(update.kind, 40) ?? known?.kind ?? "other";
    const title = text(update.title, 300) ?? known?.title ?? "tool";
    const raw = parsedInput(update.rawInput);
    const files: ExecFile[] = [...(known?.files ?? [])];
    const addFile = (path: string | undefined, created: boolean) => {
      if (!path || files.some((file) => file.path === path)) return;
      files.push({ path: path.slice(0, 2_048), kind: kind === "delete" ? "delete" : created ? "create" : fileKinds[kind] ?? "update" });
    };
    const output: string[] = [];
    for (const entry of Array.isArray(update.content) ? update.content.slice(0, 64) : []) {
      if (!isRecord(entry)) continue;
      if (entry.type === "diff" && typeof entry.path === "string") addFile(entry.path, entry.oldText === null || entry.oldText === undefined);
      else if (entry.type === "content" && isRecord(entry.content) && typeof entry.content.text === "string") output.push(entry.content.text);
    }
    if (fileKinds[kind] || kind === "delete") for (const location of Array.isArray(update.locations) ? update.locations.slice(0, 64) : []) {
      addFile(isRecord(location) ? text(location.path, 2_048) : undefined, false);
    }
    const command = known?.command ?? commandOf(raw) ?? (kind === "execute" ? title : undefined);
    if (tools.size < 5_000 || known) tools.set(id, { kind, title, files, ...(command ? { command } : {}) });
    const status = text(update.status, 20);
    const state = (status && toolStates[status]) || "running";
    if (kind === "execute") {
      const rawOutput = isRecord(update.rawOutput) ? update.rawOutput : undefined;
      const printed = output.join("\n") || text(update.rawOutput, LIVE_CLI_LIMITS.commandOutput) || text(rawOutput?.output, LIVE_CLI_LIMITS.commandOutput) || text(rawOutput?.stdout, LIVE_CLI_LIMITS.commandOutput);
      return [{ type: "command", id, command: command ?? "", state, ...(state !== "running" && printed ? { output: printed.slice(-LIVE_CLI_LIMITS.commandOutput) } : {}) }];
    }
    if (fileKinds[kind] || kind === "delete") return [{ type: "files", id, files, state }];
    return [{ type: "tool", id, name: title.slice(0, 120), detail: text(raw?.path, 300) ?? text(raw?.file_path, 300) ?? text(raw?.pattern, 300) ?? text(raw?.query, 300) ?? text(raw?.url, 300), state }];
  }

  function onUpdate(update: Json) {
    const kind = text(update.sessionUpdate, 60);
    if (kind === "current_mode_update" || kind === "config_option_update") {
      observe(update);
      // A CLI that changes its own mode during the task, to one that does not ask, ends the task at once.
      if (enforced && !finished && (!modeOk() || !configOk())) turn("failed", "The CLI changed its permission mode during the task, and Tomverse Desktop ended it.");
      return;
    }
    if (kind === "agent_message_chunk") {
      const content = update.content;
      if (isRecord(content) && content.type === "text" && typeof content.text === "string" && reply.length < LIVE_CLI_LIMITS.message) {
        reply += content.text;
        options.emit({ type: "delta", id: "stream", text: content.text });
      }
      return;
    }
    if (kind === "agent_thought_chunk" || kind === "user_message_chunk") return;
    flush();
    const id = text(update.toolCallId, 200);
    if ((kind === "tool_call" || kind === "tool_call_update") && id) {
      trackToolCall(calls, id, update);
      for (const event of toolEvents(id, update)) options.emit(event);
    }
  }

  function answer(id: unknown, params: unknown) {
    const controller = new AbortController();
    pendingApprovals.add(controller);
    const signal = AbortSignal.any([options.signal, controller.signal]);
    approvals = approvals.then(async () => {
      const asked = isRecord(params) && isRecord(params.toolCall) ? text(params.toolCall.toolCallId, 200) : undefined;
      const decision = classifyAcpPermission(params, { cwd: options.cwd, plan: options.plan, ...(asked && calls.has(asked) ? { tracked: calls.get(asked) } : {}) });
      let allowed = decision.verdict === "allow";
      if (!finished && !signal.aborted && (decision.verdict === "ask" || decision.verdict === "refuse") && options.approve && options.plan.approvals === "card") {
        try { allowed = (await options.approve(decision.approval, signal)) && decision.verdict === "ask" && !!decision.allowOption; } catch { allowed = false; }
      }
      pendingApprovals.delete(controller);
      if (controller.signal.aborted && !options.signal.aborted) return;
      const chosen = allowed && !finished ? decision.allowOption : decision.rejectOption;
      frame({ id, result: { outcome: chosen ? { outcome: "selected", optionId: chosen } : { outcome: "cancelled" } } });
    });
  }

  function handleUpdate(message: Json) {
    if (isRecord(message.params) && isRecord(message.params.update) && !finished) onUpdate(message.params.update);
  }

  async function drive() {
    const initialized = await request("initialize", { protocolVersion: 1, clientInfo: { name: "tomverse-desktop", title: "Tomverse Desktop", version: options.clientVersion ?? "0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const info = isRecord(initialized.result) ? initialized.result : undefined;
    if (!info || initialized.error || info.protocolVersion !== 1) throw new Error(initialized.error ? errorText(initialized) : "The CLI did not answer as an ACP agent (protocol version 1).");
    sessionNewId = nextId;
    const created = await request("session/new", { cwd: options.cwd, mcpServers: [] });
    const session = isRecord(created.result) ? created.result : undefined;
    if (created.error || !session || typeof session.sessionId !== "string" || !session.sessionId) {
      const code = isRecord(created.error) ? created.error.code : undefined;
      throw new Error(code === -32000 ? "The CLI is not signed in. Sign in with the CLI itself, then try again." : created.error ? errorText(created) : "The CLI did not start a session.");
    }
    sessionId = session.sessionId.slice(0, 200);
    if (earlyOverflow) throw new Error("The CLI sent more notifications before its session started than Desktop reads. Tomverse Desktop does not start a task in a mode it cannot confirm asks first.");
    // Notifications from before the session's answer are older than the mode it reports and are dropped; those after it are newer and
    // count, the mode ones while the mode is set and the others once it is.
    const later = early.splice(0).slice(earlyBeforeAnswer).flatMap((message) =>
      isRecord(message.params) && message.params.sessionId === sessionId && isRecord(message.params.update) ? [message.params.update] : []);
    const isMode = (update: Json) => update.sessionUpdate === "current_mode_update" || update.sessionUpdate === "config_option_update";
    await enforceMode(session, later.filter(isMode));
    for (const update of later) if (!isMode(update) && !finished) onUpdate(update);
    if (finished) return;
    options.emit({ type: "session", id: sessionId });
    clearTimeout(timer);
    prompted = true;
    const done = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: options.prompt }] });
    flush();
    if (finished) return;
    if (done.error) return turn("failed", errorText(done));
    const stop = isRecord(done.result) ? text(done.result.stopReason, 40) : undefined;
    if (stop === "end_turn") return turn("completed");
    turn("failed", stop === "cancelled" ? "The CLI ended the task." : stop === "refusal" ? "The model refused the task." : stop === "max_tokens" ? "The model reached its output limit."
      : stop === "max_turn_requests" ? "The CLI reached its request limit for one task." : "The CLI ended the task without a result.");
  }

  return {
    /** Starts the handshake, the session and the prompt. */
    start() {
      timer = setTimeout(() => turn("failed", "The CLI did not complete the ACP handshake."), options.handshakeMs ?? ACP_HANDSHAKE_MS);
      timer.unref?.();
      drive().catch((error: unknown) => turn("failed", error instanceof Error ? error.message.slice(0, 600) : "The CLI failed."));
    },
    /** One frame the CLI printed. */
    handle(message: Json) {
      const method = typeof message.method === "string" ? message.method : undefined;
      const hasId = typeof message.id === "number" || typeof message.id === "string";
      if (!method) {
        const resolveReply = typeof message.id === "number" ? waiting.get(message.id) : undefined;
        if (message.id === sessionNewId) earlyBeforeAnswer = early.length;
        if (resolveReply && typeof message.id === "number") { waiting.delete(message.id); resolveReply(message); }
        return;
      }
      if (!hasId) {
        if (method !== "session/update" || !isRecord(message.params)) return;
        if (sessionId === "") { if (early.length < 64) early.push(message); else earlyOverflow = true; } else if (message.params.sessionId === sessionId) handleUpdate(message);
        return;
      }
      if (method === "session/request_permission" && isRecord(message.params) && message.params.sessionId === sessionId) answer(message.id, message.params);
      else if (method === "session/request_permission") frame({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
      // fs, terminal and every other request: this client offers none of them.
      else frame({ id: message.id, error: { code: -32601, message: "Tomverse Desktop does not offer this method." } });
    },
    prompted: () => prompted,
    /** Cancels the questions nobody can answer any more. */
    cancelPending() { for (const controller of pendingApprovals) controller.abort(); },
    /** Resolves when every answer in flight has been sent. */
    idle: () => approvals.catch(() => undefined),
    dispose() { clearTimeout(timer); },
  };
}
