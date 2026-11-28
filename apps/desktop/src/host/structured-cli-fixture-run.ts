import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { killTree } from "../../../tomverse-cli/src/commands.js";
import { same } from "../../../tomverse-cli/src/workspace.js";
import { cliFixtureInput, qwenFixtureInput, qwenSubscriptionBaseUrl, qwenSubscriptionFixtureToken, zCodeFixtureInput,
  type CliFixtureInput, type QwenFixtureInput } from "./cli-fixture-input";
import { isolatedCliEnvironment, stageQwenRelease, unpackCliArchive, vibeProbeSettings } from "./cli-protocol";
import { antigravityLaunch } from "./antigravity-fixture";
import { deepSeekLaunch, deepSeekStartupDirectory } from "./deepseek-fixture";
import { grokLaunch } from "./grok-fixture";
import { miniMaxLaunch } from "./minimax-fixture";
import { assertProjectRoot } from "./project-root";
import { observeAcpTurn } from "./acp-turn";
import { nativePatchName } from "./native-patches";
import { stageCliExecutable } from "./provider-cli-path";
import { spawnNativeFixture } from "./spawn-native-fixture";
import { nativeReadName } from "./native-mcp-server";
import { zCodeLaunch } from "./zcode-fixture";
import { zCodeRuntimeTemp } from "./zcode-runtime";
import { observeZCodeTurn } from "./zcode-turn";

const rejectTools = [
  "agent", "ask_user_question", "enter_plan_mode", "enter_worktree", "exit_plan_mode", "exit_worktree",
  "get_goal", "list_agents", "record_artifact", "report_findings", "send_message", "skill", "task_stop", "update_goal",
];

function assertDisposableProject(temp: string, project: string, configurationDirectory: string) {
  const child = relative(temp, project);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("ACP requires a temporary fixture folder.");
  const extraConfiguration = {
    ".vibe": [".agents", "cordis.yml", "cordis.patch.yml"],
    ".dsh": [".agents", "cordis.yml", "cordis.patch.yml"],
    ".zcode": [".claude", ".agents", "zcode.json", ".zcode-plugin"],
    ".minimax": [".claude", ".agents", ".mcode", "mcode.yaml", "mcode.json"],
    ".grok": [".claude", ".claude.json", ".cursor", ".agents", ".envrc"],
    ".gemini": [".agents", ".antigravity", ".claude", "mcp_config.json", "hooks.json", ".envrc"],
  } as Record<string, string[]>;
  const configuration = [".qwen", ".kimi-code", ".mcp.json", ".env", configurationDirectory,
    ...(extraConfiguration[configurationDirectory] ?? [])];
  for (let current = project; !same(current, temp); current = dirname(current)) {
    if (configuration.some((name) => existsSync(join(current, name)))) {
      throw new Error("A local configuration would alter the CLI fixture.");
    }
  }
}

export async function runStructuredCliFixture(fixtureInput: CliFixtureInput,
  input: Omit<Parameters<typeof observeAcpTurn>[1], "origin" | "version" | "model" | "provider" | "qwenSubscription"> & {
    provider: Parameters<typeof observeAcpTurn>[1]["provider"] | "zhipu";
    deepSeekStartupParent?: string;
    retainedProfile?: string; beforeStart?: (signal: AbortSignal) => Promise<void>;
  },
  publish: Parameters<typeof observeAcpTurn>[2],
  registerFollowUp?: Parameters<typeof observeAcpTurn>[3],
) {
  const zCodeFixture = input.provider === "zhipu" ? zCodeFixtureInput.parse(fixtureInput) : undefined;
  const qwenFixture = input.provider === "qwen" ? qwenFixtureInput.parse(fixtureInput) : undefined;
  const fixture = zCodeFixture ?? qwenFixture ?? cliFixtureInput.parse(fixtureInput);
  const qwenSubscription = !!qwenFixture?.subscriptionCa;
  const agent = input.mode === "agent";
  const kimi = input.provider === "moonshot";
  const vibe = input.provider === "mistral";
  const deepSeek = input.provider === "deepseek";
  const zcode = !!zCodeFixture;
  const minimax = input.provider === "minimax";
  const grok = input.provider === "xai";
  const antigravity = input.provider === "google";
  const configurationDirectory = antigravity ? ".gemini" : grok ? ".grok" : minimax ? ".minimax" : zcode ? ".zcode" : deepSeek ? ".dsh" : vibe ? ".vibe" : kimi ? ".kimi-code" : ".qwen";
  if ((agent && (!fixture.allowFileEdits || !input.patchTool || !input.retainedProfile)) ||
      (qwenSubscription && (input.mode !== "ask" || input.previous)) ||
      (!agent && input.patchTool) || (input.retainedProfile && !fixture.allowSavedHistory) || /^[\/!]/.test(input.prompt.trimStart())) {
    throw new Error("Invalid ACP fixture scope.");
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]);
  const temp = await realpath(tmpdir());
  assertProjectRoot(input.project);
  assertDisposableProject(temp, input.project.path, configurationDirectory);
  const runtimeTemp = zcode ? await zCodeRuntimeTemp(temp) : temp;
  const directory = await mkdtemp(join(runtimeTemp, "tomverse-acp-release-"));
  const retainedProfile = qwenSubscription ? undefined : input.retainedProfile;
  const profile = retainedProfile ?? join(directory, "profile");
  let startupDirectory: string | undefined;
  let child: ReturnType<typeof spawnNativeFixture> | undefined;
  let closed: Promise<number | null> | undefined;
  let force: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forceClose = () => {
    if (child && child.exitCode === null && child.signalCode === null) force ??= killTree(child).catch(() => child?.kill("SIGKILL"));
    return force;
  };
  const cancel = () => { timer ??= setTimeout(forceClose, 6_000); };
  try {
    const profilePath = relative(retainedProfile ? temp : directory, profile);
    if (!profilePath || profilePath.startsWith("..") || isAbsolute(profilePath) || !same(await realpath(dirname(profile)), dirname(profile))) {
      throw new Error("The ACP fixture profile changed.");
    }
    if (!input.previous) await mkdir(profile, { mode: 0o700 });
    if (!same(await realpath(profile), profile)) throw new Error("The ACP fixture profile moved.");
    const environment = { ...isolatedCliEnvironment(process.env, directory),
      HTTP_PROXY: fixture.origin, HTTPS_PROXY: fixture.origin, ALL_PROXY: fixture.origin, NO_PROXY: "127.0.0.1", NODE_USE_ENV_PROXY: "1",
    };
    const zCodeRuntime = zCodeFixture ? await zCodeLaunch(zCodeFixture, directory, profile, !!input.previous, signal) : undefined;
    const { executable, args, env } = zCodeRuntime ?? (antigravity ? await antigravityLaunch(fixture, directory, profile, !!input.previous, signal) :
      grok ? await grokLaunch(fixture, directory, profile, !!input.previous, signal) :
      minimax ? await miniMaxLaunch(fixture, directory, profile, !!input.previous, signal) :
      deepSeek ? await deepSeekLaunch(fixture, directory, profile, !!input.previous, signal) :
      vibe ? await vibeLaunch(fixture, directory, profile, agent, !!input.previous, signal) :
      kimi ? await kimiLaunch(fixture, directory, profile, agent, signal) :
        await qwenLaunch(fixture, directory, profile, temp, agent, signal));
    await input.beforeStart?.(signal);
    startupDirectory = deepSeek ? await deepSeekStartupDirectory(input.project.path, input.deepSeekStartupParent) : undefined;
    signal.throwIfAborted();
    assertProjectRoot(input.project);
    assertDisposableProject(temp, input.project.path, configurationDirectory);
    const launch = (proxy?: string) => {
      const override = proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, ZCODE_HTTP_PROXY: proxy,
        ZCODE_NO_PROXY: "127.0.0.1", ZCODE_HTTP_TIMEOUT: "4500" } : {};
      const launched = spawnNativeFixture(executable, args, {
        cwd: startupDirectory ?? input.project.path, env: { ...environment, ...env, ...override },
      });
      child = launched;
      closed = new Promise((resolve) => launched.once("close", resolve));
      launched.on("error", () => undefined);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      return launched;
    };
    const turn = { ...input,
      protectedRoots: [...input.protectedRoots, directory, profile, join(input.project.path, configurationDirectory),
        ...(startupDirectory ? [startupDirectory] : [])],
      model: fixture.model, origin: fixture.origin, version: fixture.version, signal };
    const outcome = input.provider === "zhipu" ? await observeZCodeTurn(launch, { ...turn, codingPlanRevision: zCodeRuntime?.codingPlanRevision }, publish, registerFollowUp) :
      await observeAcpTurn(launch(), { ...turn, provider: input.provider, qwenSubscription }, publish, registerFollowUp);
    if (!child || !closed) throw new Error("The CLI fixture did not launch.");
    child.stdout.resume();
    if (kimi) {
      if (force || child.exitCode !== null || child.signalCode !== null) return { status: "unknown" as const };
      // Once the session close is acknowledged, stop the fixture tree while its pipes are still open.
      clearTimeout(timer);
      const tree = await killTree(child);
      if (!tree.treeChecked || tree.residual.length ||
          !await Promise.race([closed.then(() => true), delay(5_000, false, { ref: false })])) return { status: "unknown" as const };
    } else {
      child.stdin.end();
      const exit = await Promise.race([closed, delay(5_000, null, { ref: false })]);
      if (force || exit !== 0) return { status: "unknown" as const };
    }
    publish(outcome);
    return outcome.status === "blocked" ? { status: outcome.status, quota: outcome.quota } : { status: outcome.status };
  } catch {
    return { status: child?.pid ? "unknown" as const : signal.aborted ? "stopped" as const : "failed" as const };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    await forceClose();
    if (!closed || await Promise.race([closed.then(() => true), delay(5_000, false, { ref: false })])) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
      if (startupDirectory) await rmdir(startupDirectory).catch(() => undefined);
    } else {
      child?.stdin.destroy();
      child?.stdout.destroy();
    }
  }
}

async function vibeLaunch(fixture: CliFixtureInput, directory: string, profile: string, agent: boolean, resume: boolean, signal: AbortSignal) {
  const tools = [nativeReadName, ...(agent ? [nativePatchName] : [])].map((name) => "desktop_" + name);
  const config = vibeProbeSettings + [
    `enabled_tools = ${JSON.stringify(["todo", ...tools])}`,
    `active_model = ${JSON.stringify(fixture.model)}`,
    `allowed_models = ${JSON.stringify([fixture.model])}`,
    "[[providers]]", 'name = "local"', `api_base = ${JSON.stringify(fixture.origin + "/v1")}`,
    'api_key_env_var = ""', 'backend = "generic"',
    "[[models]]", `name = ${JSON.stringify(fixture.model)}`, `alias = ${JSON.stringify(fixture.model)}`,
    'provider = "local"', "input_price = 0", "output_price = 0",
    ...tools.flatMap((name) => [`[tools.${name}]`, 'permission = "always"']),
    ...["read_file", "write_file", "edit", "bash"].flatMap((name) => [`[tools.${name}]`, 'permission = "never"']),
    "[session_logging]", "generate_titles = false", "",
  ].join("\n");
  const path = join(profile, "config.toml");
  if (resume) {
    const file = await lstat(path);
    if (!file.isFile() || file.size !== Buffer.byteLength(config) || !same(await realpath(path), path) ||
        await readFile(path, "utf8") !== config) throw new Error("Vibe's saved Desktop configuration changed.");
  } else await writeFile(path, config, { mode: 0o600, flag: "wx" });
  const distribution = await unpackCliArchive("mistral", fixture.executable, directory, fixture.version, signal);
  return { executable: join(distribution, process.platform === "win32" ? "vibe-acp.exe" : "vibe-acp"), args: [],
    env: { VIBE_HOME: profile, PYTHONNOUSERSITE: "1" } };
}

async function qwenLaunch(fixture: QwenFixtureInput, directory: string, profile: string, temp: string, agent: boolean, signal: AbortSignal) {
  const { executable, entry } = await stageQwenRelease(fixture.executable, directory, fixture.version, signal);
  const mode = agent ? "default" : "plan";
  const tools = ["read_file", "todo_write", ...(agent ? ["write_file"] : [])];
  const auth = fixture.subscriptionCa ? "qwen-subscription" : "openai";
  const settings = {
    general: { enableAutoUpdate: false, batchAutoCollect: false },
    ui: { enableFollowupSuggestions: false },
    memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false, enableAutoSkill: false },
    telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false }, disableAllHooks: true,
    security: { auth: { selectedType: auth } }, model: { name: fixture.model, ...(fixture.subscriptionCa && { baseUrl: qwenSubscriptionBaseUrl }) },
    ...(!fixture.subscriptionCa && {
      modelProviders: { openai: [{ id: fixture.model, name: fixture.model, baseUrl: `${fixture.origin}/v1`, envKey: "OPENAI_API_KEY" }] },
    }),
    permissions: { deny: rejectTools },
    tools: { core: tools, toolSearch: { enabled: false }, todoWrite: { enabled: true }, approvalMode: mode },
  };
  const systemSettings = join(directory, "system.json");
  await Promise.all([writeFile(join(profile, "settings.json"), JSON.stringify(settings)), writeFile(systemSettings, "{}")]);
  const args = [entry, "--acp", "--approval-mode", mode, `--auth-type=${auth}`, "--model", fixture.model];
  const env = { QWEN_HOME: profile, QWEN_USAGE_STATISTICS_ENABLED: "false", QWEN_CODE_SYSTEM_SETTINGS_PATH: systemSettings,
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: systemSettings };
  if (fixture.subscriptionCa) {
    const ca = fixture.subscriptionCa;
    const path = relative(temp, ca);
    if (!isAbsolute(ca) || !path || path.startsWith("..") || isAbsolute(path) || !same(await realpath(ca), ca)) {
      throw new Error("Qwen Code requires a temporary test CA.");
    }
    const info = await lstat(ca);
    if (!info.isFile() || info.size > 16_384) throw new Error("Invalid Qwen Code test CA.");
    const tokens = { access_token: qwenSubscriptionFixtureToken, refresh_token: qwenSubscriptionFixtureToken, token_type: "Bearer",
      expires_in: 3600, expiresAt: Date.now() + 3_600_000, scope: "model:invoke" };
    await writeFile(join(profile, "subscription_credentials.json"), JSON.stringify({ revision: "0a7a1efa-aa85-4384-b8cd-0134657fcc36",
      baseUrl: "https://auth.qwen.ai", clientId: "qwen-code-cli", models: [fixture.model], modelMetadata: {}, tokens,
    }), { mode: 0o600, flag: "wx" });
    return { executable, args: [...args, "--proxy", fixture.origin], env: { ...env, NODE_EXTRA_CA_CERTS: ca } };
  }
  return { executable, args, env: { ...env, OPENAI_API_KEY: "tomverse-loopback-only", OPENAI_BASE_URL: `${fixture.origin}/v1` } };
}

async function kimiLaunch(fixture: CliFixtureInput, directory: string, profile: string, agent: boolean, signal: AbortSignal) {
  const executable = await stageCliExecutable("moonshot", fixture.executable, directory, fixture.version, signal);
  const tools = ["Read", "TodoList", ...(agent ? ["Write"] : [])];
  const config = [
    'defaultModel = "local"',
    "[models.local]",
    `name = ${JSON.stringify(fixture.model)}`,
    'protocol = "openai"',
    `baseUrl = ${JSON.stringify(`${fixture.origin}/v1`)}`,
    'apiKey = "tomverse-loopback-only"',
    "maxContextSize = 16384",
    "[tools]",
    `enabled = ${JSON.stringify(tools)}`,
    "",
  ].join("\n");
  await writeFile(join(profile, "config.toml"), config, { mode: 0o600 });
  return { executable, args: ["acp"], env: { KIMI_CODE_HOME: profile, KIMI_DISABLE_TELEMETRY: "1",
    KIMI_CODE_BASE_URL: fixture.origin, KIMI_CODE_OAUTH_HOST: fixture.origin } };
}
