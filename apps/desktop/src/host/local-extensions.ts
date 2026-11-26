import { homedir } from "node:os";
import { basename } from "node:path";
import {
  McpManager, describeMcpServer, hookGate, loadHooks, loadMcpServers, mcpGate, openProjectTrust, tomverseHome,
} from "../../../tomverse-cli/src/runtime.js";
import { claudeHome } from "../../../tomverse-cli/src/mcp-config.js";
import { safeLine } from "../../../tomverse-cli/src/display.js";
import type { LocalExtensionsCommand, LocalExtensionsView } from "../local-extensions-contract";

/**
 * What the Connectors screen and the Code settings show and change about MCP servers and hooks on this computer, and where
 * the task runtime reads them from. The folders come from this process's environment (TOMVERSE_HOME, CLAUDE_CONFIG_DIR) so
 * a test can point them at a temporary place; the task runtime is handed the same two folders.
 */

export const extensionFolders = (env: NodeJS.ProcessEnv = process.env) => ({ home: tomverseHome(env), claudeDir: claudeHome(env) });

/** Environment for the task runtime process: where to read the person's own MCP and hook files. */
export const extensionWorkerEnv = (env: NodeJS.ProcessEnv = process.env) => {
  const { home, claudeDir } = extensionFolders(env);
  // The runtime process is not given HOME or USERPROFILE, so the folder skills and commands are read from comes with it.
  return { TOMVERSE_DESKTOP_EXTENSIONS_HOME: home, TOMVERSE_DESKTOP_CLAUDE_DIR: claudeDir, TOMVERSE_DESKTOP_USER_HOME: homedir() };
};

const clean = (text: string, n: number) => safeLine(text).slice(0, n);

export async function localExtensionsReply(root: string | null, command: LocalExtensionsCommand, folders = extensionFolders()): Promise<LocalExtensionsView> {
  if (!root) return { project: false, mcp: [], hooks: [], problems: [] };
  const { home, claudeDir } = folders;
  const trust = openProjectTrust(root, home);
  let loaded = loadMcpServers(root, home);
  // Only a definition that is still exactly what the person was shown can be approved.
  if (command.type === "mcp-approve") {
    const server = loaded.servers.find((s) => s.id === command.id);
    if (server?.scope === "project" && server.hash === command.hash && server.transport !== "unsupported") trust.approveMcp(server);
  } else if (command.type === "mcp-enable") {
    const server = loaded.servers.find((s) => s.id === command.id);
    if (server) trust.setMcpEnabled(server, command.enabled);
  }
  let hooks = loadHooks(root, { tomverse: home, claude: claudeDir });
  if (command.type === "hook-approve" || command.type === "hook-enable") {
    const hook = hooks.hooks.find((h) => h.hash === command.hash);
    if (hook && command.type === "hook-approve" && hook.scope === "project") trust.approveHook(hook);
    else if (hook && command.type === "hook-enable") trust.setHookEnabled(hook, command.enabled);
  }
  let check: LocalExtensionsView["check"];
  if (command.type === "mcp-check") {
    const server = loaded.servers.find((s) => s.id === command.id);
    // Only what may run is started: an unapproved or switched-off project server is not launched to be looked at.
    if (server && server.transport !== "unsupported" && mcpGate(trust)(server) === "yes") {
      const manager = new McpManager({ root, servers: [server], canRun: () => "yes", startupTimeoutMs: 15_000 });
      try {
        await manager.start();
        const status = manager.status()[0]!;
        check = { id: server.id, state: status.state === "connected" ? "connected" : status.state === "needs_auth" ? "needs_auth" : "failed",
          toolCount: status.toolCount, ...(status.detail ? { detail: clean(status.detail, 300) } : {}) };
      } finally {
        await manager.close();
      }
    }
  }
  loaded = loadMcpServers(root, home);
  hooks = loadHooks(root, { tomverse: home, claude: claudeDir });
  const gate = mcpGate(trust);
  const hookRuns = hookGate(trust);
  return {
    project: true,
    mcp: loaded.servers.map((s) => ({
      id: s.id, name: clean(s.name, 80), scope: s.scope, transport: s.transport, summary: clean(describeMcpServer(s), 300), hash: s.hash, ...(s.plugin ? { plugin: clean(s.plugin, 80) } : {}),
      state: s.transport === "unsupported" ? "unsupported" as const : (() => { const g = gate(s); return g === "yes" ? "ready" as const : g; })(),
    })),
    hooks: hooks.hooks.map((h) => ({
      hash: h.hash, event: h.event, matcher: clean(h.matcher, 80), command: clean(h.command, 300), scope: h.scope, source: basename(h.source), ...(h.plugin ? { plugin: clean(h.plugin, 80) } : {}),
      state: !trust.hookApproved(h) ? "pending_approval" as const : hookRuns(h) ? "active" as const : "disabled" as const,
    })),
    problems: [...loaded.problems, ...hooks.problems].map((p) => clean(p, 300)).slice(0, 10),
    ...(check ? { check } : {}),
  };
}
