import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { insideFolder } from "./plugin-fs.js";

/**
 * Reads the folder format of a Claude Code plugin (and, where it matches, a Codex plugin): the manifest at
 * `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` or `plugin.json` (optional), and the skills, commands, agents,
 * hooks and MCP servers it brings, from their default places and from the places the manifest names. This only reads files
 * of a folder already copied into the CLI's own plugin folder; it runs nothing and fetches nothing. What it cannot use
 * (language servers, monitors, programs in bin/ ...) is listed in `notUsed` and never started.
 */

export type PluginManifest = { name?: string; displayName?: string; version?: string; description?: string; author?: string };

export type PluginLayout = {
    manifest: PluginManifest | null;
    manifestFile: string | null;
    /** Absolute folders that hold a SKILL.md. */
    skillDirs: string[];
    commandFiles: Array<{ file: string; name: string }>;
    /** `prefix` is the sub folders of agents/ the file sits in: they are part of the agent's name. */
    agentFiles: Array<{ file: string; prefix: string[] }>;
    /** Hook tables in the settings shape (`{ hooks: { Event: [...] } }`), with where they were read, for display. */
    hookTables: Array<{ source: string; table: Record<string, unknown> }>;
    /** MCP tables as `{ mcpServers: { name: {...} } }`. */
    mcpTables: Array<{ source: string; table: Record<string, unknown> }>;
    notUsed: string[];
    issues: string[];
};

const MAX_JSON_BYTES = 256 * 1024;
const MAX_MD_FILES = 200;
const MAX_MD_DEPTH = 3;

const posix = (path: string) => path.split(sep).join("/");

const pathText = z.string().min(1).max(400);
const pathList = z.union([pathText, z.array(pathText).max(50)]);
const looseObject = z.record(z.string(), z.unknown());
const commandEntry = z.object({ source: pathText.optional(), content: z.string().max(40_000).optional(), description: z.string().max(1000).optional() }).passthrough();

const manifestSchema = z.object({
    name: z.string().max(200).optional(),
    displayName: z.string().max(200).optional(),
    version: z.union([z.string().max(100), z.number()]).optional(),
    description: z.string().max(2000).optional(),
    author: z.union([z.string().max(300), z.object({ name: z.string().max(300) }).passthrough()]).optional(),
    skills: pathList.optional(),
    commands: z.union([pathList, z.record(z.string(), commandEntry)]).optional(),
    agents: pathList.optional(),
    hooks: z.union([pathText, looseObject, z.array(z.union([pathText, looseObject])).max(50)]).optional(),
    mcpServers: z.union([pathText, looseObject, z.array(z.union([pathText, looseObject])).max(50)]).optional(),
}).passthrough();

const UNUSED_KEYS = ["lspServers", "outputStyles", "workflows", "monitors", "experimental", "userConfig", "channels", "themes", "dependencies"] as const;
const UNUSED_DIRS: Array<[string, string]> = [
    ["bin", "bin/ (programs in it are not put on any PATH)"], ["output-styles", "output-styles/"], ["themes", "themes/"], ["workflows", "workflows/"],
    ["monitors", "monitors/ (monitors are not started)"],
];

const issueText = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);

/** A JSON file that must be a plain file of a sane size. Null (with an issue, when it exists) otherwise. */
const readJson = (path: string, issues: string[], label: string): unknown => {
    let stat;
    try {
        stat = lstatSync(path);
    } catch {
        return undefined;
    }
    if (!stat.isFile()) {
        issues.push(`${label} is not a plain file, so it was not read.`);
        return undefined;
    }
    if (stat.size > MAX_JSON_BYTES) {
        issues.push(`${label} is larger than ${MAX_JSON_BYTES / 1024} KB, so it was not read.`);
        return undefined;
    }
    try {
        return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as unknown;
    } catch {
        issues.push(`${label} is not valid JSON.`);
        return undefined;
    }
};

const plainObject = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * A path a manifest names: relative to the plugin folder, starting with `./`, no `..`, and inside the folder once resolved.
 * Returns the absolute path, or null with an issue.
 */
const manifestPath = (root: string, realRoot: string, text: string, issues: string[], key: string, options: { allowRoot?: boolean } = {}): string | null => {
    const isRoot = text === "." || text === "./";
    if (isRoot && options.allowRoot) return realRoot;
    if (!text.startsWith("./") || text.includes("\\") || text.includes("\u0000") || text.split("/").includes("..") || isAbsolute(text)) {
        issues.push(`${key}: the path ${JSON.stringify(issueText(text))} must start with ./ and stay inside the plugin folder; it was not used.`);
        return null;
    }
    const absolute = resolve(root, text);
    let real: string;
    try {
        real = realpathSync.native(absolute);
    } catch {
        issues.push(`${key}: ${JSON.stringify(issueText(text))} does not exist; it was not used.`);
        return null;
    }
    if (!insideFolder(realRoot, real)) {
        issues.push(`${key}: ${JSON.stringify(issueText(text))} leads outside the plugin folder; it was not used.`);
        return null;
    }
    return real;
};

const entriesOf = (dir: string) => {
    try {
        return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
        return [];
    }
};

const isDir = (path: string) => {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
};

const isFile = (path: string) => {
    try {
        return lstatSync(path).isFile();
    } catch {
        return false;
    }
};

/** Markdown files below a folder with their path parts, depth bounded. */
const markdownFiles = (dir: string, depth = MAX_MD_DEPTH): Array<{ file: string; parts: string[] }> => {
    const out: Array<{ file: string; parts: string[] }> = [];
    const walk = (current: string, parts: string[], level: number) => {
        for (const entry of entriesOf(current)) {
            if (out.length >= MAX_MD_FILES) return;
            const path = join(current, entry.name);
            if (entry.isDirectory() && level < depth) walk(path, [...parts, entry.name], level + 1);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push({ file: path, parts: [...parts, entry.name.replace(/\.md$/i, "")] });
        }
    };
    walk(dir, [], 0);
    return out;
};

const asList = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Skill folders under a path: the path itself when it holds SKILL.md, otherwise each of its sub folders that does. */
const skillFoldersIn = (dir: string): string[] => {
    if (isFile(join(dir, "SKILL.md"))) return [dir];
    return entriesOf(dir).filter((entry) => entry.isDirectory() && isFile(join(dir, entry.name, "SKILL.md"))).map((entry) => join(dir, entry.name));
};

const hookTableFrom = (value: unknown, source: string, issues: string[]): Record<string, unknown> | null => {
    const object = plainObject(value);
    if (!object) {
        issues.push(`${source}: hooks must be an object.`);
        return null;
    }
    return object.hooks !== undefined ? object : { hooks: object };
};

const mcpTableFrom = (value: unknown, source: string, issues: string[]): Record<string, unknown> | null => {
    const object = plainObject(value);
    if (!object) {
        issues.push(`${source}: MCP servers must be an object.`);
        return null;
    }
    return object.mcpServers !== undefined ? object : { mcpServers: object };
};

export const MANIFEST_FILES = [join(".claude-plugin", "plugin.json"), join(".codex-plugin", "plugin.json"), "plugin.json"] as const;

/** Reads a plugin folder. Throws nothing for content it cannot use: that goes to `issues`. A manifest that is not valid is an issue too, and the plugin is read as if it had none. */
export const readPluginLayout = (root: string): PluginLayout => {
    const issues: string[] = [];
    const notUsed: string[] = [];
    let realRoot: string;
    try {
        realRoot = realpathSync.native(root);
    } catch {
        return { manifest: null, manifestFile: null, skillDirs: [], commandFiles: [], agentFiles: [], hookTables: [], mcpTables: [], notUsed, issues: ["The plugin folder cannot be read."] };
    }
    let manifest: z.infer<typeof manifestSchema> | null = null;
    let manifestFile: string | null = null;
    for (const candidate of MANIFEST_FILES) {
        const path = join(realRoot, candidate);
        if (!existsSync(path)) continue;
        const raw = readJson(path, issues, posix(candidate));
        const parsed = manifestSchema.safeParse(raw);
        if (!parsed.success) {
            if (raw !== undefined) issues.push(`${posix(candidate)} is not a valid plugin manifest (${issueText(parsed.error.issues[0]?.message ?? "invalid")}); it was ignored.`);
            continue;
        }
        manifest = parsed.data;
        manifestFile = posix(candidate);
        break;
    }
    const raw = manifest as Record<string, unknown> | null;
    for (const key of UNUSED_KEYS) if (raw && raw[key] !== undefined) notUsed.push(key);
    for (const [folder, label] of UNUSED_DIRS) if (isDir(join(realRoot, folder))) notUsed.push(label);
    if (isFile(join(realRoot, ".lsp.json"))) notUsed.push(".lsp.json");

    // Skills: skills/ always, plus the folders the manifest adds; a lone SKILL.md at the root is one skill.
    const skillDirs: string[] = [];
    const addSkills = (dir: string) => {
        for (const found of skillFoldersIn(dir)) if (!skillDirs.includes(found)) skillDirs.push(found);
    };
    const defaultSkills = join(realRoot, "skills");
    if (isDir(defaultSkills)) addSkills(defaultSkills);
    for (const entry of asList(manifest?.skills as string | string[] | undefined)) {
        const dir = manifestPath(realRoot, realRoot, entry, issues, "skills", { allowRoot: true });
        if (dir && isDir(dir)) addSkills(dir);
    }
    if (!skillDirs.length && !isDir(defaultSkills) && manifest?.skills === undefined && isFile(join(realRoot, "SKILL.md"))) skillDirs.push(realRoot);

    // Commands: the manifest's list replaces commands/.
    const commandFiles: Array<{ file: string; name: string }> = [];
    const commands = manifest?.commands;
    if (commands === undefined) {
        const dir = join(realRoot, "commands");
        if (isDir(dir)) for (const { file, parts } of markdownFiles(dir)) commandFiles.push({ file, name: parts.join(":") });
    } else if (typeof commands === "string" || Array.isArray(commands)) {
        for (const entry of asList(commands)) {
            const path = manifestPath(realRoot, realRoot, entry, issues, "commands");
            if (!path) continue;
            if (isDir(path)) for (const { file, parts } of markdownFiles(path)) commandFiles.push({ file, name: parts.join(":") });
            else if (isFile(path) && path.toLowerCase().endsWith(".md")) commandFiles.push({ file: path, name: basename(path).replace(/\.md$/i, "") });
            else issues.push(`commands: ${JSON.stringify(issueText(entry))} is not a Markdown file or a folder.`);
        }
    } else {
        for (const [name, entry] of Object.entries(commands)) {
            if (entry.source !== undefined && entry.content === undefined) {
                const path = manifestPath(realRoot, realRoot, entry.source, issues, `commands.${issueText(name)}`);
                if (path && isFile(path)) commandFiles.push({ file: path, name });
            } else {
                issues.push(`commands.${issueText(name)}: a command written inside the manifest (content) is not supported here; it was not used.`);
            }
        }
    }

    // Agents: the manifest's files replace agents/.
    const agentFiles: Array<{ file: string; prefix: string[] }> = [];
    if (manifest?.agents === undefined) {
        const dir = join(realRoot, "agents");
        if (isDir(dir)) for (const { file, parts } of markdownFiles(dir)) agentFiles.push({ file, prefix: parts.slice(0, -1) });
    } else {
        for (const entry of asList(manifest.agents as string | string[])) {
            const path = manifestPath(realRoot, realRoot, entry, issues, "agents");
            if (path && isFile(path) && path.toLowerCase().endsWith(".md")) agentFiles.push({ file: path, prefix: [] });
            else if (path) issues.push(`agents: ${JSON.stringify(issueText(entry))} must be a Markdown file.`);
        }
    }

    // Hooks: hooks/hooks.json, then what the manifest adds (a file, an inline table, or a list of those).
    const hookTables: PluginLayout["hookTables"] = [];
    const defaultHooks = join(realRoot, "hooks", "hooks.json");
    const defaultHooksRaw = readJson(defaultHooks, issues, "hooks/hooks.json");
    if (defaultHooksRaw !== undefined) {
        const table = hookTableFrom(defaultHooksRaw, "hooks/hooks.json", issues);
        if (table) hookTables.push({ source: "hooks/hooks.json", table });
    }
    const hookEntries = manifest?.hooks === undefined ? [] : Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks];
    hookEntries.forEach((entry, index) => {
        if (typeof entry === "string") {
            const path = manifestPath(realRoot, realRoot, entry, issues, "hooks");
            if (!path) return;
            const value = readJson(path, issues, entry);
            const table = value === undefined ? null : hookTableFrom(value, entry, issues);
            if (table) hookTables.push({ source: entry.replace(/^\.\//, ""), table });
        } else {
            const table = hookTableFrom(entry, "plugin.json hooks", issues);
            if (table) hookTables.push({ source: `plugin.json hooks${hookEntries.length > 1 ? ` #${index + 1}` : ""}`, table });
        }
    });

    // MCP servers: .mcp.json (and Codex's mcp.json), then what the manifest adds.
    const mcpTables: PluginLayout["mcpTables"] = [];
    for (const name of [".mcp.json", "mcp.json"]) {
        const value = readJson(join(realRoot, name), issues, name);
        if (value === undefined) continue;
        const table = mcpTableFrom(value, name, issues);
        if (table) mcpTables.push({ source: name, table });
    }
    const mcpEntries = manifest?.mcpServers === undefined ? [] : Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers];
    mcpEntries.forEach((entry, index) => {
        if (typeof entry === "string") {
            if (/\.(mcpb|dxt)$/i.test(entry) || /^https?:/i.test(entry)) {
                issues.push(`mcpServers: the bundle ${JSON.stringify(issueText(entry))} is not supported here; it was not used.`);
                return;
            }
            const path = manifestPath(realRoot, realRoot, entry, issues, "mcpServers");
            if (!path) return;
            const value = readJson(path, issues, entry);
            const table = value === undefined ? null : mcpTableFrom(value, entry, issues);
            if (table) mcpTables.push({ source: entry.replace(/^\.\//, ""), table });
        } else {
            const table = mcpTableFrom(entry, "plugin.json mcpServers", issues);
            if (table) mcpTables.push({ source: `plugin.json mcpServers${mcpEntries.length > 1 ? ` #${index + 1}` : ""}`, table });
        }
    });

    const author = manifest?.author === undefined ? undefined : typeof manifest.author === "string" ? manifest.author : manifest.author.name;
    return {
        manifest: manifest ? {
            ...(manifest.name ? { name: manifest.name } : {}),
            ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
            ...(manifest.version !== undefined ? { version: String(manifest.version) } : {}),
            ...(manifest.description ? { description: manifest.description } : {}),
            ...(author ? { author } : {}),
        } : null,
        manifestFile, skillDirs, commandFiles, agentFiles, hookTables, mcpTables, notUsed, issues,
    };
};

/** What a plugin is called and what its folder inside the CLI's plugin folder is called: letters, digits, `.`, `_`, `-`, starting with a letter or digit. */
export const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const validPluginName = (name: string) => PLUGIN_NAME.test(name) && !name.includes("..");

/** The name of a plugin: its manifest's, else the fallback (a catalog entry's name or the folder's own name). Null when neither is usable. */
export const pluginNameOf = (layout: PluginLayout, fallback?: string): { name: string } | { error: string } => {
    const wanted = layout.manifest?.name ?? fallback;
    if (!wanted) return { error: "The plugin has no name: its manifest needs a name." };
    if (!validPluginName(wanted)) return { error: `The plugin name ${JSON.stringify(issueText(wanted))} is not usable: letters, digits, . _ - only, up to 64 characters, starting with a letter or digit.` };
    return { name: wanted };
};

export const displayRelative = (root: string, path: string) => posix(relative(root, path));
