import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tomverseHome } from "./config.js";
import { insideFolder, PluginError, treeDigest } from "./plugin-fs.js";
import { readPluginLayout, validPluginName, type PluginLayout } from "./plugin-format.js";
import { writeFileAtomic } from "./session.js";

/**
 * Which plugins are installed in the CLI's own folder (`<TOMVERSE_HOME>/plugins/`), where each came from, whether it is switched on,
 * and which of its hooks and MCP servers the person approved. Written only by the person's own action (a prompt in a terminal, a
 * button in Desktop). A plugin is third-party code: nothing in this record starts anything by itself.
 */

const sourceSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("folder"), path: z.string().max(1000) }),
    z.object({ kind: z.literal("marketplace"), marketplace: z.string().max(100), plugin: z.string().max(100), commit: z.string().max(80).optional() }),
]);
export type PluginSourceRecord = z.infer<typeof sourceSchema>;

const pluginSchema = z.object({
    version: z.string().max(100).optional(),
    installedAt: z.string(),
    updatedAt: z.string().optional(),
    treeDigest: z.string(),
    enabled: z.boolean(),
    disabledIn: z.array(z.string().max(1000)).max(500),
    source: sourceSchema,
});
export type PluginRecord = z.infer<typeof pluginSchema>;

const marketplaceSourceSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("directory"), path: z.string().max(1000) }),
    z.object({ kind: z.literal("git"), url: z.string().max(1000), ref: z.string().max(200).optional() }),
]);
export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;

const marketplaceSchema = z.object({
    source: marketplaceSourceSchema,
    commit: z.string().max(80).optional(),
    addedAt: z.string(),
    updatedAt: z.string(),
});
export type MarketplaceRecord = z.infer<typeof marketplaceSchema>;

const stateSchema = z.object({
    version: z.literal(1),
    plugins: z.record(z.string(), pluginSchema),
    marketplaces: z.record(z.string(), marketplaceSchema),
    approvals: z.array(z.object({ kind: z.enum(["hook", "mcp"]), hash: z.string().regex(/^[0-9a-f]{64}$/), plugin: z.string() })).max(2000),
});
export type PluginState = z.infer<typeof stateSchema>;

export const pluginsDir = (home: string = tomverseHome()) => join(home, "plugins");
export const installedDir = (home: string = tomverseHome()) => join(pluginsDir(home), "installed");
export const marketplacesDir = (home: string = tomverseHome()) => join(pluginsDir(home), "marketplaces");
export const stagingDir = (home: string = tomverseHome()) => join(pluginsDir(home), "staging");
const stateFile = (home: string) => join(pluginsDir(home), "state.json");

const emptyState = (): PluginState => ({ version: 1, plugins: {}, marketplaces: {}, approvals: [] });

/** An unreadable or invalid file approves and installs nothing; the next write replaces it. */
export const readPluginState = (home: string = tomverseHome()): PluginState => {
    const path = stateFile(home);
    if (!existsSync(path)) return emptyState();
    try {
        const parsed = stateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        if (!parsed.success) return emptyState();
        // A name that could point outside the folder is dropped, whatever the file says.
        for (const name of Object.keys(parsed.data.plugins)) if (!validPluginName(name)) delete parsed.data.plugins[name];
        for (const name of Object.keys(parsed.data.marketplaces)) if (!validPluginName(name)) delete parsed.data.marketplaces[name];
        return parsed.data;
    } catch {
        return emptyState();
    }
};

export const updatePluginState = (home: string, change: (state: PluginState) => void) => {
    const state = readPluginState(home);
    change(state);
    mkdirSync(pluginsDir(home), { recursive: true, mode: 0o700 });
    writeFileAtomic(stateFile(home), `${JSON.stringify(state, null, 2)}\n`);
};

/** Case-insensitive paths on Windows and macOS compare equal, as project-trust does. */
export const rootKey = (root: string) => (process.platform === "win32" || process.platform === "darwin" ? root.toLowerCase() : root);

/** The folder an installed plugin lives in, checked to be a real folder directly inside the install folder. Throws PluginError. */
export const installedPluginPath = (home: string, name: string): string => {
    if (!validPluginName(name)) throw new PluginError("That is not a plugin name.");
    const base = installedDir(home);
    const path = join(base, name);
    let stat;
    try {
        stat = lstatSync(path);
    } catch {
        throw new PluginError(`The folder of the plugin ${name} is missing.`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PluginError(`The plugin ${name} is not a plain folder.`);
    const real = realpathSync.native(path);
    if (!insideFolder(realpathSync.native(base), real) || real === realpathSync.native(base)) throw new PluginError("That folder is not inside the plugin folder.");
    return path;
};

export type ActivePlugin = {
    name: string;
    dir: string;
    version?: string;
    /** The digest of the files as they are on disk now; hooks and servers are approved for this exact digest. */
    digest: string;
    layout: PluginLayout;
    record: PluginRecord;
};

/**
 * The installed plugins that are on, for a folder: a plugin switched off for everyone, or off for this folder, is not here, so
 * nothing of it is listed or run. A plugin whose folder cannot be read is skipped.
 */
export const activePlugins = (home: string, root: string | null): ActivePlugin[] => {
    const state = readPluginState(home);
    const out: ActivePlugin[] = [];
    for (const [name, record] of Object.entries(state.plugins)) {
        if (!record.enabled || (root !== null && record.disabledIn.includes(rootKey(root)))) continue;
        let dir: string;
        try {
            dir = installedPluginPath(home, name);
        } catch {
            continue;
        }
        const layout = readPluginLayout(dir);
        out.push({ name, dir, ...(record.version ? { version: record.version } : {}), digest: treeDigest(dir), layout, record });
    }
    return out;
};

export const setPluginEnabled = (home: string, name: string, enabled: boolean) => {
    if (!readPluginState(home).plugins[name]) throw new PluginError(`No plugin named ${name} is installed.`);
    updatePluginState(home, (state) => {
        state.plugins[name]!.enabled = enabled;
    });
};

/** On or off for one folder only; the plugin's own switch still has to be on. */
export const setPluginEnabledIn = (home: string, name: string, root: string, enabled: boolean) => {
    if (!readPluginState(home).plugins[name]) throw new PluginError(`No plugin named ${name} is installed.`);
    updatePluginState(home, (state) => {
        const record = state.plugins[name]!;
        const rest = record.disabledIn.filter((entry) => entry !== rootKey(root));
        record.disabledIn = enabled ? rest : [...rest, rootKey(root)];
    });
};

export const pluginApproved = (home: string, kind: "hook" | "mcp", hash: string) =>
    readPluginState(home).approvals.some((entry) => entry.kind === kind && entry.hash === hash);

export const approvePluginDefinition = (home: string, kind: "hook" | "mcp", hash: string, plugin: string) => {
    if (!readPluginState(home).plugins[plugin]) throw new PluginError(`No plugin named ${plugin} is installed.`);
    updatePluginState(home, (state) => {
        if (!state.approvals.some((entry) => entry.kind === kind && entry.hash === hash)) state.approvals.push({ kind, hash, plugin });
    });
};

/** Removes the plugin's folder and every record of it: its switches and its approvals. Nothing outside the folder is touched. */
export const removeInstalledPlugin = (home: string, name: string) => {
    const state = readPluginState(home);
    if (!state.plugins[name]) throw new PluginError(`No plugin named ${name} is installed.`);
    let path: string | null = null;
    try {
        path = installedPluginPath(home, name);
    } catch {
        path = null;
    }
    if (path) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    updatePluginState(home, (current) => {
        delete current.plugins[name];
        current.approvals = current.approvals.filter((entry) => entry.plugin !== name);
    });
};
