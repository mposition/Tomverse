import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { killTreeSync } from "./commands.js";
import { commandEnv } from "./env.js";
import { expandMcpServer, type McpServerDef } from "./mcp-config.js";

/**
 * Connects to several MCP servers at once and offers their tools. One server failing, hanging or needing a login never
 * stops another server or the task: each connection is its own promise with its own start-up timeout.
 *
 * Nothing runs unless `canRun` says so for that exact definition (a project server needs the person's approval of its
 * hash; the manager does not know why). A stdio server gets its own `env` and a minimal base environment, never the
 * Tomverse key or session (env.ts), whatever the process holding this manager has in its environment.
 */

export type McpState = "idle" | "connected" | "failed" | "pending_approval" | "disabled" | "unsupported" | "needs_auth";

export type McpServerStatus = {
    id: string;
    name: string;
    scope: McpServerDef["scope"];
    source: string;
    transport: McpServerDef["transport"];
    hash: string;
    state: McpState;
    toolCount: number;
    /** A short reason for failed, unsupported and needs_auth. */
    detail?: string;
};

export type McpToolInfo = {
    /** What the model calls it: mcp__<server id>__<tool>. */
    name: string;
    server: string;
    tool: string;
    description: string;
    inputSchema: Record<string, unknown>;
    scope: McpServerDef["scope"];
    hash: string;
    /** The plugin the server came from, when it came from one. */
    plugin?: string;
};

export type McpCallResult = { isError: boolean; text: string; truncated: boolean };

export type McpManagerOptions = {
    root: string;
    servers: McpServerDef[];
    /** Whether this definition may run: a user server, or a project server whose exact hash the person approved. */
    canRun: (def: McpServerDef) => "yes" | "pending_approval" | "disabled";
    env?: NodeJS.ProcessEnv;
    startupTimeoutMs?: number;
    callTimeoutMs?: number;
    /** Used instead of a real transport (tests). */
    transportFor?: (def: McpServerDef) => Transport | null;
};

export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const MCP_RESULT_CHARS = 60_000;
const TOOL_NAME_LIMIT = 64;
/** A server's tool list is data from another program: a tool with an enormous input schema, or beyond the first 100 tools of a server, is left out so one server cannot fill the model's context. */
const MAX_TOOLS_PER_SERVER = 100;
const MAX_SCHEMA_CHARS = 20_000;

const timeoutFromEnv = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : fallback;
};

class Connection {
    client: Client | null = null;
    transport: Transport | null = null;
    pid: number | null = null;
    stderr = "";
    tools: McpToolInfo[] = [];
    state: McpState = "idle";
    detail: string | undefined;
    constructor(readonly def: McpServerDef) {}
}

const short = (text: string, n = 300) => text.replace(/\s+/g, " ").trim().slice(0, n);

const sanitize = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "_");

/** `mcp__<server>__<tool>`, within the 64 characters function names may have, and unique among `taken`. */
export const mcpToolName = (serverId: string, tool: string, taken: Set<string>) => {
    let name = `mcp__${serverId}__${sanitize(tool)}`;
    if (name.length > TOOL_NAME_LIMIT) {
        const digest = createHash("sha256").update(`${serverId}\n${tool}`).digest("hex").slice(0, 6);
        name = `${name.slice(0, TOOL_NAME_LIMIT - 7)}_${digest}`;
    }
    for (let n = 2; taken.has(name); n += 1) name = `${name.slice(0, TOOL_NAME_LIMIT - 3)}_${n}`;
    taken.add(name);
    return name;
};

type ContentPart = { type: string; text?: string; mimeType?: string; data?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string } };

/** Text of a tool result. Images and binary resources are named, not included: the model gets text only. */
export const renderMcpContent = (result: { content?: unknown; structuredContent?: unknown; isError?: boolean }, limit = MCP_RESULT_CHARS): McpCallResult => {
    const parts = Array.isArray(result.content) ? (result.content as ContentPart[]) : [];
    const lines: string[] = [];
    for (const part of parts) {
        if (part.type === "text") lines.push(String(part.text ?? ""));
        else if (part.type === "image" || part.type === "audio") lines.push(`[${part.type} ${part.mimeType ?? ""} omitted: ${Math.floor(((part.data?.length ?? 0) * 3) / 4)} bytes]`);
        else if (part.type === "resource" && part.resource) {
            lines.push(typeof part.resource.text === "string" ? `[resource ${part.resource.uri ?? ""}]\n${part.resource.text}` : `[resource ${part.resource.uri ?? ""} omitted: binary]`);
        } else if (part.type === "resource_link") lines.push(`[resource link ${(part as { uri?: string }).uri ?? ""}]`);
        else lines.push(`[${part.type} content omitted]`);
    }
    if (!lines.length && result.structuredContent !== undefined) lines.push(JSON.stringify(result.structuredContent));
    const text = lines.join("\n");
    return { isError: result.isError === true, text: text.length > limit ? text.slice(0, limit) : text, truncated: text.length > limit };
};

export class McpManager {
    private readonly connections: Connection[];
    private readonly byTool = new Map<string, { connection: Connection; tool: string }>();
    private readonly startupMs: number;
    private readonly callMs: number;
    private started: Promise<void> | null = null;
    private closed = false;

    constructor(private readonly options: McpManagerOptions) {
        const env = options.env ?? process.env;
        this.startupMs = options.startupTimeoutMs ?? timeoutFromEnv(env.MCP_TIMEOUT, DEFAULT_STARTUP_TIMEOUT_MS);
        this.callMs = options.callTimeoutMs ?? timeoutFromEnv(env.MCP_TOOL_TIMEOUT, DEFAULT_CALL_TIMEOUT_MS);
        this.connections = options.servers.map((def) => new Connection(def));
        for (const c of this.connections) this.settleInitialState(c);
    }

    private settleInitialState(c: Connection) {
        if (c.def.transport === "unsupported") {
            c.state = "unsupported";
            c.detail = c.def.unsupportedReason;
            return;
        }
        const verdict = this.options.canRun(c.def);
        c.state = verdict === "yes" ? "idle" : verdict;
    }

    /** Connects every server that may run, all at once. Never throws: a failure is recorded on that server. */
    start(signal?: AbortSignal): Promise<void> {
        this.started ??= Promise.allSettled(this.connections.filter((c) => c.state === "idle").map((c) => this.connect(c, signal))).then(() => undefined);
        return this.started;
    }

    private makeTransport(c: Connection): Transport {
        const injected = this.options.transportFor?.(c.def);
        if (injected) return injected;
        const expanded = expandMcpServer(c.def, this.options.root, this.options.env ?? process.env);
        if (c.def.transport === "http") {
            let url: URL;
            try {
                url = new URL(expanded.url ?? "");
            } catch {
                throw new Error("The server address is not a URL.");
            }
            if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The server address must be http or https.");
            return new StreamableHTTPClientTransport(url, { requestInit: { headers: expanded.headers } });
        }
        // Only the definition's own variables on top of the small command environment: no Tomverse key or session.
        const env = { ...commandEnv([], this.options.env ?? process.env), ...expanded.env };
        const transport = new StdioClientTransport({ command: expanded.command ?? "", args: expanded.args, env, cwd: this.options.root, stderr: "pipe" });
        transport.stderr?.on("data", (chunk: Buffer) => {
            c.stderr = (c.stderr + chunk.toString("utf8")).slice(-2000);
        });
        return transport;
    }

    private async connect(c: Connection, outer?: AbortSignal) {
        const timeout = this.startupMs;
        const stop = AbortSignal.any([...(outer ? [outer] : []), AbortSignal.timeout(timeout)]);
        try {
            const transport = this.makeTransport(c);
            c.transport = transport;
            const client = new Client({ name: "tomverse", version: "1.0.0" }, { capabilities: {} });
            c.client = client;
            client.onerror = () => undefined;
            await client.connect(transport, { timeout, signal: stop });
            c.pid = (transport as StdioClientTransport).pid ?? null;
            const listed = await client.listTools(undefined, { timeout, signal: stop });
            const taken = new Set(this.byTool.keys());
            c.tools = listed.tools.filter((tool) => JSON.stringify(tool.inputSchema ?? {}).length <= MAX_SCHEMA_CHARS).slice(0, MAX_TOOLS_PER_SERVER).map((tool) => {
                const name = mcpToolName(c.def.id, tool.name, taken);
                this.byTool.set(name, { connection: c, tool: tool.name });
                const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? { ...(tool.inputSchema as Record<string, unknown>) } : {};
                return {
                    name, server: c.def.id, tool: tool.name, scope: c.def.scope, hash: c.def.hash, ...(c.def.plugin ? { plugin: c.def.plugin } : {}),
                    description: short(`${tool.description ?? ""}`, 1500),
                    inputSchema: { ...schema, type: "object", properties: (schema.properties as Record<string, unknown> | undefined) ?? {} },
                };
            });
            if (this.closed) throw new Error("closed");
            c.state = "connected";
        } catch (error) {
            const timedOut = stop.aborted && !outer?.aborted;
            const text = short((error as Error)?.message ?? String(error));
            // The SDK's UnauthorizedError carries no stable class across versions; a 401 is what a server that needs OAuth answers.
            const needsAuth = (error as Error)?.name === "UnauthorizedError" || /\b401\b|unauthori[sz]ed/i.test(text);
            c.state = needsAuth ? "needs_auth" : "failed";
            c.detail = needsAuth ? "This server needs an OAuth sign-in, which is not supported here."
                : timedOut ? `No answer within ${Math.round(timeout / 1000)} seconds.`
                    : short(c.stderr ? `${text} (${c.stderr})` : text);
            await this.shut(c);
        }
    }

    status(): McpServerStatus[] {
        return this.connections.map((c) => ({
            id: c.def.id, name: c.def.name, scope: c.def.scope, source: c.def.source, transport: c.def.transport, hash: c.def.hash,
            state: c.state, toolCount: c.state === "connected" ? c.tools.length : 0, ...(c.detail ? { detail: c.detail } : {}),
        }));
    }

    tools(): McpToolInfo[] {
        return this.connections.filter((c) => c.state === "connected").flatMap((c) => c.tools);
    }

    has(toolName: string) {
        return this.byTool.has(toolName) && this.byTool.get(toolName)!.connection.state === "connected";
    }

    info(toolName: string): McpToolInfo | undefined {
        const entry = this.byTool.get(toolName);
        return entry?.connection.tools.find((t) => t.name === toolName);
    }

    /** One tool call, with its own time limit. A failure or timeout is a result, never a thrown error. */
    async call(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
        const entry = this.byTool.get(toolName);
        const c = entry?.connection;
        if (!entry || !c?.client || c.state !== "connected") return { isError: true, text: "The MCP server is not connected.", truncated: false };
        const timeout = c.def.timeoutMs ?? this.callMs;
        try {
            const result = await c.client.callTool({ name: entry.tool, arguments: args }, undefined, { timeout, ...(signal ? { signal } : {}) });
            return renderMcpContent(result as Parameters<typeof renderMcpContent>[0]);
        } catch (error) {
            if (signal?.aborted) throw error;
            const text = short((error as Error)?.message ?? String(error));
            return { isError: true, text: /timed out|timeout/i.test(text) ? `The server did not answer within ${Math.round(timeout / 1000)} seconds.` : `The server call failed: ${text}`, truncated: false };
        }
    }

    private async shut(c: Connection) {
        const client = c.client;
        const transport = c.transport;
        // Read before closing: the transport forgets its child's pid once closed.
        const spawned = (transport as StdioClientTransport | null)?.pid ?? c.pid;
        c.client = null;
        c.transport = null;
        try {
            await (client ?? transport)?.close();
        } catch {
            // already gone
        }
        // The SDK ends its child with stdin, SIGTERM and SIGKILL; whatever is still there after that is ended here.
        if (spawned) {
            try {
                process.kill(spawned, 0);
                if (process.platform === "win32") killTreeSync(spawned);
                else process.kill(spawned, "SIGKILL");
            } catch {
                // not running
            }
        }
        c.pid = null;
    }

    /** Ends every connection and the processes behind them. Safe to call twice. */
    async close() {
        this.closed = true;
        await Promise.allSettled(this.connections.map((c) => this.shut(c)));
        for (const c of this.connections) if (c.state === "connected" || c.state === "idle") c.state = "idle";
        this.byTool.clear();
    }
}
