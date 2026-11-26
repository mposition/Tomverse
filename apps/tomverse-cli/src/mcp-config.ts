import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonicalDigest } from "./session.js";
import { tomverseHome } from "./config.js";
import { activePlugins, type ActivePlugin } from "./plugin-store.js";

/**
 * MCP server definitions the agent may connect to, read from two files in the
 * Claude Code format ({ "mcpServers": { "<name>": { command, args, env } | { type: "http", url, headers } } }):
 *
 * - user: `mcp.json` in the CLI's own user folder (TOMVERSE_HOME or ~/.tomverse). Written by the person; trusted.
 * - project: `.mcp.json` at the workspace root. Part of the repository, so it is NOT trusted: nothing in it runs until
 *   the person approves that exact definition (see project-trust.ts).
 *
 * Only stdio and streamable HTTP are supported. sse and ws are listed as unsupported; a server that needs OAuth is
 * reported as unsupported when it connects (no credential is stored by this client).
 */

export type McpScope = "user" | "project";

export type McpServerDef = {
    /** The name as written in the file. */
    name: string;
    /** The name as it appears inside tool names (mcp__<id>__<tool>): letters, digits, `_` and `-`, unique across both files. */
    id: string;
    scope: McpScope;
    /** The file the definition came from. */
    source: string;
    transport: "stdio" | "http" | "unsupported";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    /** A per-server tool call timeout in milliseconds (values under 1000 are ignored, as in Claude Code). */
    timeoutMs?: number;
    /** Why a definition cannot be used (sse, ws, a url without a type). */
    unsupportedReason?: string;
    /** Identifies this exact definition: what an approval is bound to. Environment variables are not expanded into it. */
    hash: string;
    /** The plugin the server came from (its scope is "project": third-party code that waits for the person's approval) and its installed folder. */
    plugin?: string;
    pluginRoot?: string;
};

export type McpLoad = { servers: McpServerDef[]; problems: string[] };

const MAX_FILE_BYTES = 256 * 1024;

const stdioShape = z.object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeout: z.number().optional(),
}).passthrough();

const httpShape = z.object({
    type: z.enum(["http", "streamable-http"]),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().optional(),
}).passthrough();

/** Reads a JSON file that must be a plain file (never a link out of the folder) of a sane size; null when there is none. */
export const readJsonObject = (path: string, problems: string[]): Record<string, unknown> | null => {
    let stat;
    try {
        stat = lstatSync(path);
    } catch {
        return null;
    }
    if (!stat.isFile()) {
        problems.push(`${path} is not a plain file, so it was not read.`);
        return null;
    }
    if (stat.size > MAX_FILE_BYTES) {
        problems.push(`${path} is larger than ${MAX_FILE_BYTES / 1024} KB, so it was not read.`);
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        problems.push(`${path} must hold a JSON object.`);
    } catch {
        problems.push(`${path} is not valid JSON.`);
    }
    return null;
};

const uniqueId = (name: string, used: Set<string>) => {
    const base = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "server";
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}_${n}`;
    used.add(id);
    return id;
};

/** The definitions of one file. `used` carries ids across files so tool names stay unique. */
export const parseMcpServers = (file: Record<string, unknown>, scope: McpScope, source: string, used: Set<string>, problems: string[], binding?: unknown): McpServerDef[] => {
    const table = file.mcpServers;
    if (table === undefined) return [];
    if (!table || typeof table !== "object" || Array.isArray(table)) {
        problems.push(`${source}: mcpServers must be an object.`);
        return [];
    }
    const out: McpServerDef[] = [];
    for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            problems.push(`${source}: server ${JSON.stringify(name)} must be an object.`);
            continue;
        }
        const raw = value as Record<string, unknown>;
        const hash = canonicalDigest({ name, scope, raw, ...(binding === undefined ? {} : { binding }) });
        const base = { name, scope, source, hash };
        const type = raw.type;
        const timeoutOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 1000 ? Math.floor(v) : undefined);
        if (type === "sse" || type === "ws") {
            out.push({ ...base, id: uniqueId(name, used), transport: "unsupported", unsupportedReason: `The ${type} transport is not supported; use stdio or http.` });
        } else if (type === "http" || type === "streamable-http") {
            const parsed = httpShape.safeParse(raw);
            if (!parsed.success) {
                problems.push(`${source}: server ${JSON.stringify(name)} needs a url.`);
                continue;
            }
            out.push({ ...base, id: uniqueId(name, used), transport: "http", url: parsed.data.url, ...(parsed.data.headers ? { headers: parsed.data.headers } : {}),
                ...(timeoutOf(parsed.data.timeout) ? { timeoutMs: timeoutOf(parsed.data.timeout) } : {}) });
        } else if (type === undefined || type === "stdio") {
            if (typeof raw.url === "string" && raw.command === undefined) {
                out.push({ ...base, id: uniqueId(name, used), transport: "unsupported", unsupportedReason: 'A url server needs "type": "http".' });
                continue;
            }
            const parsed = stdioShape.safeParse(raw);
            if (!parsed.success) {
                problems.push(`${source}: server ${JSON.stringify(name)} needs a command.`);
                continue;
            }
            out.push({ ...base, id: uniqueId(name, used), transport: "stdio", command: parsed.data.command, args: parsed.data.args ?? [],
                ...(parsed.data.env ? { env: parsed.data.env } : {}), ...(timeoutOf(parsed.data.timeout) ? { timeoutMs: timeoutOf(parsed.data.timeout) } : {}) });
        } else {
            out.push({ ...base, id: uniqueId(name, used), transport: "unsupported", unsupportedReason: `The transport ${JSON.stringify(String(type)).slice(0, 40)} is not supported; use stdio or http.` });
        }
    }
    return out;
};

export const userMcpFile = (home: string = tomverseHome()) => join(home, "mcp.json");
export const projectMcpFile = (root: string) => join(root, ".mcp.json");

/**
 * Both files. A project server whose name a user server already has is not loaded (the person's own definition wins, so a
 * repository cannot stand in for a server they trust), and it is reported.
 */
export const loadMcpServers = (root: string, home: string = tomverseHome()): McpLoad => {
    const problems: string[] = [];
    const used = new Set<string>();
    const servers: McpServerDef[] = [];
    const userPath = userMcpFile(home);
    const user = readJsonObject(userPath, problems);
    if (user) servers.push(...parseMcpServers(user, "user", userPath, used, problems));
    const projectPath = projectMcpFile(root);
    const project = readJsonObject(projectPath, problems);
    if (project) {
        const userNames = new Set(servers.map((s) => s.name));
        for (const def of parseMcpServers(project, "project", projectPath, used, problems)) {
            if (userNames.has(def.name)) problems.push(`The project server ${JSON.stringify(def.name)} has the same name as one of your own servers, so it was not loaded.`);
            else servers.push(def);
        }
    }
    for (const plugin of activePlugins(home, root)) servers.push(...pluginMcpServers(plugin, used, problems));
    return { servers, problems };
};

/**
 * The MCP servers one plugin brings, named `plugin:<plugin>:<server>`. Each is bound to the plugin's name and the digest of its files,
 * so an approval holds for exactly this code. `${CLAUDE_PLUGIN_ROOT}` is the plugin's installed folder (see expandMcpServer). A server that
 * wants a value from the plugin's own settings (`${user_config.*}`) is not loaded.
 */
export const pluginMcpServers = (plugin: Pick<ActivePlugin, "name" | "dir" | "digest" | "layout">, used: Set<string>, problems: string[]): McpServerDef[] => {
    const out: McpServerDef[] = [];
    for (const { source, table } of plugin.layout.mcpTables) {
        const label = `plugin ${plugin.name}: ${source}`;
        const servers = table.mcpServers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
            problems.push(`${label}: mcpServers must be an object.`);
            continue;
        }
        const renamed: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
            if (JSON.stringify(value)?.includes("${user_config.")) {
                problems.push(`${label}: the server ${JSON.stringify(name)} reads the plugin's own settings (user_config), which is not supported; it was not loaded.`);
                continue;
            }
            renamed[`plugin:${plugin.name}:${name}`] = value;
        }
        for (const def of parseMcpServers({ mcpServers: renamed }, "project", label, used, problems, { plugin: plugin.name, digest: plugin.digest })) {
            out.push({ ...def, plugin: plugin.name, pluginRoot: plugin.dir });
        }
    }
    return out;
};

/** Names a definition may never read from the environment: they hold the Tomverse key or session, or change how a program loads code. */
const NEVER_EXPANDED = /^(?:TOMVERSE_|ELECTRON_)|^NODE_(?:OPTIONS|PATH|REPL_EXTERNAL_MODULE|EXTRA_CA_CERTS)$/i;

/**
 * `${VAR}` and `${VAR:-default}` as in Claude Code. An unset variable without a default stays as written and is reported.
 * `${CLAUDE_PROJECT_DIR}` is the workspace root. TOMVERSE_*, ELECTRON_* and NODE_OPTIONS-like names are never read: they count as unset.
 */
export const expandVariables = (text: string, root: string, env: NodeJS.ProcessEnv, warnings: string[], pluginRoot?: string) =>
    text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback: string | undefined) => {
        if (name === "CLAUDE_PROJECT_DIR" || name === "TOMVERSE_PROJECT_DIR") return root;
        if (name === "CLAUDE_PLUGIN_ROOT" && pluginRoot) return pluginRoot;
        const blocked = NEVER_EXPANDED.test(name);
        const value = blocked ? undefined : env[name];
        if (value !== undefined) return value;
        if (fallback !== undefined) return fallback;
        warnings.push(blocked ? `${name} is never passed to a server.` : `${name} is not set.`);
        return blocked ? "" : whole;
    });

export type ExpandedMcpServer = {
    command?: string;
    args: string[];
    env: Record<string, string>;
    url?: string;
    headers: Record<string, string>;
    warnings: string[];
};

export const expandMcpServer = (def: McpServerDef, root: string, env: NodeJS.ProcessEnv = process.env): ExpandedMcpServer => {
    const warnings: string[] = [];
    const pluginRoot = def.pluginRoot && process.platform === "win32" ? def.pluginRoot.replaceAll("\\", "/") : def.pluginRoot;
    const sub = (text: string) => expandVariables(text, root, env, warnings, pluginRoot);
    return {
        ...(def.command !== undefined ? { command: sub(def.command) } : {}),
        args: (def.args ?? []).map(sub),
        env: { ...(pluginRoot ? { CLAUDE_PLUGIN_ROOT: pluginRoot } : {}), ...Object.fromEntries(Object.entries(def.env ?? {}).map(([key, value]) => [key, sub(value)])) },
        ...(def.url !== undefined ? { url: sub(def.url) } : {}),
        headers: Object.fromEntries(Object.entries(def.headers ?? {}).map(([key, value]) => [key, sub(value)])),
        warnings,
    };
};

/** One line for a list: the command or the address without its query. Header and env values are never shown. */
export const describeMcpServer = (def: McpServerDef) => {
    if (def.transport === "stdio") return [def.command, ...(def.args ?? [])].join(" ");
    if (def.transport === "http") {
        try {
            const url = new URL(def.url ?? "");
            return `${url.origin}${url.pathname}`;
        } catch {
            return "(invalid address)";
        }
    }
    return def.unsupportedReason ?? "unsupported";
};

/** The user's real home, for the Claude Code files hooks are read from (CLAUDE_CONFIG_DIR as in Claude Code). */
export const claudeHome = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
