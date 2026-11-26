import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pluginHooks } from "./hooks.js";
import { pluginMcpServers } from "./mcp-config.js";
import { copyTreeSafely, PluginError, treeDigest } from "./plugin-fs.js";
import { readPluginLayout } from "./plugin-format.js";
import { fetchGitSnapshot } from "./plugin-git.js";
import { diffPlugins, inspectPlugin, type PluginDiff, type PluginInspection } from "./plugin-inspect.js";
import { discardStaging, newStaging, readMarketplace, refreshMarketplace, resolveInMarketplace } from "./plugin-marketplace.js";
import {
    installedDir, installedPluginPath, pluginApproved, readPluginState, removeInstalledPlugin, updatePluginState, type PluginRecord, type PluginSourceRecord,
} from "./plugin-store.js";
import { forgetPluginTrust } from "./project-trust.js";

/**
 * Installing, updating and removing plugins. Installing is two steps: `stagePlugin` copies the plugin into a private staging folder
 * (safely: no link out, bounded size) and reads what it holds; `commitStaged` moves it into place only after the person confirmed
 * what `stagePlugin` showed, and only if the files are still exactly those. Neither step runs anything of the plugin. An update that
 * changes any file leaves the plugin's hooks and servers unapproved again (their approval is bound to the digest of the files).
 */

export type PluginRequest =
    | { kind: "folder"; path: string }
    | { kind: "marketplace"; marketplace: string; plugin: string }
    | { kind: "update"; name: string };

export type StagedPlugin = {
    id: string;
    /** The staging folder (removed by discard or commit) and the copy of the plugin inside it. */
    dir: string;
    tree: string;
    mode: "install" | "update";
    inspection: PluginInspection;
    previous?: PluginInspection;
    diff?: PluginDiff;
    source: PluginSourceRecord;
};

export type StageResult = { staged: StagedPlugin } | { upToDate: PluginInspection };

type Resolved = { sourceDir: string; source: PluginSourceRecord; fallbackName?: string };

const resolveMarketplaceEntry = async (home: string, marketplace: string, plugin: string, stagingRoot: string, signal?: AbortSignal): Promise<Resolved> => {
    const { record, catalog, dir } = readMarketplace(home, marketplace);
    const entry = catalog.entries.find((candidate) => candidate.name === plugin);
    if (!entry) throw new PluginError(`The marketplace ${marketplace} has no plugin named ${plugin}.`);
    const source = entry.source;
    if (source.kind === "unsupported") throw new PluginError(`The plugin ${plugin} comes from a source this app does not support (${source.type}).`);
    if (source.kind === "relative") {
        return { sourceDir: resolveInMarketplace(dir, source.path), source: { kind: "marketplace", marketplace, plugin, ...(record.commit ? { commit: record.commit } : {}) }, fallbackName: entry.name };
    }
    const checkout = join(stagingRoot, "src");
    const { commit } = await fetchGitSnapshot({ url: source.url, ...(source.ref ? { ref: source.ref } : {}), ...(source.sha ? { sha: source.sha } : {}) }, checkout, { signal });
    return { sourceDir: source.subdir ? resolveInMarketplace(checkout, source.subdir) : checkout, source: { kind: "marketplace", marketplace, plugin, commit }, fallbackName: entry.name };
};

const resolveRequest = async (home: string, request: PluginRequest, stagingRoot: string, options: { signal?: AbortSignal; refresh?: boolean }): Promise<Resolved> => {
    if (request.kind === "folder") {
        if (!isAbsolute(request.path)) throw new PluginError("Give the full path of the plugin folder.");
        let real: string;
        try {
            real = realpathSync.native(request.path);
            if (!statSync(real).isDirectory()) throw new Error("not a folder");
        } catch {
            throw new PluginError("That is not a readable folder.");
        }
        return { sourceDir: real, source: { kind: "folder", path: real } };
    }
    if (request.kind === "marketplace") return resolveMarketplaceEntry(home, request.marketplace, request.plugin, stagingRoot, options.signal);
    const record = readPluginState(home).plugins[request.name];
    if (!record) throw new PluginError(`No plugin named ${request.name} is installed.`);
    if (record.source.kind === "folder") return resolveRequest(home, { kind: "folder", path: record.source.path }, stagingRoot, options);
    if (options.refresh !== false) await refreshMarketplace(home, record.source.marketplace, { signal: options.signal });
    return resolveMarketplaceEntry(home, record.source.marketplace, record.source.plugin, stagingRoot, options.signal);
};

/** Copies a plugin into staging and reads it. Throws PluginError; the staging folder is removed then. */
export const stagePlugin = async (home: string, request: PluginRequest, options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<StageResult> => {
    const staging = newStaging(home);
    try {
        const resolved = await resolveRequest(home, request, staging.dir, options);
        const tree = join(staging.dir, "tree");
        copyTreeSafely(resolved.sourceDir, tree);
        if (existsSync(join(staging.dir, "src"))) rmSync(join(staging.dir, "src"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        const inspection = inspectPlugin(tree, resolved.fallbackName ?? (request.kind === "update" ? request.name : undefined));
        const state = readPluginState(home);
        if (request.kind !== "update") {
            if (state.plugins[inspection.name]) throw new PluginError(`The plugin ${inspection.name} is already installed. Update it, or remove it first.`);
            return { staged: { id: staging.id, dir: staging.dir, tree, mode: "install", inspection, source: resolved.source } };
        }
        if (inspection.name !== request.name) throw new PluginError(`The plugin now calls itself ${inspection.name}; remove ${request.name} and install the new one.`);
        const previous = inspectPlugin(installedPluginPath(home, request.name));
        if (previous.digest === inspection.digest) {
            discardStaging(staging.dir);
            return { upToDate: previous };
        }
        return { staged: { id: staging.id, dir: staging.dir, tree, mode: "update", inspection, previous, diff: diffPlugins(previous, inspection), source: resolved.source } };
    } catch (error) {
        discardStaging(staging.dir);
        throw error;
    }
};

export const discardStaged = (staged: Pick<StagedPlugin, "dir">) => discardStaging(staged.dir);

/** The folders of the staging area are the CLI's own; `staged` must be one this process made. */
export const commitStaged = (home: string, staged: StagedPlugin): PluginRecord => {
    if (!existsSync(staged.tree)) throw new PluginError("The staged plugin is gone.");
    if (treeDigest(staged.tree) !== staged.inspection.digest) {
        discardStaging(staged.dir);
        throw new PluginError("The plugin's files changed after you looked at them; nothing was installed. Try again.");
    }
    const name = staged.inspection.name;
    const state = readPluginState(home);
    const target = join(installedDir(home), name);
    mkdirSync(installedDir(home), { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    if (staged.mode === "install") {
        if (state.plugins[name] || existsSync(target)) throw new PluginError(`The plugin ${name} is already installed.`);
        renameSync(staged.tree, target);
    } else {
        const existing = state.plugins[name];
        if (!existing) throw new PluginError(`The plugin ${name} is not installed.`);
        const old = `${target}.old-${staged.id}`;
        if (staged.previous) forgetPluginTrust(home, { hookHashes: staged.previous.hooks.map((hook) => hook.hash), mcpNames: staged.previous.mcpServers.map((server) => server.name) });
        renameSync(target, old);
        renameSync(staged.tree, target);
        rmSync(old, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    let written!: PluginRecord;
    updatePluginState(home, (current) => {
        const previous = current.plugins[name];
        written = {
            ...(staged.inspection.version ? { version: staged.inspection.version } : {}),
            installedAt: previous?.installedAt ?? now, ...(previous ? { updatedAt: now } : {}),
            treeDigest: staged.inspection.digest, enabled: previous?.enabled ?? true, disabledIn: previous?.disabledIn ?? [], source: staged.source,
        };
        current.plugins[name] = written;
        // What was approved belonged to the old files.
        current.approvals = current.approvals.filter((entry) => entry.plugin !== name);
    });
    discardStaging(staged.dir);
    return written;
};

/** Deletes the plugin's own folder and every record of it (switches, approvals). Nothing outside `plugins/installed/<name>` is touched. */
export const removePlugin = (home: string, name: string) => {
    let hookHashes: string[] = [];
    let mcpNames: string[] = [];
    try {
        const dir = installedPluginPath(home, name);
        const plugin = { name, dir, digest: treeDigest(dir), layout: readPluginLayout(dir) };
        const problems: string[] = [];
        hookHashes = pluginHooks(plugin, problems).map((hook) => hook.hash);
        mcpNames = pluginMcpServers(plugin, new Set(), problems).map((server) => server.name);
    } catch { /* A folder that cannot be read has nothing to forget by name. */ }
    removeInstalledPlugin(home, name);
    forgetPluginTrust(home, { hookHashes, mcpNames });
};

export type InstalledPlugin = {
    name: string;
    record: PluginRecord;
    /** Null when the plugin's folder cannot be read. */
    inspection: PluginInspection | null;
    /** Hooks and servers that wait for the person's approval. */
    pendingHooks: number;
    pendingServers: number;
    /** The files on disk are not the ones that were installed. */
    modified: boolean;
};

export const listInstalledPlugins = (home: string): InstalledPlugin[] =>
    Object.entries(readPluginState(home).plugins).map(([name, record]) => {
        let inspection: PluginInspection | null = null;
        try {
            inspection = inspectPlugin(installedPluginPath(home, name));
        } catch { /* Listed without contents. */ }
        return {
            name, record, inspection,
            pendingHooks: inspection ? inspection.hooks.filter((hook) => !pluginApproved(home, "hook", hook.hash)).length : 0,
            pendingServers: inspection ? inspection.mcpServers.filter((server) => !pluginApproved(home, "mcp", server.hash)).length : 0,
            modified: inspection !== null && inspection.digest !== record.treeDigest,
        };
    });

/** The confirmation text for a staged plugin, for a terminal. */
export const describeStaged = (staged: StagedPlugin): string[] => {
    const { inspection: plugin, diff } = staged;
    const lines = [
        `${staged.mode === "update" ? "Update" : "Install"} plugin ${plugin.name}${plugin.version ? ` ${plugin.version}` : ""}${plugin.description ? ` - ${plugin.description}` : ""}`,
        `  ${plugin.files} file(s), ${Math.ceil(plugin.bytes / 1024)} KB`,
        `  ${plugin.skills.length} skill(s), ${plugin.commands.length} command(s), ${plugin.agents.length} agent definition(s)`,
    ];
    for (const [label, names] of [["skills", plugin.skills], ["commands", plugin.commands], ["agents", plugin.agents]] as const) {
        if (names.length) lines.push(`    ${label}: ${names.slice(0, 20).join(", ")}${names.length > 20 ? ` (+${names.length - 20} more)` : ""}`);
    }
    if (plugin.hooks.length || plugin.mcpServers.length) lines.push("  This plugin brings things that RUN on this computer, with your permissions, once you approve them (nothing runs before that):");
    for (const hook of plugin.hooks) lines.push(`    hook ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""} (timeout ${hook.timeoutSec}s): ${hook.command}`);
    for (const server of plugin.mcpServers) lines.push(`    MCP server ${server.name} (${server.transport}): ${server.summary}`);
    if (!plugin.hooks.length && !plugin.mcpServers.length) lines.push("  It has no hooks and no MCP servers: nothing in it runs.");
    if (plugin.notUsed.length) lines.push(`  Not used here: ${plugin.notUsed.join(", ")}`);
    for (const issue of plugin.issues.slice(0, 10)) lines.push(`  note: ${issue}`);
    if (diff) {
        lines.push(`  Changes from ${staged.previous?.version ?? "the installed version"}:`);
        if (diff.version.from !== diff.version.to) lines.push(`    version: ${diff.version.from ?? "-"} -> ${diff.version.to ?? "-"}`);
        for (const [label, d] of [["skills", diff.skills], ["commands", diff.commands], ["agents", diff.agents]] as const) {
            if (d.added.length) lines.push(`    ${label} added: ${d.added.join(", ")}`);
            if (d.removed.length) lines.push(`    ${label} removed: ${d.removed.join(", ")}`);
        }
        for (const hook of diff.hooks.added) lines.push(`    hook added: ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.command}`);
        for (const hook of diff.hooks.removed) lines.push(`    hook removed: ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.command}`);
        for (const server of diff.mcpServers.added) lines.push(`    MCP server added: ${server.name}: ${server.summary}`);
        for (const server of diff.mcpServers.removed) lines.push(`    MCP server removed: ${server.name}`);
        for (const server of diff.mcpServers.changed) lines.push(`    MCP server changed: ${server.name}: ${server.from} -> ${server.to}`);
        lines.push(diff.needsApproval ? "  The plugin's files changed, so its hooks and MCP servers must be approved again before they run." : "  No hook or MCP server is affected.");
    }
    return lines;
};
