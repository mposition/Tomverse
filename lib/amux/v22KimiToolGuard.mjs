import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Kimi Code CLI read role's tool boundary (owner request 2026-11-28),
 * applied before a tool runs. `kimi --print` approves every tool call and its
 * file tools read any absolute path, so the run's --config installs this file
 * as a PreToolUse hook (kimi_cli hooks: JSON on stdin with tool_name and
 * tool_input; exit 2 blocks the call and feeds stderr back to the model).
 *
 * A call passes only when its tool is ReadFile, Glob or Grep, every argument
 * is one the tool documents, every path pattern stays relative without `..`
 * or `~`, and every path argument resolves -- symlinks included -- inside the
 * checkout. Anything else, a parse failure included, is blocked.
 *
 * Kimi treats a hook that fails to start or times out as "allow". So each
 * decision is appended to the run's decision log, and the sidecar refuses a
 * run whose stream has more tool calls than the log has decisions
 * (v22ChannelRun.mjs): a call the hook never saw makes the result untrusted.
 */

/** Each read tool's documented parameters (kimi-cli docs, agents.md). */
export const AMUX_V22_KIMI_TOOL_ARGUMENTS = Object.freeze({
  ReadFile: { paths: ["path"], patterns: [], other: ["line_offset", "n_lines"] },
  Glob: { paths: ["directory"], patterns: ["pattern"], other: ["include_dirs"] },
  Grep: { paths: ["path"], patterns: ["glob"], other: ["pattern", "type", "output_mode",
    "-B", "-A", "-C", "-n", "-i", "multiline", "head_limit", "offset", "include_ignored"] },
});

const object = (value) => value && typeof value === "object" && !Array.isArray(value);

function lexicallyInside(value, worktreePath, { absolute }) {
  if (typeof value !== "string" || value === "" || value.length > 4096 ||
      value.startsWith("~") || value.includes("\\") || value.includes("\0") ||
      value.split("/").includes("..")) return false;
  if (!value.startsWith("/")) return true;
  return absolute && typeof worktreePath === "string" && worktreePath.startsWith("/") &&
    (value === worktreePath || value.startsWith(`${worktreePath}/`));
}

/** Why a tool name and its arguments are refused by their text alone, or null. */
export function amuxV22KimiToolInputRefusal(name, args, worktreePath) {
  if (typeof name !== "string" || !Object.hasOwn(AMUX_V22_KIMI_TOOL_ARGUMENTS, name))
    return "tool";
  if (!object(args)) return "tool_arguments";
  const spec = AMUX_V22_KIMI_TOOL_ARGUMENTS[name];
  for (const [key, value] of Object.entries(args)) {
    if (spec.paths.includes(key)) {
      if (!lexicallyInside(value, worktreePath, { absolute: true })) return "tool_path";
    } else if (spec.patterns.includes(key)) {
      if (!lexicallyInside(value, worktreePath, { absolute: false })) return "tool_path";
    } else if (!spec.other.includes(key)) return "tool_arguments";
  }
  return null;
}

/** The real path of `path`, or of its nearest existing ancestor joined with
 * the rest when it does not exist yet. */
function realOrAncestor(path, realpath) {
  let current = path;
  const rest = [];
  for (;;) {
    try { return resolve(realpath(current), ...rest.reverse()); }
    catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      rest.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

/** Why a call is refused once its path arguments are resolved on disk, or
 * null. A relative path is the checkout's (the run's --work-dir). */
export function amuxV22KimiToolCallGuard(name, args, worktreePath,
  { realpath = realpathSync } = {}) {
  const lexical = amuxV22KimiToolInputRefusal(name, args, worktreePath);
  if (lexical) return lexical;
  const root = realpath(worktreePath);
  for (const key of AMUX_V22_KIMI_TOOL_ARGUMENTS[name].paths) {
    if (!Object.hasOwn(args, key)) continue;
    const real = realOrAncestor(resolve(worktreePath, args[key]), realpath);
    if (real !== root && !real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
      return "tool_path";
  }
  return null;
}

/** The hook: argv is the checkout and the decision log. Exit 0 allows, 2 blocks. */
export function runAmuxV22KimiToolGuardHook({ argv = process.argv.slice(2),
  stdin = () => readFileSync(0, "utf8"), append = appendFileSync,
  realpath = realpathSync } = {}) {
  const [worktreePath, decisionLog] = argv;
  let reason;
  try {
    const input = JSON.parse(stdin());
    reason = input?.hook_event_name !== undefined && input.hook_event_name !== "PreToolUse" ?
      "event" : amuxV22KimiToolCallGuard(input?.tool_name, input?.tool_input, worktreePath,
        { realpath });
  } catch { reason = "unreadable"; }
  try { append(decisionLog, reason === null ? "allow\n" : `block ${reason}\n`); }
  catch { reason ??= "log"; }
  if (reason === null) return 0;
  try {
    process.stderr.write("This run may only read files inside its checkout with ReadFile, Glob or Grep.\n");
  } catch { /* the exit code alone blocks */ }
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runAmuxV22KimiToolGuardHook();
