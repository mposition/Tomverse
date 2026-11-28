import type { ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { killTree } from "../../../tomverse-cli/src/commands.js";
import type { CodeNativeAssignment, CodeTaskPlan, RunStatus } from "../contract";
import { cliFixtureInput, type CliFixtureInput } from "./cli-fixture-input";
import { assertLocalClaudeDirectory, findClaudeTranscript } from "./claude-transcript";
import { claudePatchServer, claudePatchToolName } from "./claude-patch-protocol";
import { claudeReadOnlyTools, observeClaudeFixtureTurn, type ClaudeTurnObservation } from "./claude-turn";
import type { NativePatchTool } from "./native-patches";
import { assertProjectRoot, type ProjectRoot } from "./project-root";
import { stageCliExecutable } from "./provider-cli-path";
import { spawnNativeFixture } from "./spawn-native-fixture";

const closingDeadline = Symbol("closing-deadline");
type SavedContext = { session: CodeNativeAssignment; plan?: CodeTaskPlan };
type ClosedClaudeRun = { status: Extract<RunStatus, "completed" | "stopped" | "failed" | "unknown"> } |
  { status: "blocked"; quota: NonNullable<ClaudeTurnObservation["quota"]> };

export async function runClaudeFixture(fixtureInput: CliFixtureInput,
  input: { project: ProjectRoot; prompt: string; mode: "ask" | "plan" | "agent"; signal: AbortSignal; history?: { home: string; previous?: SavedContext };
    beforeStart?: (signal: AbortSignal) => Promise<void>; patchTool?: NativePatchTool },
  publish: (observation: ClaudeTurnObservation) => void,
  registerFollowUp?: Parameters<typeof observeClaudeFixtureTurn>[3],
): Promise<ClosedClaudeRun> {
  let directory: string | undefined;
  let child: ChildProcessByStdio<Writable, Readable, null> | undefined;
  let closed: Promise<number | null> | undefined;
  let force: Promise<unknown> | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(90_000)]);
  const forceClose = () => {
    if (child && child.exitCode === null && child.signalCode === null) force ??= killTree(child).catch(() => child?.kill("SIGKILL"));
    return force;
  };
  const onCancel = () => { cancelTimer ??= setTimeout(forceClose, 6_000); };
  try {
    const fixture = cliFixtureInput.parse(fixtureInput);
    const agent = input.mode === "agent";
    if (agent ? !fixture.allowFileEdits || !input.history || !input.patchTool : input.patchTool) {
      throw new Error("Invalid Claude Code fixture edit scope.");
    }
    signal.throwIfAborted();
    const temp = await realpath(tmpdir());
    const project = relative(temp, input.project.path);
    if (!project || project.startsWith("..") || isAbsolute(project) || !isAbsolute(fixture.executable)) throw new Error("Invalid fixture path.");
    assertProjectRoot(input.project);
    directory = await mkdtemp(join(temp, "tomverse-claude-fixture-"));
    const history = input.history;
    const previous = history?.previous;
    const profile = history ? resolve(history.home) : join(directory, "home");
    const retained = relative(temp, profile);
    if ((history && !fixture.allowSavedHistory) || !retained || retained.startsWith("..") || isAbsolute(retained)) {
      throw new Error("Invalid fixture profile path.");
    }
    await assertLocalClaudeDirectory(dirname(profile));
    if (!previous) await mkdir(profile, { mode: 0o700 });
    await assertLocalClaudeDirectory(profile);
    const sessionId = previous ? z.uuid().parse(previous.session.threadId) : randomUUID();
    if (previous) {
      if (previous.session.model !== fixture.model || previous.session.provider !== "anthropic") throw new Error("The saved Claude session changed.");
      await findClaudeTranscript(profile, sessionId);
    }
    const home = join(directory, "home-env");
    const toolTemp = join(directory, "temp");
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(toolTemp, { mode: 0o700 })]);
    const executable = await stageCliExecutable("anthropic", fixture.executable, directory, fixture.version, signal);
    if (input.beforeStart) await input.beforeStart(signal);
    signal.throwIfAborted();
    assertProjectRoot(input.project);
    // The pinned CLI omits TaskCreate and TaskUpdate in bare mode.
    const mcpServers = agent ? { [claudePatchServer]: { type: "sdk", name: claudePatchServer } } : {};
    const args = [
      "--print", "--restricted", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--include-partial-messages", "--replay-user-messages", "--permission-mode", agent ? "default" : "plan", "--permission-prompts", "none",
      "--tools", claudeReadOnlyTools.join(","), "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers }),
      "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands",
      "--model", fixture.model, "--max-turns", "12", previous ? "--resume" : "--session-id", sessionId,
    ];
    if (!history) args.push("--no-session-persistence");
    const summarizeAnalysis = "Inspect relevant project files read-only first. If inspection leaves the requested outcome or change scope unclear, ask a focused question and wait. Use TaskCreate or TaskUpdate to publish the analysis as a JSON string in the task description with objective, verifiedFacts (array of strings), assumptions (array of strings), scope, verification, and completion.";
    if (agent) args.push("--allowedTools", claudePatchToolName, "--append-system-prompt",
      `${summarizeAnalysis} A simple answer does not need a plan. For an edit, mark the task in_progress. Provide fresh analysis after a new instruction or on resume. Then propose workspace-relative file edits through the Desktop patch tool. Desktop requires approval for each patch. Respect any denial.`);
    if (input.mode === "plan") args.push("--append-system-prompt", `${summarizeAnalysis} Publish an ordered task list with pending items and stop before implementation.`);
    child = spawnNativeFixture(executable, args, {
      cwd: input.project.path,
      env: {
        SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: directory,
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: toolTemp, TMP: toolTemp, TMPDIR: toolTemp,
        CLAUDE_CONFIG_DIR: profile, ANTHROPIC_BASE_URL: fixture.origin, ANTHROPIC_API_KEY: "sk-ant-tomverse-loopback-only",
        HTTP_PROXY: fixture.origin, HTTPS_PROXY: fixture.origin, ALL_PROXY: fixture.origin, NO_PROXY: "127.0.0.1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_TASK_LIST_ID: sessionId,
      },
    });
    closed = new Promise((resolve) => child!.once("close", resolve));
    child.on("error", () => undefined);
    signal.addEventListener("abort", onCancel, { once: true });
    if (signal.aborted) onCancel();
    const result = await observeClaudeFixtureTurn(child, { project: input.project, sessionId, turnId: randomUUID(),
      model: fixture.model, prompt: input.prompt, signal, previousPlan: previous?.plan, patchTool: input.patchTool,
      planOnly: input.mode === "plan" }, publish, registerFollowUp);
    child.stdout.resume();
    child.stdin.end();
    const exit = await Promise.race([closed, delay(5_000, closingDeadline, { ref: false })]);
    if (force || result.unconfirmed) return { status: "unknown" };
    if (result.status === "interrupted" && (exit === 0 || exit === 1) && signal.aborted) {
      if (history) await findClaudeTranscript(profile, sessionId);
      return { status: "stopped" };
    }
    if (result.status === "blocked" && result.quota && !signal.aborted && (exit === 0 || exit === 1)) {
      return { status: "blocked", quota: result.quota };
    }
    if (exit !== 0 || (signal.aborted && result.status !== "completed")) return { status: "unknown" };
    return { status: result.status === "completed" ? "completed" : "failed" };
  } catch {
    return { status: child?.pid ? "unknown" : input.signal.aborted ? "stopped" : "failed" };
  } finally {
    clearTimeout(cancelTimer);
    signal.removeEventListener("abort", onCancel);
    await forceClose();
    const exited = !closed || await Promise.race([closed, delay(5_000, closingDeadline, { ref: false })]) !== closingDeadline;
    if (!exited) {
      child?.stdin.destroy();
      child?.stdout.destroy();
    }
    if (directory && exited) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
}
