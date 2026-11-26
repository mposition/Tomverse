import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseToml } from "./extension-parsers.js";
import { discoverExtensions, type DiscoverOptions, type ExtensionRegistry } from "./extensions.js";
import { sha256, writeFileAtomic } from "./session.js";
import { tomverseHome } from "./config.js";

/**
 * "Import from Claude Code / Codex": what the person already has in those tools, shown before anything is used, and the part that
 * needs a copy -- MCP servers of the user's own configuration -- converted into Tomverse's user MCP file (`mcp.json` in the CLI's
 * configuration folder, the same shape as a project's `.mcp.json`).
 *
 * Instruction files, skills, commands and agent definitions are read where they are, so they are only listed. Nothing here starts an
 * MCP server. The `env` and `headers` values of a server can be secrets: a preview shows them hidden, a file is written only for
 * the items the person selected, and no value is logged or kept anywhere else.
 */

export type ImportTool = "claude" | "codex" | "agents";
export type ImportKind = "instructions" | "skill" | "command" | "agent" | "mcp";
export type ImportStatus = "in-use" | "importable" | "imported" | "conflict" | "unsupported";

export type ImportItem = {
    id: string;
    kind: ImportKind;
    tool: ImportTool;
    name: string;
    source: string;
    scope: "project" | "user";
    status: ImportStatus;
    detail?: string;
    /** MCP servers only: what the server is, with every secret-looking value (env for a program, headers for an address) hidden. */
    mcp?: { transport: "stdio" | "http"; summary: string; values: Array<{ key: string; value: string }> };
};

export type ImportOptions = DiscoverOptions & { tomverseHome?: string };

export type McpServer =
    | { command: string; args?: string[]; env?: Record<string, string> }
    | { type: "http"; url: string; headers?: Record<string, string> };

const HIDDEN = "••••••";
const REFERENCE = /^(Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const SECRET_FLAG = /(token|key|secret|password|passwd|auth|credential)/i;

/** A value of env or headers: a plain `${NAME}` reference is shown (it holds nothing), anything else is hidden. */
export const maskValue = (value: string) => (REFERENCE.test(value.trim()) ? value.trim() : HIDDEN);

const maskUrl = (raw: string) => {
    try {
        const url = new URL(raw);
        if (url.username || url.password) {
            url.username = "";
            url.password = "";
        }
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, SECRET_FLAG.test(key) ? HIDDEN : url.searchParams.get(key)!);
        return decodeURIComponent(url.toString());
    } catch {
        return HIDDEN;
    }
};

/** Arguments with the value of a flag that looks like a credential hidden (`--token x`, `--api-key=x`, `Bearer x`). */
export const maskArgs = (args: string[]): string[] => args.map((arg, index) => {
    const equals = /^(--?[\w-]+)=([\s\S]*)$/.exec(arg);
    if (equals && SECRET_FLAG.test(equals[1]!) && !REFERENCE.test(equals[2]!)) return `${equals[1]}=${HIDDEN}`;
    const before = args[index - 1];
    if (before && /^--?[\w-]+$/.test(before) && SECRET_FLAG.test(before) && !REFERENCE.test(arg)) return HIDDEN;
    if (/^Bearer\s+\S/i.test(arg) && !REFERENCE.test(arg.replace(/^Bearer\s+/i, ""))) return `Bearer ${HIDDEN}`;
    return arg;
});

const isStringRecord = (value: unknown): value is Record<string, string> =>
    !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

type Normalized = { server?: McpServer; unsupported?: string; dropped: string[] };

const KNOWN_CLAUDE = new Set(["type", "command", "args", "env", "url", "headers"]);

/** A server of Claude Code's `mcpServers` (also what `.mcp.json` holds), reduced to the two shapes Tomverse reads. */
export const normalizeClaudeServer = (raw: unknown): Normalized => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { unsupported: "not a server definition", dropped: [] };
    const entry = raw as Record<string, unknown>;
    const dropped = Object.keys(entry).filter((key) => !KNOWN_CLAUDE.has(key));
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (type === "http" || type === "streamable-http") {
        if (typeof entry.url !== "string" || !entry.url) return { unsupported: "no url", dropped };
        if (entry.headers !== undefined && !isStringRecord(entry.headers)) return { unsupported: "headers are not text values", dropped };
        return { server: { type: "http", url: entry.url, ...(entry.headers ? { headers: entry.headers as Record<string, string> } : {}) }, dropped };
    }
    if (type !== undefined && type !== "stdio") return { unsupported: `the ${type} transport is not supported`, dropped };
    if (typeof entry.command !== "string" || !entry.command) return { unsupported: "no command", dropped };
    if (entry.args !== undefined && !isStringList(entry.args)) return { unsupported: "args are not text values", dropped };
    if (entry.env !== undefined && !isStringRecord(entry.env)) return { unsupported: "env is not text values", dropped };
    return {
        server: { command: entry.command, ...(entry.args ? { args: entry.args as string[] } : {}), ...(entry.env ? { env: entry.env as Record<string, string> } : {}) },
        dropped,
    };
};

const KNOWN_CODEX = new Set(["command", "args", "env", "env_vars", "url", "bearer_token_env_var", "http_headers", "env_http_headers", "enabled"]);

/** A `[mcp_servers.<name>]` table of Codex's config.toml. Environment variables it forwards or reads become `${NAME}` references. */
export const normalizeCodexServer = (raw: unknown): Normalized => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { unsupported: "not a server definition", dropped: [] };
    const entry = raw as Record<string, unknown>;
    const dropped = Object.keys(entry).filter((key) => !KNOWN_CODEX.has(key));
    if (entry.enabled === false) return { unsupported: "turned off in Codex", dropped };
    if (typeof entry.url === "string" && entry.url) {
        const headers: Record<string, string> = {};
        if (entry.http_headers !== undefined) {
            if (!isStringRecord(entry.http_headers)) return { unsupported: "http_headers are not text values", dropped };
            Object.assign(headers, entry.http_headers);
        }
        if (entry.env_http_headers !== undefined) {
            if (!isStringRecord(entry.env_http_headers)) return { unsupported: "env_http_headers are not text values", dropped };
            for (const [header, name] of Object.entries(entry.env_http_headers)) headers[header] = `\${${name}}`;
        }
        if (typeof entry.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${entry.bearer_token_env_var}}`;
        return { server: { type: "http", url: entry.url, ...(Object.keys(headers).length ? { headers } : {}) }, dropped };
    }
    if (typeof entry.command !== "string" || !entry.command) return { unsupported: "no command or url", dropped };
    if (entry.args !== undefined && !isStringList(entry.args)) return { unsupported: "args are not text values", dropped };
    const env: Record<string, string> = {};
    if (entry.env !== undefined) {
        if (!isStringRecord(entry.env)) return { unsupported: "env is not text values", dropped };
        Object.assign(env, entry.env);
    }
    if (entry.env_vars !== undefined) {
        if (!isStringList(entry.env_vars)) return { unsupported: "env_vars are not names", dropped };
        for (const name of entry.env_vars) env[name] = `\${${name}}`;
    }
    return {
        server: { command: entry.command, ...(entry.args ? { args: entry.args as string[] } : {}), ...(Object.keys(env).length ? { env } : {}) },
        dropped,
    };
};

const describeServer = (server: McpServer): NonNullable<ImportItem["mcp"]> => {
    const secrets = "command" in server ? server.env : server.headers;
    const rows = Object.keys(secrets ?? {}).sort().map((key) => ({ key, value: maskValue(secrets![key]!) }));
    return "command" in server
        ? { transport: "stdio", summary: [server.command, ...maskArgs(server.args ?? [])].join(" "), values: rows }
        : { transport: "http", summary: maskUrl(server.url), values: rows };
};

const readJson = (path: string, limit = 8 * 1024 * 1024): Record<string, unknown> | null => {
    try {
        if (!existsSync(path) || statSync(path).size > limit) return null;
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
};

const serversOf = (value: unknown): Array<[string, unknown]> =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];

const sameServer = (a: unknown, b: McpServer) => JSON.stringify(a) === JSON.stringify(b);

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

export type Collected = {
    items: ImportItem[];
    /** The servers behind the importable items, by item id: the real values, only ever used to write the file. */
    servers: Map<string, { name: string; server: McpServer }>;
    target: string;
    targetBroken: boolean;
};

const mcpTarget = (options: ImportOptions) => join(options.tomverseHome ?? tomverseHome(options.env), "mcp.json");

const sameFolder = (a: string, b: string) => {
    const norm = (value: string) => resolve(value).replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" || process.platform === "darwin" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** Everything found, with what is already used, what can be copied and what cannot. */
export const collectImport = (root: string, options: ImportOptions = {}, registry: ExtensionRegistry = discoverExtensions(root, options)): Collected => {
    const home = options.home ?? homedir();
    const env = options.env ?? process.env;
    const items: ImportItem[] = [];
    const servers: Collected["servers"] = new Map();
    const itemId = (...parts: string[]) => `i-${sha256(parts.join("\u0000")).slice(0, 12)}`;

    for (const [file, tool] of [["AGENTS.md", "agents"], ["CLAUDE.md", "claude"]] as const) {
        if (existsSync(join(root, file))) {
            items.push({ id: itemId("instructions", file), kind: "instructions", tool, name: file, source: file, scope: "project", status: "in-use", detail: "Read as the project's instructions." });
        }
    }
    for (const skill of registry.skills) {
        items.push({ id: itemId("skill", skill.source), kind: "skill", tool: skill.flavor === "agents" ? "agents" : "claude", name: skill.name, source: skill.source, scope: skill.scope, status: "in-use", ...(skill.ignored.length ? { detail: `Not applied: ${skill.ignored.join(", ")}.` } : {}) });
    }
    for (const command of registry.commands) {
        items.push({ id: itemId("command", command.source), kind: "command", tool: command.flavor, name: `/${command.name}`, source: command.source, scope: command.scope, status: "in-use", ...(command.ignored.length ? { detail: `Not applied: ${command.ignored.join(", ")}.` } : {}) });
    }
    for (const agent of registry.agents) {
        items.push({ id: itemId("agent", agent.source), kind: "agent", tool: agent.flavor, name: agent.name, source: agent.source, scope: agent.scope, status: "in-use", ...(agent.ignored.length ? { detail: `Not applied: ${agent.ignored.join(", ")}.` } : {}) });
    }

    // The Tomverse user MCP file the servers would go into.
    const target = mcpTarget(options);
    const existingFile = existsSync(target) ? readJson(target) : {};
    const targetBroken = existingFile === null;
    const existing = serversOf(existingFile?.mcpServers);

    const note = (kind: "project" | "user", tool: ImportTool, source: string, name: string, raw: unknown, normalize: (raw: unknown) => Normalized) => {
        const id = itemId("mcp", source, name, JSON.stringify(raw ?? null));
        const base = { id, kind: "mcp" as const, tool, name, source, scope: kind };
        if (!NAME.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
            items.push({ ...base, status: "unsupported", detail: "The server name is not usable." });
            return;
        }
        const { server, unsupported, dropped } = normalize(raw);
        if (!server) {
            items.push({ ...base, status: "unsupported", detail: `Not copied: ${unsupported}.` });
            return;
        }
        const mcp = describeServer(server);
        const droppedNote = dropped.length ? ` Not copied: ${dropped.join(", ")}.` : "";
        if (kind === "project") {
            items.push({ ...base, status: "in-use", mcp, detail: `Read in place from the project.${droppedNote}` });
            return;
        }
        const present = existing.find(([key]) => key === name);
        if (present) {
            items.push({ ...base, status: sameServer(present[1], server) ? "imported" : "conflict", mcp,
                detail: sameServer(present[1], server) ? "Already in Tomverse's MCP file." : "A different server with this name is already in Tomverse's MCP file; it is not replaced." });
            return;
        }
        if (targetBroken) {
            items.push({ ...base, status: "conflict", mcp, detail: "Tomverse's MCP file is not valid JSON; fix or delete it first." });
            return;
        }
        servers.set(id, { name, server });
        items.push({ ...base, status: "importable", mcp, ...(droppedNote ? { detail: droppedNote.trim() } : {}) });
    };

    const projectMcp = readJson(join(root, ".mcp.json"));
    for (const [name, raw] of serversOf(projectMcp?.mcpServers)) note("project", "claude", ".mcp.json", name, raw, normalizeClaudeServer);

    const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() ? resolve(env.CLAUDE_CONFIG_DIR.trim()) : home;
    const claudeJson = readJson(join(claudeHome, ".claude.json"));
    // Documented: user-scope servers live in ~/.claude.json and local-scope ones under projects["<path>"].mcpServers. The top-level
    // `mcpServers` key for user scope is not spelled out in the docs; it is read the same way and shown with its source.
    for (const [name, raw] of serversOf(claudeJson?.mcpServers)) note("user", "claude", "~/.claude.json (user)", name, raw, normalizeClaudeServer);
    for (const [path, project] of serversOf(claudeJson?.projects)) {
        if (sameFolder(path, root)) {
            for (const [name, raw] of serversOf((project as Record<string, unknown> | null)?.mcpServers)) note("user", "claude", "~/.claude.json (this project, local)", name, raw, normalizeClaudeServer);
        }
    }

    const codexFile = join(home, ".codex", "config.toml");
    if (existsSync(codexFile)) {
        try {
            if (statSync(codexFile).size <= 1024 * 1024) {
                const toml = parseToml(readFileSync(codexFile, "utf8"));
                for (const [name, raw] of serversOf(toml.mcp_servers)) note("user", "codex", "~/.codex/config.toml", name, raw, normalizeCodexServer);
            }
        } catch (error) {
            items.push({ id: itemId("mcp", "~/.codex/config.toml"), kind: "mcp", tool: "codex", name: "config.toml", source: "~/.codex/config.toml", scope: "user", status: "unsupported", detail: `Not read: ${(error as Error).message}.` });
        }
    }
    return { items, servers, target, targetBroken };
};

export type ImportResult = { written: string[]; skipped: Array<{ id: string; reason: string }>; target: string };

/**
 * Writes the selected MCP servers into Tomverse's user MCP file. Only ids the preview just produced are accepted (a changed source
 * has a new id), nothing already in the file is replaced, and the file is private to the user.
 */
export const applyImport = (root: string, ids: string[], options: ImportOptions = {}): ImportResult => {
    const collected = collectImport(root, options);
    const written: string[] = [];
    const skipped: ImportResult["skipped"] = [];
    const chosen = new Set(ids);
    const additions: Array<[string, McpServer]> = [];
    const names = new Set<string>();
    for (const id of chosen) {
        const found = collected.servers.get(id);
        if (found && names.has(found.name)) skipped.push({ id, reason: "another selected server has the same name" });
        else if (found) {
            names.add(found.name);
            additions.push([found.name, found.server]);
            written.push(found.name);
        } else skipped.push({ id, reason: "not importable (it changed, is already there or cannot be copied)" });
    }
    if (additions.length) {
        const file = readJson(collected.target) ?? {};
        const mcpServers: Record<string, unknown> = { ...(file.mcpServers && typeof file.mcpServers === "object" ? file.mcpServers as Record<string, unknown> : {}) };
        for (const [name, server] of additions) mcpServers[name] = server;
        mkdirSync(join(collected.target, ".."), { recursive: true, mode: 0o700 });
        writeFileAtomic(collected.target, `${JSON.stringify({ ...file, mcpServers }, null, 2)}\n`);
        if (process.platform !== "win32") chmodSync(collected.target, 0o600);
    }
    return { written, skipped, target: collected.target };
};
