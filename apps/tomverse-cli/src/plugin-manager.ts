import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pluginHooks } from "./hooks.js";
import { pluginMcpServers } from "./mcp-config.js";
import { ARCHIVE_LIMITS, ArchiveSink, archiveRoot, extractZip } from "./plugin-archive.js";
import { downloadBytes, sha256Hex, shownUrl, type DownloadFetch } from "./plugin-download.js";
import { copyTreeSafely, PluginError, treeDigest } from "./plugin-fs.js";
import { readPluginLayout } from "./plugin-format.js";
import { fetchGitSnapshotSigningIn, type GitAuth } from "./plugin-git.js";
import { diffPlugins, inspectPlugin, type PluginDiff, type PluginInspection } from "./plugin-inspect.js";
import { discardStaging, newStaging, readMarketplace, refreshMarketplace, resolveInMarketplace } from "./plugin-marketplace.js";
import { fetchNpmPackage } from "./plugin-npm.js";
import {
    installedDir, installedPluginPath, pluginApproved, readPluginState, removeInstalledPlugin, updatePluginState, type PluginOrigin, type PluginRecord, type PluginSourceRecord,
} from "./plugin-store.js";
import { forgetPluginTrust } from "./project-trust.js";

/**
 * Installing, updating and removing plugins. Installing is two steps: `stagePlugin` copies the plugin into a private staging folder
 * (safely: no link out, bounded size) and reads what it holds; `commitStaged` moves it into place only after the person confirmed
 * what `stagePlugin` showed, and only if the files (and the place they came from) are still exactly those. Neither step runs anything of
 * the plugin. An update that changes any file leaves the plugin's hooks and servers unapproved again (their approval is bound to the
 * digest of the files).
 *
 * A zip file, an address of a zip file and an npm package are further places to install from. They are off unless the caller passes
 * `sources` (Desktop does, when its server switch is on); the terminal command does not. They go through the same copy, the same
 * preview and the same confirmation as a folder, after an unpacking that refuses links and escaping paths (plugin-archive.ts).
 */

export type PluginRequest =
    | { kind: "folder"; path: string }
    | { kind: "marketplace"; marketplace: string; plugin: string }
    | { kind: "update"; name: string }
    | { kind: "zip"; path: string }
    | { kind: "zip-url"; url: string; sha256?: string }
    | { kind: "npm"; package: string; version?: string; registry?: string; integrity?: string };

/** The places beyond a folder and a public git catalog, with what they need. Passing it turns them on. */
export type SourceOptions = {
    /** For tests: a stand-in for the network. */
    fetchImpl?: DownloadFetch;
    /** How a private github.com repository is read, when it cannot be read without signing in (it asks the person first). */
    signIn?: (url: string) => Promise<GitAuth | null>;
};

export type StageOptions = { signal?: AbortSignal; refresh?: boolean; sources?: SourceOptions };

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
    /** Where the files really came from, when it is not a folder or a git catalog entry. */
    origin?: PluginOrigin;
    /** What the person confirms: the digest of the files together with where they came from (an npm integrity value, a zip's SHA-256, a commit). */
    approval: string;
};

export type StageResult = { staged: StagedPlugin } | { upToDate: PluginInspection };

type Resolved = { sourceDir: string; source: PluginSourceRecord; origin?: PluginOrigin; fallbackName?: string };

export const approvalDigestOf = (filesDigest: string, source: PluginSourceRecord, origin?: PluginOrigin) =>
    createHash("sha256").update(JSON.stringify([filesDigest, source, origin ?? null])).digest("hex");

const NOT_HERE = "This kind of source is not available here.";

const requireSources = (options: StageOptions): SourceOptions => {
    if (!options.sources) throw new PluginError(NOT_HERE);
    return options.sources;
};

/** The unpacked files of an archive go to `<staging>/src`; the plugin's root inside them is the folder that is copied. */
const unpackZip = (bytes: Buffer, stagingRoot: string) => {
    const unpacked = join(stagingRoot, "src");
    extractZip(bytes, new ArchiveSink(unpacked));
    return archiveRoot(unpacked);
};

const readZipFile = (path: string): { bytes: Buffer; real: string } => {
    if (!isAbsolute(path)) throw new PluginError("Give the full path of the zip file.");
    let real: string;
    try {
        real = realpathSync.native(path);
        const stat = statSync(real);
        if (!stat.isFile()) throw new Error("not a file");
        if (stat.size > ARCHIVE_LIMITS.archiveBytes) throw new PluginError("The zip file is too large.");
    } catch (error) {
        if (error instanceof PluginError) throw error;
        throw new PluginError("That is not a readable file.");
    }
    return { bytes: readFileSync(real), real };
};

const zipFromUrl = async (url: string, pinned: string | undefined, stagingRoot: string, options: StageOptions) => {
    const sources = requireSources(options);
    const bytes = await downloadBytes(url, { maxBytes: ARCHIVE_LIMITS.archiveBytes, what: "zip file", accept: "application/zip, application/octet-stream", signal: options.signal, fetchImpl: sources.fetchImpl });
    const sha256 = sha256Hex(bytes);
    if (pinned !== undefined && pinned !== sha256) throw new PluginError("The downloaded zip file does not match the SHA-256 the catalog pins; nothing was installed.");
    return { sourceDir: unpackZip(bytes, stagingRoot), sha256 };
};

const npmToStaging = async (request: { package: string; version?: string; registry?: string; integrity?: string }, stagingRoot: string, options: StageOptions) => {
    const sources = requireSources(options);
    const unpacked = join(stagingRoot, "src");
    const found = await fetchNpmPackage(request, unpacked, { signal: options.signal, fetchImpl: sources.fetchImpl });
    const origin: PluginOrigin = { kind: "npm", package: request.package, version: found.version, integrity: found.integrity, ...(request.registry ? { registry: found.registry } : {}) };
    return { sourceDir: archiveRoot(unpacked), origin };
};

const resolveMarketplaceEntry = async (home: string, marketplace: string, plugin: string, stagingRoot: string, options: StageOptions): Promise<Resolved> => {
    const { record, catalog, dir } = readMarketplace(home, marketplace);
    const entry = catalog.entries.find((candidate) => candidate.name === plugin);
    if (!entry) throw new PluginError(`The marketplace ${marketplace} has no plugin named ${plugin}.`);
    const source = entry.source;
    if (source.kind === "unsupported") throw new PluginError(`The plugin ${plugin} comes from a source this app does not support (${source.type}).`);
    if (source.kind === "relative") {
        return { sourceDir: resolveInMarketplace(dir, source.path), source: { kind: "marketplace", marketplace, plugin, ...(record.commit ? { commit: record.commit } : {}) }, fallbackName: entry.name };
    }
    if (source.kind === "npm") {
        if (!options.sources) throw new PluginError(`The plugin ${plugin} comes from a source this app does not support (npm).`);
        const { sourceDir, origin } = await npmToStaging(source, stagingRoot, options);
        return { sourceDir, source: { kind: "marketplace", marketplace, plugin }, origin, fallbackName: entry.name };
    }
    if (source.kind === "zip") {
        if (!options.sources) throw new PluginError(`The plugin ${plugin} comes from a source this app does not support (zip).`);
        const { sourceDir, sha256 } = await zipFromUrl(source.url, source.sha256, stagingRoot, options);
        return { sourceDir, source: { kind: "marketplace", marketplace, plugin }, origin: { kind: "zip-url", url: shownUrl(source.url), sha256 }, fallbackName: entry.name };
    }
    const checkout = join(stagingRoot, "src");
    const { commit } = await fetchGitSnapshotSigningIn(
        { url: source.url, ...(source.ref ? { ref: source.ref } : {}), ...(source.sha ? { sha: source.sha } : {}) }, checkout,
        { signal: options.signal, ...(options.sources?.signIn ? { signIn: options.sources.signIn } : {}) },
    );
    return { sourceDir: source.subdir ? resolveInMarketplace(checkout, source.subdir) : checkout, source: { kind: "marketplace", marketplace, plugin, commit }, fallbackName: entry.name };
};

const resolveRequest = async (home: string, request: PluginRequest, stagingRoot: string, options: StageOptions): Promise<Resolved> => {
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
    if (request.kind === "zip") {
        requireSources(options);
        const { bytes, real } = readZipFile(request.path);
        return { sourceDir: unpackZip(bytes, stagingRoot), source: { kind: "folder", path: real }, origin: { kind: "zip", sha256: sha256Hex(bytes) } };
    }
    if (request.kind === "zip-url") {
        const { sourceDir, sha256 } = await zipFromUrl(request.url, request.sha256, stagingRoot, options);
        const shown = shownUrl(request.url);
        return { sourceDir, source: { kind: "folder", path: shown }, origin: { kind: "zip-url", url: shown, sha256 } };
    }
    if (request.kind === "npm") {
        const { sourceDir, origin } = await npmToStaging(request, stagingRoot, options);
        return { sourceDir, source: { kind: "folder", path: `npm:${request.package}@${origin.kind === "npm" ? origin.version : ""}` }, origin };
    }
    if (request.kind === "marketplace") return resolveMarketplaceEntry(home, request.marketplace, request.plugin, stagingRoot, options);
    const record = readPluginState(home).plugins[request.name];
    if (!record) throw new PluginError(`No plugin named ${request.name} is installed.`);
    if (record.source.kind === "folder") {
        // Installed from a zip file, an address or an npm package: the same place is read again (npm: the registry's newest version).
        if (record.origin?.kind === "zip") return resolveRequest(home, { kind: "zip", path: record.source.path }, stagingRoot, options);
        if (record.origin?.kind === "zip-url") return resolveRequest(home, { kind: "zip-url", url: record.origin.url }, stagingRoot, options);
        if (record.origin?.kind === "npm") {
            return resolveRequest(home, { kind: "npm", package: record.origin.package, ...(record.origin.registry ? { registry: record.origin.registry } : {}) }, stagingRoot, options);
        }
        return resolveRequest(home, { kind: "folder", path: record.source.path }, stagingRoot, options);
    }
    if (options.refresh !== false) {
        await refreshMarketplace(home, record.source.marketplace, { signal: options.signal, ...(options.sources?.signIn ? { signIn: options.sources.signIn } : {}) });
    }
    return resolveMarketplaceEntry(home, record.source.marketplace, record.source.plugin, stagingRoot, options);
};

/** An npm package's install scripts are only text here: npm is never run. Said in the preview so nobody expects them to have run. */
const npmScriptNote = (tree: string): string | null => {
    try {
        const file = join(tree, "package.json");
        if (statSync(file).size > 256 * 1024) return null;
        const scripts = (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown> }).scripts;
        const names = Object.keys(scripts ?? {}).filter((name) => /^(?:pre|post)?(?:install|prepare|prepack|publish)$|^prepublish(?:Only)?$/.test(name)).slice(0, 6);
        return names.length ? `This npm package declares ${names.join(", ")} scripts. They are never run: npm is not used, only the package's files.` : null;
    } catch {
        return null;
    }
};

/** Copies a plugin into staging and reads it. Throws PluginError; the staging folder is removed then. */
export const stagePlugin = async (home: string, request: PluginRequest, options: StageOptions = {}): Promise<StageResult> => {
    const staging = newStaging(home);
    try {
        const resolved = await resolveRequest(home, request, staging.dir, options);
        const tree = join(staging.dir, "tree");
        copyTreeSafely(resolved.sourceDir, tree);
        if (existsSync(join(staging.dir, "src"))) rmSync(join(staging.dir, "src"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        const inspection = inspectPlugin(tree, resolved.fallbackName ?? (request.kind === "update" ? request.name : undefined));
        if (resolved.origin?.kind === "npm") {
            const note = npmScriptNote(tree);
            if (note) inspection.issues.push(note);
        }
        const state = readPluginState(home);
        const approval = approvalDigestOf(inspection.digest, resolved.source, resolved.origin);
        const common = { id: staging.id, dir: staging.dir, tree, inspection, source: resolved.source, ...(resolved.origin ? { origin: resolved.origin } : {}), approval };
        if (request.kind !== "update") {
            if (state.plugins[inspection.name]) throw new PluginError(`The plugin ${inspection.name} is already installed. Update it, or remove it first.`);
            return { staged: { ...common, mode: "install" } };
        }
        if (inspection.name !== request.name) throw new PluginError(`The plugin now calls itself ${inspection.name}; remove ${request.name} and install the new one.`);
        const previous = inspectPlugin(installedPluginPath(home, request.name));
        if (previous.digest === inspection.digest) {
            discardStaging(staging.dir);
            return { upToDate: previous };
        }
        return { staged: { ...common, mode: "update", previous, diff: diffPlugins(previous, inspection) } };
    } catch (error) {
        discardStaging(staging.dir);
        throw error;
    }
};

export const discardStaged = (staged: Pick<StagedPlugin, "dir">) => discardStaging(staged.dir);

/** The folders of the staging area are the CLI's own; `staged` must be one this process made. */
export const commitStaged = (home: string, staged: StagedPlugin): PluginRecord => {
    if (!existsSync(staged.tree)) throw new PluginError("The staged plugin is gone.");
    if (treeDigest(staged.tree) !== staged.inspection.digest || approvalDigestOf(staged.inspection.digest, staged.source, staged.origin) !== staged.approval) {
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
            ...(staged.origin ? { origin: staged.origin } : {}),
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

/** One line naming where the files came from and the value that identifies them, for the confirmation. */
export const describeOrigin = (staged: Pick<StagedPlugin, "origin" | "source">): string | null => {
    const origin = staged.origin;
    if (origin?.kind === "npm") return `npm package ${origin.package}@${origin.version}, integrity ${origin.integrity}`;
    if (origin?.kind === "zip") return `zip file, SHA-256 ${origin.sha256}`;
    if (origin?.kind === "zip-url") return `zip file from ${origin.url}, SHA-256 ${origin.sha256}`;
    if (staged.source.kind === "marketplace" && staged.source.commit) return `git commit ${staged.source.commit}`;
    return null;
};

/** The confirmation text for a staged plugin, for a terminal. */
export const describeStaged = (staged: StagedPlugin): string[] => {
    const { inspection: plugin, diff } = staged;
    const lines = [
        `${staged.mode === "update" ? "Update" : "Install"} plugin ${plugin.name}${plugin.version ? ` ${plugin.version}` : ""}${plugin.description ? ` - ${plugin.description}` : ""}`,
        `  ${plugin.files} file(s), ${Math.ceil(plugin.bytes / 1024)} KB`,
        `  ${plugin.skills.length} skill(s), ${plugin.commands.length} command(s), ${plugin.agents.length} agent definition(s)`,
    ];
    const origin = describeOrigin(staged);
    if (origin) lines.push(`  From: ${origin}`);
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
