import { pluginExtensions } from "./extensions.js";
import { pluginHooks } from "./hooks.js";
import { describeMcpServer, pluginMcpServers } from "./mcp-config.js";
import { PluginError, treeDigest, treeStats } from "./plugin-fs.js";
import { pluginNameOf, readPluginLayout } from "./plugin-format.js";

/**
 * What a plugin folder holds, for the person to read before it is installed or updated: how many skills, commands and agents, and
 * every command a hook or an MCP server would run, in full. This reads files only. The hashes are the ones the installed hooks and
 * servers will have, so what is shown here is what is later approved.
 */

export type HookSummary = { event: string; matcher: string; command: string; timeoutSec: number; source: string; hash: string };
export type McpSummary = { name: string; transport: "stdio" | "http" | "unsupported"; summary: string; source: string; hash: string };

export type PluginInspection = {
    name: string;
    displayName?: string;
    version?: string;
    description?: string;
    author?: string;
    /** The digest of every file; a hook or server is approved for this exact digest. */
    digest: string;
    files: number;
    bytes: number;
    skills: string[];
    commands: string[];
    agents: string[];
    hooks: HookSummary[];
    mcpServers: McpSummary[];
    /** Parts of the plugin this app does not use and never starts. */
    notUsed: string[];
    issues: string[];
};

/** Shown in place of the plugin's folder, so a hook's command reads as the plugin wrote it. */
const PLACEHOLDER_ROOT = "${CLAUDE_PLUGIN_ROOT}";

/** Reads a plugin folder (already copied into the CLI's own folder). Throws PluginError when the plugin has no usable name. */
export const inspectPlugin = (dir: string, fallbackName?: string): PluginInspection => {
    const layout = readPluginLayout(dir);
    const named = pluginNameOf(layout, fallbackName);
    if ("error" in named) throw new PluginError(named.error);
    const { name } = named;
    const digest = treeDigest(dir);
    const stats = treeStats(dir);
    const issues = [...layout.issues];
    const found = pluginExtensions({ name, dir, layout });
    issues.push(...found.issues);
    const shown = { name, dir: PLACEHOLDER_ROOT, digest, layout };
    const hooks = pluginHooks(shown, issues).map((def): HookSummary => ({
        event: def.event, matcher: def.matcher, command: def.command, timeoutSec: def.timeoutSec, source: def.source, hash: def.hash,
    }));
    const mcpServers = pluginMcpServers(shown, new Set(), issues).map((def): McpSummary => ({
        name: def.name, transport: def.transport, summary: describeMcpServer(def), source: def.source, hash: def.hash,
    }));
    const manifest = layout.manifest;
    return {
        name, digest, files: stats.files, bytes: stats.bytes,
        ...(manifest?.displayName ? { displayName: manifest.displayName } : {}),
        ...(manifest?.version ? { version: manifest.version } : {}),
        ...(manifest?.description ? { description: manifest.description } : {}),
        ...(manifest?.author ? { author: manifest.author } : {}),
        skills: found.skills.map((skill) => skill.name), commands: found.commands.map((command) => command.name), agents: found.agents.map((agent) => agent.name),
        hooks, mcpServers, notUsed: layout.notUsed, issues,
    };
};

type Delta = { added: string[]; removed: string[] };
const delta = (before: string[], after: string[]): Delta => ({
    added: after.filter((item) => !before.includes(item)),
    removed: before.filter((item) => !after.includes(item)),
});

/** What an update changes: names that come and go, and the hooks and servers (the things that run) that come, go or change. */
export type PluginDiff = {
    version: { from?: string; to?: string };
    /** Any file differs. Hooks and servers of the plugin then ask for approval again. */
    filesChanged: boolean;
    skills: Delta;
    commands: Delta;
    agents: Delta;
    hooks: { added: HookSummary[]; removed: HookSummary[] };
    mcpServers: { added: McpSummary[]; removed: McpSummary[]; changed: Array<{ name: string; from: string; to: string }> };
    needsApproval: boolean;
};

const hookKey = (hook: HookSummary) => `${hook.event}\u0000${hook.matcher}\u0000${hook.command}\u0000${hook.timeoutSec}`;

export const diffPlugins = (before: PluginInspection, after: PluginInspection): PluginDiff => {
    const beforeHooks = new Set(before.hooks.map(hookKey));
    const afterHooks = new Set(after.hooks.map(hookKey));
    const oldServers = new Map(before.mcpServers.map((server) => [server.name, server]));
    const newServers = new Map(after.mcpServers.map((server) => [server.name, server]));
    return {
        version: { ...(before.version ? { from: before.version } : {}), ...(after.version ? { to: after.version } : {}) },
        filesChanged: before.digest !== after.digest,
        skills: delta(before.skills, after.skills), commands: delta(before.commands, after.commands), agents: delta(before.agents, after.agents),
        hooks: { added: after.hooks.filter((hook) => !beforeHooks.has(hookKey(hook))), removed: before.hooks.filter((hook) => !afterHooks.has(hookKey(hook))) },
        mcpServers: {
            added: after.mcpServers.filter((server) => !oldServers.has(server.name)),
            removed: before.mcpServers.filter((server) => !newServers.has(server.name)),
            changed: after.mcpServers.flatMap((server) => {
                const old = oldServers.get(server.name);
                return old && old.summary !== server.summary ? [{ name: server.name, from: old.summary, to: server.summary }] : [];
            }),
        },
        needsApproval: before.digest !== after.digest && (after.hooks.length > 0 || after.mcpServers.length > 0),
    };
};
