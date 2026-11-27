import type { ChildProcessByStdio } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { killTree } from "../../../tomverse-cli/src/commands.js";
import { same } from "../../../tomverse-cli/src/workspace.js";
import type { CodeNativeAssignment, RunStatus } from "../contract";
import { cliFixtureInput, type CliFixtureInput } from "./cli-fixture-input";
import { codexFixtureProvider, inspectCodexSavedTurn, observeCodexFixtureTurn,
  type CodexPreviousTurn, type CodexSteer, type CodexTurnObservation } from "./codex-turn";
import { startCodexWorkspace, type CodexWorkspace } from "./codex-workspace";
import { nativeListName, nativeReadName } from "./native-mcp-server";
import type { NativePatchTool } from "./native-patches";
import { assertProjectRoot, type ProjectRoot } from "./project-root";
import { stageCliExecutable } from "./provider-cli-path";
import { spawnNativeFixture } from "./spawn-native-fixture";

type Process = ChildProcessByStdio<Writable, Readable, null>;
const stillRunning = (child: Process) => child.exitCode === null && child.signalCode === null;
const closingDeadline = Symbol("closing-deadline");
const workspaceToken = "TOMVERSE_CODEX_WORKSPACE_TOKEN";

type FixtureResult<T> = { status: "confirmed"; value: T } | { status: "stopped" | "failed" | "unknown" };

async function withCodexFixture<T>(
  fixtureInput: CliFixtureInput,
  input: { project: ProjectRoot; signal: AbortSignal; inspection?: true; history?: { home: string; existing: boolean };
    readWorkspace?: { protectedRoots: string[]; connectionKey: string } },
  observe: (child: Process, home: string, signal: AbortSignal, workspace?: CodexWorkspace) => Promise<T>,
): Promise<FixtureResult<T>> {
  let directory: string | undefined;
  let child: Process | undefined;
  let closed: Promise<number | null> | undefined;
  let force: Promise<unknown> | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let workspace: CodexWorkspace | undefined;
  const abort = AbortSignal.any([input.signal, AbortSignal.timeout(input.inspection ? 45_000 : 90_000)]);
  const forceClose = () => {
    if (child && stillRunning(child)) force ??= killTree(child).catch(() => child?.kill("SIGKILL"));
    return force;
  };
  const onCancel = () => {
    if (input.inspection) child?.stdout.destroy();
    else cancelTimer ??= setTimeout(forceClose, 8_000);
  };
  try {
    const fixture = cliFixtureInput.parse(fixtureInput);
    abort.throwIfAborted();
    const temp = await realpath(tmpdir());
    const project = relative(temp, input.project.path);
    if (!project || project.startsWith("..") || isAbsolute(project) || !isAbsolute(fixture.executable)) throw new Error("Invalid fixture path.");
    assertProjectRoot(input.project);
    directory = await mkdtemp(join(temp, "tomverse-codex-fixture-"));
    const home = input.history ? resolve(input.history.home) : join(directory, "home");
    const retained = relative(temp, home);
    if (!retained || retained.startsWith("..") || isAbsolute(retained) || !same(await realpath(dirname(home)), dirname(home))) {
      throw new Error("Invalid fixture profile path.");
    }
    if (!input.history?.existing) await mkdir(home, { mode: 0o700 });
    if (!(await lstat(home)).isDirectory() || !same(await realpath(home), home)) throw new Error("The fixture profile changed.");
    const toolTemp = join(directory, "temp");
    await mkdir(toolTemp, { mode: 0o700 });
    const executable = await stageCliExecutable("openai", fixture.executable, directory, fixture.version, abort);
    const config = [
      `model = ${JSON.stringify(fixture.model)}`, `model_provider = "${codexFixtureProvider}"`, 'web_search = "disabled"',
      `[model_providers.${codexFixtureProvider}]`, 'name = "Tomverse loopback fixture"',
      `base_url = ${JSON.stringify(`${fixture.origin}/v1`)}`, 'wire_api = "responses"', "requires_openai_auth = false",
      "request_max_retries = 0", "stream_max_retries = 0", "supports_websockets = false",
      "[tools.update_plan]", "enabled = true",
    ].join("\n");
    const configPath = join(home, "config.toml");
    if (input.history?.existing) {
      if (!(await lstat(configPath)).isFile() || !same(await realpath(configPath), configPath) || await readFile(configPath, "utf8") !== config) {
        throw new Error("The saved Codex configuration changed.");
      }
    } else {
      await writeFile(configPath, config, { flag: "wx", mode: 0o600 });
    }
    abort.throwIfAborted();
    assertProjectRoot(input.project);
    if (input.readWorkspace) workspace = await startCodexWorkspace({ ...input.readWorkspace, project: input.project, signal: abort });
    const readConfig = workspace ? ["--disable", "shell_tool", "--disable", "shell_snapshot",
      "-c", `mcp_servers.desktop.url=${JSON.stringify(workspace.descriptor.url)}`,
      "-c", `mcp_servers.desktop.bearer_token_env_var=${JSON.stringify(workspaceToken)}`,
      "-c", `mcp_servers.desktop.enabled_tools=${JSON.stringify([nativeListName, nativeReadName])}`,
      "-c", `mcp_servers.desktop.tools.${nativeListName}.approval_mode="approve"`,
      "-c", `mcp_servers.desktop.tools.${nativeReadName}.approval_mode="approve"`,
      "-c", "mcp_servers.desktop.required=true"] : [];
    child = spawnNativeFixture(executable, ["app-server", "--listen", "stdio://", "--disable", "remote_control", ...readConfig], {
      cwd: input.project.path,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        PATH: process.platform === "win32" ? directory : "/usr/bin:/bin", HOME: directory, CODEX_HOME: home, USERPROFILE: directory,
        APPDATA: directory, LOCALAPPDATA: directory, TEMP: toolTemp, TMP: toolTemp, TMPDIR: toolTemp,
        HTTP_PROXY: fixture.origin, HTTPS_PROXY: fixture.origin, ALL_PROXY: fixture.origin, NO_PROXY: "127.0.0.1",
        ...(workspace && { [workspaceToken]: workspace.descriptor.headers[0]!.value.slice("Bearer ".length) }) },
    });
    closed = new Promise((resolve) => child!.once("close", resolve));
    child.on("error", () => undefined);
    abort.addEventListener("abort", onCancel, { once: true });
    if (abort.aborted) onCancel();
    const childExited = new AbortController();
    child.once("exit", () => childExited.abort());
    const value = await observe(child, home, AbortSignal.any([abort, childExited.signal]), workspace);
    child.stdout.resume();
    child.stdin.end();
    const exit = await Promise.race([closed, delay(5_000, closingDeadline, { ref: false })]);
    if (exit !== 0 || force || (input.inspection && abort.aborted)) return { status: "unknown" };
    return { status: "confirmed", value };
  } catch {
    return { status: child?.pid ? "unknown" : input.signal.aborted ? "stopped" : "failed" };
  } finally {
    clearTimeout(cancelTimer);
    abort.removeEventListener("abort", onCancel);
    await forceClose();
    const exited = !closed || await Promise.race([closed, delay(5_000, closingDeadline, { ref: false })]) !== closingDeadline;
    if (!exited) {
      child?.stdin.destroy();
      child?.stdout.destroy();
    }
    await workspace?.close().catch(() => undefined);
    if (directory && exited) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}

export async function runCodexFixture(
  fixture: CliFixtureInput,
  input: { project: ProjectRoot; prompt: string; mode: "ask" | "plan" | "agent"; clientVersion: string; signal: AbortSignal; patchTool?: NativePatchTool;
    protectedRoots?: string[]; connectionKey?: string;
    effort?: "low" | "medium" | "high"; history?: { home: string; previous?: CodexPreviousTurn }; verifyDestination?: true; verifySource?: (signal: AbortSignal) => Promise<void> },
  publish: (observation: CodexTurnObservation) => void,
  steeringReady: (steer: CodexSteer) => void,
): Promise<Extract<RunStatus, "completed" | "stopped" | "failed" | "unknown" | "blocked">> {
  if (input.mode !== "ask" && (!input.protectedRoots || !input.connectionKey)) return "failed";
  const run = await withCodexFixture(fixture, {
    project: input.project, signal: input.signal, history: input.history && { home: input.history.home, existing: !!input.history.previous },
    readWorkspace: input.mode !== "ask" && input.protectedRoots && input.connectionKey
      ? { protectedRoots: input.protectedRoots, connectionKey: input.connectionKey } : undefined,
  }, (child, profile, signal, workspace) => observeCodexFixtureTurn(child, {
    profile, root: input.project.path, model: fixture.model, version: input.clientVersion, prompt: input.prompt, signal,
    planOnly: input.mode === "plan", history: input.history, patchTool: input.patchTool, effort: input.effort,
    verifyDestination: input.verifyDestination, verifySource: input.verifySource, workspace,
  }, publish, steeringReady));
  if (run.status !== "confirmed") return run.status;
  if (run.value.hasUnconfirmedCommand) return "unknown";
  if (run.value.usageLimitExceeded) return "blocked";
  if (run.value.status === "interrupted") return "stopped";
  return run.value.status === "completed" ? "completed" : "failed";
}

export async function inspectCodexFixtureHistory(fixture: CliFixtureInput,
  input: { project: ProjectRoot; clientVersion: string; signal: AbortSignal; home: string; session: CodeNativeAssignment }) {
  if (input.session.model !== fixture.model) return null;
  const result = await withCodexFixture(fixture, {
    project: input.project, signal: input.signal, inspection: true, history: { existing: true, home: input.home },
  }, (child, profile, signal) => inspectCodexSavedTurn(child, {
    profile, root: input.project.path, version: input.clientVersion, signal, session: input.session,
  }));
  return result.status === "confirmed" ? result.value : null;
}
