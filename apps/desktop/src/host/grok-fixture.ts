import { existsSync } from "node:fs";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../../tomverse-cli/src/session.js";
import { same } from "../../../tomverse-cli/src/workspace.js";
import type { CliFixtureInput } from "./cli-fixture-input";
import { maxNativePlanItems } from "./native-task-rows";
import { stageCliExecutable } from "./provider-cli-path";

export const grokReadFunction = "desktop__desktop_read_file";
export const grokPatchFunction = "desktop__desktop_apply_patch";
const agentProfile = [
  "---", "name: desktop-scoped", "description: Use Desktop for project file access.",
  "tools: [todo_write, search_tool, use_tool]",
  "disallowedTools: [read_file, write, search_replace, list_dir, grep, run_terminal_cmd, Agent]",
  "---", "Use only Desktop tools when working with project files.", "",
].join("\n");

export async function grokLaunch(fixture: CliFixtureInput, directory: string, profile: string, resume: boolean, signal: AbortSignal) {
  const path = join(profile, "config.toml");
  const definition = join(profile, "desktop-scoped.md");
  if (["auth.json", "managed_config.toml", "requirements.toml", "hooks", "plugins", "skills", "agents"]
    .some((name) => existsSync(join(profile, name)))) throw new Error("The Grok Build fixture profile contains an external configuration.");
  const model = JSON.stringify(fixture.model);
  const config = [
    "[features]", "remote_fetch = false", "managed_config = false", "telemetry = false", "feedback = false",
    "title_refresh = false", "turn_summary = false", "session_recap = false",
    "[session]", "load_envrc = false", "[cli]", "auto_update = false", "[ui]", 'permission_mode = "ask"',
    "[models]", "default = " + model, "session_summary = " + model, "allowed_models = [" + model + "]",
    "[model." + model + "]", "model = " + model, 'name = "Desktop isolated fixture"',
    "base_url = " + JSON.stringify(fixture.origin + "/v1"), 'api_backend = "chat_completions"',
    'env_key = "TOMVERSE_GROK_FIXTURE_KEY"', "",
  ].join("\n");
  if (resume) {
    const [file, definitionFile] = await Promise.all([lstat(path), lstat(definition)]);
    if (!file.isFile() || !same(await realpath(path), path) || !definitionFile.isFile() ||
        definitionFile.size !== Buffer.byteLength(agentProfile) || !same(await realpath(definition), definition) ||
        await readFile(definition, "utf8") !== agentProfile) throw new Error("The saved Grok Build Desktop configuration changed.");
    // Restore the fixture's settings before opening the saved session. Grok rewrites its configuration on exit.
    writeFileAtomic(path, config);
  } else {
    await writeFile(path, config, { flag: "wx", mode: 0o600 });
    await writeFile(definition, agentProfile, { flag: "wx", mode: 0o600 });
  }
  const executable = await stageCliExecutable("xai", fixture.executable, directory, fixture.version, signal);
  return { executable, args: ["--no-auto-update", "agent", "--no-leader", "--agent-profile", definition, "stdio"],
    env: { GROK_HOME: profile, GROK_SUBAGENTS: "0", GROK_WRITE_FILE: "0", GROK_WORKFLOWS: "0",
      TOMVERSE_GROK_FIXTURE_KEY: "tomverse-loopback-only" } };
}

const toolId = z.string().regex(/^[\w.:-]{1,160}$/u);
const todoId = toolId.max(155);
const todoContent = z.string().trim().min(1).max(1600);
const todoStatus = z.enum(["pending", "in_progress", "completed", "cancelled"]);
export const grokToolFrame = z.object({
  toolCallId: toolId,
  status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  _meta: z.object({ "x.ai/tool": z.object({ version: z.literal(1), namespace: z.literal("grok_build"),
    name: z.enum(["use_tool", "todo_write"]) }) }).optional(),
});
export const grokUseTool = z.object({
  variant: z.literal("UseTool").optional(),
  tool_name: z.enum([grokReadFunction, grokPatchFunction]),
  tool_input: z.unknown(),
});
export const grokPermission = z.object({
  toolCall: z.object({ toolCallId: toolId, rawInput: grokUseTool,
    _meta: z.object({ "x.ai/requestingSessionId": z.uuid() }) }),
  options: z.array(z.object({ optionId: toolId, kind: z.string() })).max(8),
});
export const grokTodoInput = z.object({
  merge: z.boolean().nullish(),
  todos: z.array(z.object({ id: todoId, content: todoContent.nullish(), status: todoStatus.nullish() })).max(maxNativePlanItems),
}).refine(({ todos }) => new Set(todos.map(({ id }) => id)).size === todos.length);
const grokTodoState = z.object({ content: todoContent, status: todoStatus });
export const grokTodoResult = z.object({
  type: z.literal("Todo"),
  TodosUpdated: z.object({
    todos: z.array(grokTodoState).max(maxNativePlanItems),
    state: z.object({ todos: z.record(todoId, grokTodoState) }),
  }),
});
export const grokSession = z.object({
  sessionId: z.uuid().optional(),
  models: z.object({ currentModelId: toolId }),
  _meta: z.object({ "x.ai/sessionDetail": z.object({ sessionId: z.uuid(), cwd: z.string(), currentModelId: toolId }) }),
});
const grokUsage = z.object({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() });
export const grokResult = z.object({ _meta: z.object({ sessionId: z.uuid(), modelId: toolId,
  usage: grokUsage.optional().catch(undefined),
}) });
export const grokRateLimit = z.object({
  sessionId: z.uuid(), promptId: z.uuid(), stopReason: z.literal("rate_limit"), agentResult: z.null(),
});
export const grokFreeUsageError = z.object({
  code: z.literal(-32003), message: z.literal("Rate limited"),
  data: z.string().startsWith("API error (status 429 Too Many Requests): subscription:free-usage-exhausted: "),
});
const sessionNotifications = new Set([
  "_x.ai/session/setup", "_x.ai/mcp/init_progress", "_x.ai/mcp_initialized", "_x.ai/mcp/server_status",
  "_x.ai/queue/changed", "_x.ai/session_notification", "_x.ai/session/update", "_x.ai/session/prompt_complete",
]);
export function isGrokAdvisoryFrame(method: unknown, params: unknown, threadId?: string) {
  if (method === "_x.ai/sessions/changed" || method === "_x.ai/mcp/servers_updated") return true;
  if (typeof method !== "string" || !sessionNotifications.has(method)) return false;
  const sessionId = threadId ? z.literal(threadId) : z.uuid();
  z.object({ sessionId: method === "_x.ai/session/setup" ? sessionId.nullable() : sessionId }).parse(params);
  return true;
}
export function grokWorkspaceInstruction(agent: boolean) {
  return `Discover ${grokReadFunction} using search_tool and call it using use_tool to inspect project files. Use todo_write for task updates. ` +
    (agent ? `Request file edits only through ${grokPatchFunction} using use_tool after confirming a workspace read. ` : "");
}
