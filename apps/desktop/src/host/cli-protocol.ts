import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { commandEnv } from "../../../tomverse-cli/src/env.js";
import { unknownCliAccount, type CliAccount, type CliProtocolCheck, type CliProtocolModel, type CliProtocolProvider,
  type IsolatedAcpAccountProvider } from "../code-execution";
import { releaseArchiveName, stageCliArchive, stageCliExecutable } from "./provider-cli-path";
import { miniMaxRegion, stageMiniMaxRuntime } from "./minimax-runtime";
import { stageZCodeRuntime, zCodeRuntimeTemp } from "./zcode-runtime";

const maxOutputBytes = 256 * 1024;
export const vibeProbeSettings = [
  'default_approval_policy = "ask"', 'enabled_agents = ["ask"]', "enable_auto_approve = false", 'outside_workdir = "deny"',
  "enable_subagents = false", "enable_background_processes = false",
  "enable_connectors = false", "enable_telemetry = false", "enable_update_checks = false", "enable_notifications = false",
  "enable_pr_monitoring = false", "",
].join("\n");
export type Frame = Record<string, unknown>;
type ProtocolIo = {
  send: (frame: Frame) => void;
  read: (match: (frame: Frame) => boolean, acceptError?: boolean) => Promise<Frame>;
};
type VerifiedProtocol = Extract<CliProtocolCheck, { status: "verified" }>;
type Versions = { client: string; executable: string };
type AcpProvider = Exclude<CliProtocolProvider, "openai" | "anthropic" | "zhipu">;

const frameSchema = z.record(z.string(), z.unknown());
const id = z.string().min(1).max(160).regex(/^[\w.:/[\]-]+$/);
const name = z.string().trim().min(1).max(160);
const effort = z.string().min(1).max(24).regex(/^[a-z][a-z0-9_-]*$/);
const codexPlatform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
const codexInit = z.object({ codexHome: z.string(), platformOs: z.literal(codexPlatform) });
const codexModels = z.object({
  data: z.array(z.object({ id, displayName: name, hidden: z.boolean().optional(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: effort })).max(12).optional() })).max(20),
  nextCursor: z.string().max(4096).nullable(),
});
const claudeControl = z.object({ subtype: z.literal("success"), request_id: z.string(), response: z.object({
  current_permission_mode: z.enum(["plan", "default"]),
  models: z.array(z.object({ value: id, displayName: name, supportedEffortLevels: z.array(effort).max(12).optional() })).max(64),
}) });
const acpInit = z.object({ jsonrpc: z.literal("2.0"), result: z.object({
  protocolVersion: z.literal(1),
  agentInfo: z.object({ name, version: name }).optional(),
  authMethods: z.array(z.object({ id })).max(32).optional(),
  _meta: z.unknown().optional(),
  agentCapabilities: z.object({ loadSession: z.boolean().optional(),
    mcpCapabilities: z.object({ http: z.boolean().optional() }).optional(),
    sessionCapabilities: z.object({ close: z.object({}).optional(), resume: z.object({}).optional() }).optional(),
  }).optional(),
}) });
const acpAuthenticationRequired = z.object({ jsonrpc: z.literal("2.0"), result: z.never().optional(),
  error: z.object({ code: z.literal(-32000) }) });
const grokMcpUpdate = z.object({
  jsonrpc: z.literal("2.0"), method: z.literal("_x.ai/mcp/servers_updated"),
  params: z.object({ mcpServers: z.tuple([]) }),
}).strict();
const zCodeStorageUpdate = z.object({ method: z.literal("startup/storageState"), params: z.object({
  schemaVersion: z.literal(1), databaseKind: z.literal("session"),
  phase: z.enum(["checking", "waiting_for_lock", "migrating", "committing", "ready"]),
}) }).strict();
const zCodeSessionList = z.object({ id: z.string(), result: z.object({ sessions: z.tuple([]) }).strict() }).strict();
const acpAgentNames = {
  google: "Antigravity ACP Server", qwen: "qwen-code", moonshot: "Kimi Code CLI", mistral: "@mistralai/mistral-vibe",
  minimax: "minimax-code", deepseek: "deepseek-harness-acp",
} as const;

export async function* readCliFrames(stream: Readable, outputLimit = maxOutputBytes, options?: { destroyOnReturn: boolean }) {
  let buffer = "";
  let bytes = 0;
  stream.setEncoding("utf8");
  for await (const chunk of stream.iterator(options) as AsyncIterable<string>) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > outputLimit) throw new Error("The CLI protocol response exceeded its output limit.");
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield frameSchema.parse(JSON.parse(line));
    }
  }
  if (buffer.trim()) throw new Error("The CLI protocol ended with an incomplete message.");
}

function normalizeProfile(path: string) {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function initializeCodex(io: ProtocolIo, profile: string, version: string, dynamicTools = false) {
  io.send({ method: "initialize", id: 1, params: { clientInfo: { name: "tomverse_desktop", title: "Tomverse Desktop", version },
    ...(dynamicTools && { capabilities: { experimentalApi: true } }) } });
  const init = codexInit.parse((await io.read((message) => message.id === 1)).result);
  if (normalizeProfile(init.codexHome) !== normalizeProfile(profile)) throw new Error("Codex did not use the isolated profile.");
  io.send({ method: "initialized" });
}

async function inspectCodex(io: ProtocolIo, profile: string, version: string): Promise<VerifiedProtocol> {
  await initializeCodex(io, profile, version);
  const catalog = await readCodexCatalog(io);
  const models = catalog.data.filter((model) => !model.hidden).map((model) => ({ id: model.id, name: model.displayName,
    efforts: model.supportedReasoningEfforts?.map(({ reasoningEffort }) => reasoningEffort) ?? [] }));
  return { status: "verified", protocol: "codex_app_server", models: uniqueModels(models), catalogComplete: catalog.nextCursor === null };
}

function readCodexCatalog(io: ProtocolIo, id: number | string = 2, cursor?: string) {
  io.send({ method: "model/list", id, params: { limit: 20, includeHidden: false, ...(cursor ? { cursor } : {}) } });
  return io.read((message) => message.id === id).then((reply) => codexModels.parse(reply.result));
}

function readCodexAccount(io: ProtocolIo, id: string) {
  io.send({ method: "account/read", id, params: { refreshToken: false } });
  return io.read((message) => message.id === id).then((frame) => frame.result);
}

export async function inspectIsolatedCodexAccount(io: ProtocolIo, profile: string, clientVersion: string): Promise<CliAccount> {
  await initializeCodex(io, profile, clientVersion);
  const account = await readCodexAccount(io, "isolated-account");
  // Account data in an empty profile is outside the scope of this diagnostic.
  z.object({ account: z.null(), requiresOpenaiAuth: z.literal(true) }).parse(account);
  return { status: "signInRequired", billingSource: "unknown" };
}

export async function verifyCodexLoopbackDestination(io: ProtocolIo, model: string) {
  const account = await readCodexAccount(io, "fallback-account");
  // The custom loopback provider requires no OpenAI account. Any account would
  // be outside the isolated test's billing scope.
  z.object({ account: z.null(), requiresOpenaiAuth: z.literal(false) }).parse(account);
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 12; page += 1) {
    const catalog = await readCodexCatalog(io, `fallback-catalog-${page}`, cursor);
    const entry = catalog.data.find((entry) => entry.id === model && !entry.hidden);
    if (entry) return entry.supportedReasoningEfforts?.map(({ reasoningEffort }) => reasoningEffort) ?? [];
    if (!catalog.nextCursor || seen.has(catalog.nextCursor)) break;
    cursor = catalog.nextCursor;
    seen.add(cursor);
  }
  throw new Error("The CLI fallback model is unavailable.");
}

export async function initializeClaude(io: ProtocolIo, permissionMode: "plan" | "default" = "plan") {
  const requestId = randomUUID();
  io.send({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
  const message = await io.read((frame) => frame.type === "control_response");
  const reply = claudeControl.parse(message.response);
  if (reply.request_id !== requestId || reply.response.current_permission_mode !== permissionMode) {
    throw new Error("Claude Code returned an unexpected initialization response.");
  }
  return reply.response;
}

async function inspectClaude(io: ProtocolIo): Promise<VerifiedProtocol> {
  const { models: advertised } = await initializeClaude(io);
  const models = advertised.map((model) => ({ id: model.value, name: model.displayName, efforts: model.supportedEffortLevels ?? [] }));
  return { status: "verified", protocol: "claude_control", models: uniqueModels(models), catalogComplete: true };
}

export async function initializeAcp(io: ProtocolIo, provider: AcpProvider, versions: Versions,
  clientCapabilities: { fs?: { readTextFile: true; writeTextFile?: true } } = {}) {
  io.send({ jsonrpc: "2.0", method: "initialize", id: 1, params: {
    protocolVersion: 1, clientCapabilities, clientInfo: { name: "tomverse-desktop", title: "Tomverse Desktop", version: versions.client },
  } });
  const { result } = acpInit.parse(await io.read((message) => message.id === 1));
  // The pinned DeepSeek release reports the bridge version in its handshake.
  const agentVersion = provider === "deepseek" ? "0.0.1" : versions.executable;
  const expectedAgent = provider === "xai"
    ? result.authMethods?.some((method) => method.id === "grok.com") &&
      (!result.agentInfo || result.agentInfo.version === versions.executable)
    : result.agentInfo?.name === acpAgentNames[provider] && result.agentInfo.version === agentVersion;
  if (!expectedAgent) {
    throw new Error("The ACP agent identity did not match the verified CLI.");
  }
  return result;
}

async function inspectAcp(io: ProtocolIo, provider: AcpProvider, versions: Versions): Promise<VerifiedProtocol> {
  const { protocolVersion } = await initializeAcp(io, provider, versions);
  return { status: "verified", protocol: "acp", protocolVersion, models: null };
}

export async function inspectIsolatedAcpAccount(io: ProtocolIo, provider: IsolatedAcpAccountProvider,
    profile: string, versions: Versions): Promise<CliAccount> {
  const { authMethods, _meta } = await initializeAcp(io, provider, versions);
  if (provider === "xai") {
    // Grok advertises cached and API-key methods only when configured. An interactive method alone needs sign-in.
    const metadata = z.object({
      grokShell: z.literal(true), agentVersion: name, currentWorkingDirectory: z.string().min(1).max(4096),
      defaultAuthMethodId: z.null(),
    }).safeParse(_meta);
    if (authMethods?.length === 1 && authMethods[0].id === "grok.com" && metadata.success &&
        metadata.data.agentVersion === versions.executable &&
        normalizeProfile(metadata.data.currentWorkingDirectory) === normalizeProfile(profile)) {
      return { status: "signInRequired", billingSource: "unknown" };
    }
    return unknownCliAccount;
  }
  if (!authMethods?.length && provider !== "minimax") return unknownCliAccount;
  const id = randomUUID();
  io.send({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: profile, mcpServers: [] } });
  const response = await io.read((message) => message.id === id, true);
  const authRequired = provider === "minimax" ? acpAuthenticationRequired.extend({
    error: acpAuthenticationRequired.shape.error.extend({
      message: z.literal("Authentication required: Run `mcode login` and try again."),
    }),
  }) : acpAuthenticationRequired;
  return authRequired.safeParse(response).success
    ? { status: "signInRequired", billingSource: "unknown" }
    : unknownCliAccount;
}

async function inspectZCode(io: ProtocolIo): Promise<VerifiedProtocol> {
  const requestId = randomUUID();
  io.send({ method: "session/list", id: requestId, params: { limit: 1 } });
  zCodeSessionList.parse(await io.read((message) => message.id === requestId));
  return { status: "verified", protocol: "zcode_protocol", protocolVersion: 1, models: null };
}

function uniqueModels(models: CliProtocolModel[]) {
  if (new Set(models.map(({ id }) => id)).size !== models.length) throw new Error("The CLI advertised a duplicate model ID.");
  return models;
}

export function inspectCliProcess(child: ChildProcessByStdio<Writable, Readable, null>, provider: CliProtocolProvider,
    profile: string, versions: Versions, signal: AbortSignal): Promise<VerifiedProtocol> {
  return observeCliProcess(child, provider, signal, (io) => provider === "openai" ? inspectCodex(io, profile, versions.client)
    : provider === "anthropic" ? inspectClaude(io)
      : provider === "zhipu" ? inspectZCode(io) : inspectAcp(io, provider, versions));
}

async function observeCliProcess<T>(child: ChildProcessByStdio<Writable, Readable, null>, provider: CliProtocolProvider,
    signal: AbortSignal, inspect: (io: ProtocolIo) => Promise<T>): Promise<T> {
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  let streamFailed = false;
  const fail = () => { streamFailed = true; };
  child.on("error", fail);
  child.stdin.on("error", fail);
  const restrictedNotifications = provider !== "openai" && provider !== "anthropic";
  let sawGrokMcpUpdate = false;
  let sawZCodeReady = false;
  function isGrokStartupUpdate(message: Frame) {
    if (provider !== "xai" || sawGrokMcpUpdate || !grokMcpUpdate.safeParse(message).success) return false;
    sawGrokMcpUpdate = true;
    return true;
  }
  function isStartupUpdate(message: Frame) {
    if (isGrokStartupUpdate(message)) return true;
    if (provider !== "zhipu" || sawZCodeReady) return false;
    const storage = zCodeStorageUpdate.safeParse(message);
    if (!storage.success) return false;
    sawZCodeReady = storage.data.params.phase === "ready";
    return true;
  }
  const incoming = readCliFrames(child.stdout);
  const io: ProtocolIo = {
    send: (frame) => { child.stdin.write(`${JSON.stringify(frame)}\n`); },
    async read(match, acceptError = false) {
      while (true) {
        const next = await incoming.next();
        if (next.done) throw new Error("The CLI closed before completing its handshake.");
        const message = next.value;
        if (message.type === "control_request" || (typeof message.method === "string" && Object.hasOwn(message, "id"))) {
          throw new Error("The CLI requested an action during its connection check.");
        }
        if (match(message)) {
          if (!acceptError && Object.hasOwn(message, "error")) throw new Error("The CLI reported a protocol error.");
          return message;
        }
        if (Object.hasOwn(message, "id") || message.type === "control_response") throw new Error("The CLI returned an unexpected response.");
        if (restrictedNotifications && !isStartupUpdate(message)) throw new Error("The CLI returned an unexpected message during initialization.");
      }
    },
  };
  try {
    const result = await inspect(io);
    if (provider === "zhipu" && !sawZCodeReady) throw new Error("ZCode did not confirm isolated storage initialization.");
    child.stdin.end();
    for await (const message of incoming) {
      if (isGrokStartupUpdate(message)) continue;
      if (restrictedNotifications || message.type === "control_request" || message.type === "control_response" || Object.hasOwn(message, "id")) {
        throw new Error("Unexpected response while closing the CLI.");
      }
    }
    if (await closed !== 0 || signal.aborted || streamFailed) throw new Error("The CLI did not close its protocol check cleanly.");
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    // Release unread stdout before waiting for all of the child's stdio to close.
    try {
      await incoming.return(undefined);
    } finally {
      await closed;
    }
  }
}

export function isolatedCliEnvironment(env: NodeJS.ProcessEnv, profile: string) {
  return commandEnv([], { SystemRoot: env.SystemRoot, WINDIR: env.WINDIR, ComSpec: env.ComSpec, OS: env.OS,
    PROCESSOR_ARCHITECTURE: env.PROCESSOR_ARCHITECTURE, PATH: profile, HOME: profile, USERPROFILE: profile,
    APPDATA: profile, LOCALAPPDATA: profile, TEMP: profile, TMP: profile, TMPDIR: profile });
}

export async function unpackCliArchive(provider: CliProtocolProvider, file: string, profile: string, version: string, signal: AbortSignal) {
  const archiveName = releaseArchiveName(provider);
  if (!archiveName) throw new Error("No verified CLI archive for this platform.");
  const archive = join(profile, archiveName);
  await stageCliArchive(provider, file, archive, version, signal);
  signal.throwIfAborted();
  const windows = process.platform === "win32";
  const systemRoot = process.env.SystemRoot ?? "";
  if (windows && !isAbsolute(systemRoot)) throw new Error("Windows system tools are unavailable.");
  const tar = windows ? join(systemRoot, "System32", "tar.exe") : "/usr/bin/tar";
  const wheelOnLinux = process.platform === "linux" && archiveName.endsWith(".whl");
  const env = isolatedCliEnvironment(commandEnv(), profile);
  const distribution = join(profile, "distribution");
  await mkdir(distribution, { mode: 0o700 });
  const child = spawn(wheelOnLinux ? "/usr/bin/python3" : tar,
    wheelOnLinux ? ["-I", "-m", "zipfile", "-e", archive, distribution] : ["-xf", archive, "-C", distribution], {
    cwd: profile, env: { ...env, PATH: windows ? profile : "/usr/bin:/bin" },
    signal, killSignal: "SIGKILL", windowsHide: true, shell: false, stdio: "ignore",
  });
  child.on("error", () => {});
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  if (code !== 0 || signal.aborted) throw new Error("CLI archive extraction did not complete.");
  return distribution;
}

export async function stageQwenRelease(file: string, directory: string, version: string, signal: AbortSignal) {
  const root = join(await unpackCliArchive("qwen", file, directory, version, signal), "qwen-code");
  return { executable: process.platform === "win32" ? join(root, "node", "node.exe") : join(root, "node", "bin", "node"),
    entry: join(root, "lib", "cli-entry.js") };
}

export async function stageDeepSeekRelease(file: string, directory: string, version: string, signal: AbortSignal) {
  const distribution = await unpackCliArchive("deepseek", file, directory, version, signal);
  const mac = process.platform === "darwin";
  const target = mac ? `macos-${process.arch}` : process.platform === "linux" ? "linux-x64" : "win-x64.exe";
  const executable = join(distribution, "deepseek_harness_runtime", "runtime", `deepseek-harness-sdk-runtime-${target}`);
  if (process.platform !== "win32") {
    const executables = [executable, `${executable}-rg`];
    if (mac) executables.push(`${executable}-spawn-helper`);
    await Promise.all(executables.map((path) => chmod(path, 0o700)));
  }
  return executable;
}

async function protocolLaunch(provider: CliProtocolProvider, file: string, profile: string, base: string,
    version: string, signal: AbortSignal) {
  const env = isolatedCliEnvironment(commandEnv(), profile);
  switch (provider) {
    case "openai":
      return { executable: await stageCliExecutable(provider, file, profile, version, signal),
        args: ["app-server", "--listen", "stdio://", "--disable", "remote_control", "--disable", "plugins", "-c", "check_for_update_on_startup=false",
          "-c", `openai_base_url=${JSON.stringify(`${base}/v1`)}`],
        env: { ...env, CODEX_HOME: profile, OPENAI_BASE_URL: `${base}/v1` } };
    case "anthropic":
      return { executable: await stageCliExecutable(provider, file, profile, version, signal),
        args: ["--print", "--bare", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan",
        "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence"],
        env: { ...env, CLAUDE_CONFIG_DIR: profile, ANTHROPIC_BASE_URL: base, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" } };
    case "google":
      return { executable: await stageCliExecutable(provider, file, profile, version, signal),
        args: ["acp", "--disable-telemetry", "--include-default-customizations=false", "--gemini-dir", join(profile, "gemini"),
          "--app-data-dir", "antigravity-cli", "--log-file", join(profile, "acp.log"), "--cloud_code_endpoint", base],
        env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" } };
    case "xai":
      await writeFile(join(profile, "config.toml"), "[features]\nremote_fetch = false\nmanaged_config = false\ntelemetry = false\n");
      return { executable: await stageCliExecutable(provider, file, profile, version, signal),
        args: ["--no-auto-update", "agent", "--no-leader", "stdio"], env: {
        ...env, GROK_HOME: profile, GROK_TELEMETRY_ENABLED: "false",
      } };
    case "qwen": {
      const { executable, entry } = await stageQwenRelease(file, profile, version, signal);
      const config = join(profile, "config");
      await mkdir(config);
      await writeFile(join(config, "settings.json"), JSON.stringify({
        general: { enableAutoUpdate: false, batchAutoCollect: false },
        telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false },
      }));
      return { executable, args: [entry, "--acp", "--bare", "--approval-mode", "plan"],
        env: { ...env, QWEN_HOME: config, QWEN_USAGE_STATISTICS_ENABLED: "false" } };
    }
    case "moonshot":
      return { executable: await stageCliExecutable(provider, file, profile, version, signal), args: ["acp"], env: {
        ...env, KIMI_CODE_HOME: profile, KIMI_DISABLE_TELEMETRY: "1",
        KIMI_CODE_BASE_URL: `${base}/v1`, KIMI_CODE_OAUTH_HOST: base,
      } };
    case "mistral": {
      const distribution = await unpackCliArchive(provider, file, profile, version, signal);
      await writeFile(join(profile, "config.toml"), vibeProbeSettings + 'enabled_tools = ["read_file"]\n');
      const executable = join(distribution, process.platform === "win32" ? "vibe-acp.exe" : "vibe-acp");
      return { executable, args: [], env: { ...env,
        VIBE_HOME: profile, PYTHONNOUSERSITE: "1",
      } };
    }
    case "minimax": {
      const { executable, entry } = await stageMiniMaxRuntime(file, join(profile, "distribution"), signal);
      return { executable, args: ["--no-global-search-paths", entry, "acp"], env: { ...env,
        MINIMAX_DATA_DIR: profile, MAVIS_REGION: miniMaxRegion, DO_NOT_TRACK: "1",
      } };
    }
    case "deepseek": {
      const executable = await stageDeepSeekRelease(file, profile, version, signal);
      return { executable, args: ["--profile", "acp"], env: { ...env,
        DSH_HOME: profile, DSH_TELEMETRY_DISABLED: "1",
      } };
    }
    case "zhipu": {
      const { executable, entry, config } = await stageZCodeRuntime(file, join(profile, "distribution"), signal);
      return { executable, args: ["--no-global-search-paths", entry, "app-server", "--stdio"], env: {
        ...env, ELECTRON_RUN_AS_NODE: "1", ZCODE_RUNTIME_ENV: "production",
        ZCODE_MODEL_TELEMETRY_ENABLED: "false", ZCODE_HOME: profile, ZCODE_STORAGE_DIR: join(profile, "storage"),
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(profile, "provider_config.json"),
        ZCODE_HTTP_PROXY: base, NODE_USE_ENV_PROXY: "1",
      } };
    }
  }
}

export function probeIsolatedCliProtocol(provider: CliProtocolProvider, file: string, versions: Versions,
    cancel: AbortSignal): Promise<CliProtocolCheck> {
  return runIsolatedProbe<CliProtocolCheck>(provider, file, versions.executable, cancel,
    (child, profile, signal) => inspectCliProcess(child, provider, profile, versions, signal),
    (networkBlocked) => ({ status: cancel.aborted ? "cancelled" : networkBlocked ? "networkBlocked" : "failed" }));
}

export function probeIsolatedCodexAccount(file: string, versions: Versions, cancel: AbortSignal): Promise<CliAccount> {
  return runIsolatedProbe<CliAccount>("openai", file, versions.executable, cancel,
    (child, profile, signal) => observeCliProcess(child, "openai", signal, (io) => inspectIsolatedCodexAccount(io, profile, versions.client)),
    () => unknownCliAccount, true);
}

export function probeIsolatedAcpAccount(provider: IsolatedAcpAccountProvider, file: string, versions: Versions,
    cancel: AbortSignal): Promise<CliAccount> {
  return runIsolatedProbe<CliAccount>(provider, file, versions.executable, cancel,
    (child, profile, signal) => observeCliProcess(child, provider, signal,
      (io) => inspectIsolatedAcpAccount(io, provider, profile, versions)),
    (networkBlocked) => provider === "minimax" && networkBlocked && !cancel.aborted
      ? { status: "networkBlocked", billingSource: "unknown" } : unknownCliAccount, true);
}

async function runIsolatedProbe<T>(provider: CliProtocolProvider, file: string, version: string, cancel: AbortSignal,
    inspect: (child: ChildProcessByStdio<Writable, Readable, null>, profile: string, signal: AbortSignal) => Promise<T>,
    failure: (networkBlocked: boolean) => T, interceptAccountTraffic = false): Promise<T> {
  if (cancel.aborted) return failure(false);
  const temp = provider === "zhipu" ? await zCodeRuntimeTemp(tmpdir()) : tmpdir();
  const directory = await mkdtemp(join(temp, "tomverse-cli-protocol-"));
  let networkBlocked = false;
  // Give each provider a closed local API destination during the handshake.
  const endpoint = createServer((request, response) => {
    if (provider !== "anthropic" || request.method !== "HEAD" || request.url !== "/api/hello") networkBlocked = true;
    response.writeHead(404).end();
  });
  endpoint.on("connect", (request, socket) => {
    // The pinned global MiniMax CLI checks its public catalog before answering the local sign-in query.
    const miniMaxCatalog = interceptAccountTraffic && provider === "minimax" && request.url === "models.dev:443";
    if (!miniMaxCatalog) networkBlocked = true;
    socket.destroy();
  });
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(60_000)]);
  try {
    const profile = await realpath(directory);
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening", { signal });
    const address = endpoint.address();
    if (!address || typeof address === "string") return failure(false);
    const origin = `http://127.0.0.1:${address.port}`;
    const { executable, args, env } = await protocolLaunch(provider, file, profile, origin, version, signal);
    signal.throwIfAborted();
    const child = spawn(executable, args, {
      cwd: profile, signal, killSignal: "SIGKILL", windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"],
      env: { ...env, HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, NO_PROXY: "127.0.0.1" },
    });
    const result = await inspect(child, profile, signal);
    return networkBlocked ? failure(true) : result;
  } catch {
    return failure(networkBlocked);
  } finally {
    await new Promise<void>((resolve) => {
      endpoint.close(() => resolve());
      endpoint.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
