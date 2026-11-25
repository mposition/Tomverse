import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { same } from "../../../tomverse-cli/src/workspace.js";
import type { CliFixtureInput } from "./cli-fixture-input";
import { nativeTaskListName } from "./native-mcp-server";
import { stageCliExecutable } from "./provider-cli-path";

export const antigravityModel = "gemini-3.1-pro-low";
export const antigravityReadFunction = "mcp_desktop_desktop_read_file";
export const antigravityPatchFunction = "mcp_desktop_desktop_apply_patch";
export const antigravityTaskListFunction = "mcp_desktop_" + nativeTaskListName;
const profileName = "tomverse-desktop-scope";
const profileDefinition = [
  "---",
  "name: " + profileName,
  "description: Scope project work to Desktop tools.",
  "mainAgent: true",
  "subagent: false",
  'commandExecutionPolicy: "off"',
  "inheritMcp: true",
  "inheritCustomizations: false",
  "tools: [send_message]",
  "---",
  "Use only Desktop MCP tools for workspace operations.",
  "",
].join("\n");

const changed = "The Antigravity Desktop fixture profile changed.";
const managedConfig = z.object({ plugins: z.object({
  swarm: z.object({ enabled: z.boolean() }).strict().optional(),
}).strict().optional() }).strict();
const runtimeFiles = new Set(["annotations", "brain", "builtin", "cache", "conversations", "conversation_summaries.db",
  "conversation_summaries.db-shm", "conversation_summaries.db-wal", "crashes", "implicit", "installation_id",
  "jetbox_summaries_proto.pb", "jetski_state.pbtxt", "mcp"]);

async function checkDirectory(path: string, allowed: ReadonlySet<string>) {
  if (!same(await realpath(path), path)) throw new Error(changed);
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.some((entry) => !allowed.has(entry.name) || !(entry.isFile() || entry.isDirectory()))) throw new Error(changed);
  return new Set(entries.map(({ name }) => name));
}

async function readOwnedFile(path: string, maximumBytes: number) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > maximumBytes || !same(await realpath(path), path)) throw new Error(changed);
  return readFile(path, "utf8");
}

export async function antigravityLaunch(fixture: CliFixtureInput, directory: string, profile: string,
  resume: boolean, signal: AbortSignal) {
  if (fixture.model !== antigravityModel) throw new Error("The Antigravity fixture needs a verified Gemini selection.");
  const gemini = join(profile, ".gemini");
  const config = join(gemini, "config");
  const agents = join(config, "agents");
  const definition = join(agents, profileName);
  const file = join(definition, "agent.md");
  if (resume) {
    await checkDirectory(gemini, new Set(["config", "antigravity-cli"]));
    const entries = await checkDirectory(config, new Set([".migrated", "agents", "config.json", "mcp_config.json", "projects"]));
    await checkDirectory(agents, new Set([profileName]));
    await checkDirectory(definition, new Set(["agent.md"]));
    await checkDirectory(join(gemini, "antigravity-cli"), runtimeFiles);
    if (entries.has("projects")) await checkDirectory(join(config, "projects"), new Set());
    if (entries.has("config.json")) managedConfig.parse(JSON.parse(await readOwnedFile(join(config, "config.json"), 4096)));
    if (entries.has("mcp_config.json") && (await readOwnedFile(join(config, "mcp_config.json"), 4096)).trim() !== "") {
      throw new Error(changed);
    }
    if (await readOwnedFile(file, Buffer.byteLength(profileDefinition)) !== profileDefinition) throw new Error(changed);
  } else {
    await mkdir(definition, { recursive: true, mode: 0o700 });
    await writeFile(file, profileDefinition, { flag: "wx", mode: 0o600 });
  }
  const executable = await stageCliExecutable("google", fixture.executable, directory, fixture.version, signal);
  return { executable, args: ["acp", "--agent", profileName, "--process-per-session", "--disable-telemetry",
    "--include-default-customizations=false", "--gemini-dir", gemini, "--app-data-dir", "antigravity-cli",
    "--log-file", join(directory, "antigravity-acp.log"), "--cloud_code_endpoint", fixture.origin],
  env: { HOME: profile, USERPROFILE: profile, AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    GEMINI_API_KEY: "tomverse-loopback-only", GOOGLE_GEMINI_BASE_URL: fixture.origin } };
}

export const antigravityToolFrame = z.object({
  toolCallId: z.uuid(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  name: z.string().max(160),
  rawInput: z.unknown().optional(),
});
export function antigravityPayload(rawInput: unknown) {
  const input = z.record(z.string(), z.unknown()).safeParse(rawInput);
  if (!input.success) return;
  const { toolSummary, ...args } = input.data;
  if (toolSummary !== undefined && (typeof toolSummary !== "string" || toolSummary.length > 1600)) return;
  return args;
}
export const antigravityPermission = z.object({
  toolCall: antigravityToolFrame.extend({ status: z.literal("pending") }),
  options: z.array(z.object({ optionId: z.string().min(1).max(160), kind: z.string() })).max(8),
});
export const antigravitySession = z.object({
  sessionId: z.uuid(),
  models: z.object({ currentModelId: z.literal(antigravityModel) }),
  configOptions: z.array(z.object({ id: z.string(), currentValue: z.unknown() })).max(12),
});
export function antigravityOptions(options: z.infer<typeof antigravitySession>["configOptions"]) {
  const config = new Map(options.map(({ id, currentValue }) => [id, currentValue]));
  return config.size === options.length && config.get("model") === "gemini-3.1-pro" &&
    config.get("thought_level") === "low" && config.get("mode") === "default";
}
