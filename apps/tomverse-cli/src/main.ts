import { isEffort, type Effort } from "./effort.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSea } from "node:sea";
import { parseArgs } from "node:util";
import { EXIT_CODES, Runner, SMART_ADAPTIVE, type Outcome, type Prompter } from "./agent.js";
import { AuthError, keyPrefix, maskKey, readKey } from "./auth.js";
import type { ApprovalMemory } from "./approvals.js";
import { UndoError, renderChange, undoChange, viewChanges } from "./changes.js";
import { userShell } from "./commands.js";
import { ConfigError, endpointMoveNote, ensureHome, readConfig, resolveEndpoint, tomverseHome, writeConfig, type CliConfig } from "./config.js";
import { createOutput, safeLine, type Output } from "./display.js";
import { Gateway, GatewayError, type CatalogModel } from "./gateway.js";
import { forkThrough, rewindDialog } from "./history-cli.js";
import { askLine, isInteractive, terminalPrompter } from "./interactive.js";
import { RewindError } from "./rewind.js";
import { deleteSession, Journal, JournalError, listSessions, SessionLockedError, sessionsDir } from "./session.js";
import { CLI_VERSION } from "./version.js";
import { gitAvailable, normalizeRoot, PathError, ripgrepAvailable, same, Workspace } from "./workspace.js";

import { memoryFileFor, ProjectMemory } from "./memory.js";
import { PERMISSIONS_HELP, PermissionsUsageError, permissionsCommand } from "./permission-cli.js";
import { PermissionGate } from "./permissions.js";
import { PermissionRuleStore } from "./permission-rules.js";
import { discoverExtensions, describeRegistry, expandInvocation, ExtensionError } from "./extensions.js";
import { startLocalExtensions } from "./local-extensions.js";
import { extensionsCommand } from "./extensions-cli.js";
import { normalizeAllowedDomains } from "./net-proxy.js";
import { createSandboxRuntime, normalizeSandboxSettings, sandboxModes, type SandboxMode, type SandboxRuntime } from "./sandbox.js";
import { pluginCommand } from "./plugin-cli.js";
import { ORCHESTRATION_BOUNDS, describeOrchestration, normalizeOrchestration } from "./runtime.js";
import { DEFAULTS, GOAL_MAX_CONTINUATIONS, LIMIT_PROFILES, isLimitProfile, resolveLimits, sessionCost, readInstructions, reconcile, createSession, validateSession } from "./runtime.js";
export { DEFAULTS, sessionCost, readInstructions } from "./runtime.js";

const HELP = `tomverse ${CLI_VERSION} -- a coding agent for your own folder, on your Tomverse API key.

Usage:
  tomverse [task]                 Interactive session in the current folder
  tomverse exec <task> [--json]   Run one task without prompts; stops at the first approval
  tomverse resume <session> [task]
  tomverse models [--json]        Models this key can use, with credits per request
  tomverse usage [--session <id>] [--json]
  tomverse sessions list [--json] | sessions delete <session> [--yes]
  tomverse sessions fork <session> [--turn <n>]
                                  Copy the conversation (through turn n; all of it by default) into a new session; no file is touched.
                                  Inside a session: /rewind takes files and conversation back to a turn, /fork [n] copies as above.
  tomverse diff [--session <id>]  Changes this CLI made (and only those)
  tomverse undo <change-id> [--session <id>]
  tomverse doctor [--json]        Checks Node, folder, key and API without a model request
  tomverse trust [folder]         Allow the CLI to work in a folder
  tomverse config show | set <endpoint|model|allow-insecure-localhost|command-env|memory|mcp|hooks|sandbox|sandbox-domains|sandbox-localhost> <value> | unset <key>
  tomverse memory [show|clear]    The notes the agent kept about this folder (clear asks first, or --yes)
${PERMISSIONS_HELP.map((line) => `  ${line}`).join("\n")}
  tomverse mcp [list|approve|enable|disable] [name]   MCP servers (mcp.json in the CLI folder, .mcp.json in the project); a project's server needs your approval at a terminal
  tomverse hooks [list|approve|enable|disable] [n]    Hooks (hooks.json, Claude Code settings.json, the project's .claude/settings.json); a project's hook needs your approval
  tomverse plugin [list|install|update|remove|enable|disable|marketplace] ...   Plugins (skills, commands, agents, hooks, MCP servers in one folder) and the marketplaces they come from; installing needs you at a terminal, and a plugin's hooks and servers need your approval

Options:
  --cwd <folder>            Folder to work in (default: current folder)
  --effort <level>          Reasoning effort for the next task: default, or a level the model offers (\`tomverse models\`)
  --model <id>              Model from \`tomverse models\` (default: config model)
  --read-only               No file changes or commands: the model can only list, search and read
  --limits <profile>        Limits per task: standard (${DEFAULTS.maxRequests} requests, ${DEFAULTS.timeoutMinutes} minutes), extended (200 requests, 120 minutes),
                            unlimited (no request or time limit; stops when you stop it, the API refuses, or the model is done)
  --goal                    After the model says it is done, check the goal and keep going until it is verified
  --max-requests <n>        Model requests per task (default ${DEFAULTS.maxRequests}); overrides --limits
  --timeout <minutes>       Active time per task (default ${DEFAULTS.timeoutMinutes}); overrides --limits
  --command-timeout <s>     Default time limit per command (default ${DEFAULTS.commandTimeoutSeconds})
  --no-persist              Keep the session in memory only (no resume or undo after exit)
  --json                    JSON lines on stdout (exec, models, usage, sessions, doctor)

Key: set TOMVERSE_API_KEY, or type it when asked (it is kept in memory only).
Exit codes: 0 success, 1 error, 2 usage, 3 needs approval, 4 cancelled, 5 limit reached, 6 unknown outcome.`;

class UsageError extends Error {}

const parse = (argv: string[]) =>
    parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            cwd: { type: "string" },
            model: { type: "string" },
            effort: { type: "string" },
            "read-only": { type: "boolean" },
            limits: { type: "string" },
            goal: { type: "boolean" },
            "max-requests": { type: "string" },
            timeout: { type: "string" },
            "command-timeout": { type: "string" },
            "no-persist": { type: "boolean" },
            json: { type: "boolean" },
            session: { type: "string" },
            turn: { type: "string" },
            yes: { type: "boolean" },
            project: { type: "boolean" },
            user: { type: "boolean" },
            exact: { type: "boolean" },
            revoke: { type: "boolean" },
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "v" },
        },
    });

type Flags = ReturnType<typeof parse>["values"];

const parseLimitProfile = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!isLimitProfile(value)) throw new UsageError(`--limits must be one of: ${LIMIT_PROFILES.join(", ")}.`);
    return value;
};

const positiveInt = (value: string | undefined, name: string, fallback: number) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) throw new UsageError(`--${name} must be a positive whole number.`);
    return n;
};

const parseEffort = (value: string | undefined): Effort => {
    if (value === undefined) return "default";
    if (!isEffort(value)) throw new UsageError("Effort must be default or a level the model offers (see `tomverse models`).");
    return value;
};

type Context = { config: CliConfig; output: Output; flags: Flags };

const connect = async (ctx: Context) => {
    const endpoint = resolveEndpoint(ctx.config);
    const key = await readKey();
    return { endpoint, key, gateway: new Gateway(endpoint, key) };
};

const toolModels = (models: CatalogModel[]) => models.filter((m) => m.tools && m.protocols.includes("chat_completions"));

const describeApiError = (error: unknown) => {
    if (!(error instanceof GatewayError)) return (error as Error).message;
    const code = error.extra.code;
    if (code === "invalid_api_key") return "The key was not accepted: it is wrong, expired or revoked. Check Tomverse Settings > API keys.";
    if (code === "account_not_enabled") return "The Tomverse API is not enabled for this account.";
    if (code === "plan_not_eligible") return "The Tomverse API and CLI need a paid plan. Upgrade in Tomverse Settings > Plan.";
    if (code === "feature_unavailable") return "The Tomverse API is switched off on this server.";
    if (code === "key_credit_cap_reached") return "This key has reached the credit limit set for it. Raise the limit in Settings > API keys or use another key.";
    if (code === "rate_limited") return `Too many requests; try again${error.extra.retryAfter ? ` in ${error.extra.retryAfter} s` : " shortly"}.`;
    return `${error.message}${code ? ` (${code})` : ""}`;
};

// ---- doctor -------------------------------------------------------------------

const doctor = async (ctx: Context) => {
    const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
    const add = (name: string, status: "pass" | "warn" | "fail", detail: string) => checks.push({ name, status, detail });
    const major = Number(process.versions.node.split(".")[0]);
    const runtime = isSea() ? " (built into this executable)" : major >= 22 ? "" : " (supported: 22 or later)";
    add("node", major >= 22 ? "pass" : "fail", `Node ${process.versions.node}${runtime}`);
    add("platform", "pass", `${process.platform} ${process.arch}; commands use ${userShell()}`);
    add("git", gitAvailable() ? "pass" : "warn", gitAvailable() ? "git found" : "git not found: file lists use a bounded walk, no .gitignore");
    add("ripgrep", ripgrepAvailable() ? "pass" : "warn", ripgrepAvailable() ? "rg found" : "rg not found: search uses the built-in scanner");
    const home = tomverseHome();
    if (existsSync(home) && process.platform !== "win32") {
        const mode = statSync(home).mode & 0o777;
        add("home", mode & 0o077 ? "warn" : "pass", `${home} mode ${mode.toString(8)}${mode & 0o077 ? " (should be 700)" : ""}`);
    } else add("home", "pass", `${home}${process.platform === "win32" ? " (protected by your Windows profile permissions)" : ""}`);
    try {
        const root = normalizeRoot(ctx.flags.cwd ?? process.cwd());
        const trusted = (ctx.config.trustedRoots ?? []).some((r) => same(r, root));
        add("folder", trusted ? "pass" : "warn", `${root}${trusted ? " (trusted)" : " (not trusted yet: run tomverse trust)"}`);
    } catch (error) {
        add("folder", "warn", (error as Error).message);
    }
    let gateway: Gateway | null = null;
    try {
        const endpoint = resolveEndpoint(ctx.config);
        const moved = endpointMoveNote(endpoint);
        add("endpoint", "pass", moved ? `${endpoint.base} (${moved})` : endpoint.base);
        // Noted before reading: readKey takes the key out of the environment.
        const source = process.env.TOMVERSE_API_KEY?.trim() ? "TOMVERSE_API_KEY" : "terminal input";
        const key = await readKey();
        add("key", "pass", `${maskKey(key)} (from ${source})`);
        gateway = new Gateway(endpoint, key);
    } catch (error) {
        add(error instanceof AuthError ? "key" : "endpoint", "fail", (error as Error).message);
    }
    if (gateway) {
        try {
            const models = toolModels(await gateway.models());
            add("models", models.length ? "pass" : "fail", models.length ? `${models.length} tool-capable models` : "No model with tool calls is offered to this key.");
            const wanted = ctx.flags.model ?? ctx.config.model;
            if (wanted) add("model", models.some((m) => m.id === wanted) ? "pass" : "fail", models.some((m) => m.id === wanted) ? wanted : `${wanted} is not offered to this key now`);
        } catch (error) {
            add("models", "fail", describeApiError(error));
        }
        try {
            const usage = await gateway.usage(1);
            const k = usage.key;
            add(
                "credits",
                "pass",
                k
                    ? `key cap ${k.credit_cap ?? "none"}, committed ${k.committed_credits}, held ${k.held_credits}${k.remaining_cap_credits !== null ? `, ${k.remaining_cap_credits} left under the cap` : ""}${k.expires_at ? `, expires ${k.expires_at}` : ""}`
                    : "no key summary"
            );
        } catch (error) {
            add("credits", "fail", describeApiError(error));
        }
        try {
            const probe = await gateway.requestStatus({ idempotencyKey: `tvcli-doctor-${Date.now()}` });
            add("recovery", probe.found ? "warn" : "pass", "request status lookup is available");
        } catch (error) {
            add("recovery", "warn", `request status lookup unavailable (${describeApiError(error)}); unknown outcomes cannot be checked`);
        }
    }
    if (ctx.output.json) for (const check of checks) ctx.output.event({ type: "check", ...check });
    else for (const check of checks) ctx.output.info(`${check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL"}  ${check.name.padEnd(9)} ${check.detail}`);
    return checks.some((c) => c.status === "fail") ? EXIT_CODES.error : EXIT_CODES.success;
};

// ---- models / usage --------------------------------------------------------------

/**
 * Credits per request as a person should read them. Smart Adaptive's catalogue
 * figure is the most a request can cost; each request is charged as the model
 * that answers it, so it is shown as a range from the cheapest model it can
 * pick (as Settings > API keys shows it).
 */
export const creditsLabel = (model: CatalogModel, catalog: readonly CatalogModel[]) => {
    if (model.id !== SMART_ADAPTIVE) return `${model.creditsPerRequest} credits/request`;
    const others = catalog.filter((m) => m.id !== SMART_ADAPTIVE).map((m) => m.creditsPerRequest);
    const floor = others.length ? Math.min(...others) : model.creditsPerRequest;
    return floor < model.creditsPerRequest ? `${floor}-${model.creditsPerRequest} credits/request` : `${model.creditsPerRequest} credits/request`;
};

const models = async (ctx: Context) => {
    const { gateway } = await connect(ctx);
    const list = toolModels(await gateway.models());
    if (ctx.output.json) {
        for (const m of list) ctx.output.event({ type: "model", ...m });
        return EXIT_CODES.success;
    }
    for (const m of list) {
        process.stdout.write(
            `${safeLine(m.id).padEnd(28)} ${safeLine(m.provider).padEnd(10)} ${creditsLabel(m, list).padStart(20)}  context ${m.contextWindowTokens}  output ${m.maxOutputTokens}${m.reasoningEfforts?.length ? "  effort " + ["default", ...m.reasoningEfforts].join("/") : ""}${m.id === SMART_ADAPTIVE ? "  (picks a model; the session stays on the first one picked and is charged as it)" : ""}\n`
        );
    }
    return EXIT_CODES.success;
};

export const costLine = (cost: Awaited<ReturnType<typeof sessionCost>>) => {
    const open = cost.held > 0 || cost.unknown.length > 0;
    const parts = [`${cost.charged} credits settled`];
    if (cost.held) parts.push(`${cost.held} held (not final)`);
    if (cost.unknown.length) parts.push(`${cost.unknown.length} not found or unknown (#${cost.unknown.join(", #")})`);
    // Never a bare total while part of it is not known.
    return `${cost.requests} model request(s): ${parts.join(", ")}${open ? " -- the total is not final" : ""}.`;
};

const usage = async (ctx: Context) => {
    const { gateway, key } = await connect(ctx);
    if (ctx.flags.session) {
        const journal = openSessionReadOnly(ctx.flags.session);
        if (journal.state.keyPrefix !== keyPrefix(key)) ctx.output.info("This session was run with another key; its requests can only be looked up with that key.");
        const cost = await sessionCost(gateway, journal);
        journal.release();
        if (ctx.output.json) {
            for (const g of journal.state.generations) ctx.output.event({ type: "request", seq: g.seq, purpose: g.purpose, request_id: g.requestId ?? null, state: g.state, lookup: g.lookup ?? null, receipt: g.receipt ?? null, ...(g.appliedEffort ? { applied_effort: g.appliedEffort } : {}) });
            ctx.output.event({ type: "session_cost", session_id: journal.state.id, ...cost });
        } else {
            for (const g of journal.state.generations) {
                const r = g.receipt;
                process.stdout.write(
                    `#${g.seq} ${g.purpose.padEnd(7)} ${(g.requestId ?? "-").padEnd(36)} ${r ? `${r.status}${r.chargedCredits !== null ? ` ${r.chargedCredits} credits` : ` ${r.heldCredits} held`}` : g.lookup === "not_found" ? "not found (not proof of no charge)" : "unknown"}${g.appliedEffort ? " · effort " + g.appliedEffort : ""}\n`
                );
            }
            process.stdout.write(`${costLine(cost)}\nCredits are the server's receipts for this session's own requests; held amounts are not final.\n`);
        }
        return EXIT_CODES.success;
    }
    const report = await gateway.usage(20);
    if (ctx.output.json) {
        ctx.output.event({ type: "key", ...(report.key ?? {}) });
        for (const r of report.requests) ctx.output.event({ type: "receipt", ...r });
        return EXIT_CODES.success;
    }
    const k = report.key;
    if (k) {
        process.stdout.write(
            `Key ${k.prefix} (${safeLine(k.name)}): cap ${k.credit_cap ?? "none"}, committed ${k.committed_credits}, held ${k.held_credits}${k.remaining_cap_credits !== null ? `, ${k.remaining_cap_credits} left under the cap` : ""}\n`
        );
    }
    process.stdout.write("Recent requests of this key (any client):\n");
    for (const r of report.requests) {
        process.stdout.write(`  ${r.createdAt}  ${r.requestId}  ${safeLine(r.modelId)}  ${r.status}  ${r.chargedCredits ?? `${r.heldCredits} held`}\n`);
    }
    return EXIT_CODES.success;
};

// ---- sessions -----------------------------------------------------------------------

const openSessionReadOnly = (id: string) => Journal.open(tomverseHome(), id);

const latestSessionFor = (root: string) => listSessions(tomverseHome()).find((s) => s.readable && same(s.root, root))?.id;

const sessions = async (ctx: Context, args: string[]) => {
    const [sub, id] = args;
    const home = tomverseHome();
    if (sub === "list" || sub === undefined) {
        const list = listSessions(home);
        if (ctx.output.json) for (const s of list) ctx.output.event({ type: "session", ...s });
        else if (!list.length) process.stdout.write(`No sessions in ${sessionsDir(home)}.\n`);
        else for (const s of list) process.stdout.write(`${s.id}  ${s.status.padEnd(15)} ${String(s.requests).padStart(3)} req  ${safeLine(s.model)}  ${safeLine(s.root)}  ${safeLine(s.firstTask)}\n`);
        return EXIT_CODES.success;
    }
    if (sub === "delete") {
        if (!id) throw new UsageError("sessions delete needs a session id.");
        const target = join(sessionsDir(home), id);
        if (!ctx.flags.yes) {
            if (!isInteractive()) throw new UsageError("Deleting needs confirmation: run in a terminal or add --yes.");
            if (!(await terminalPrompter().confirm(`Delete session ${id} and its undo backups at ${target}? This cannot be undone.`))) return EXIT_CODES.cancelled;
        }
        deleteSession(home, id);
        ctx.output.info(`Deleted ${target}.`);
        return EXIT_CODES.success;
    }
    if (sub === "fork") {
        if (!id) throw new UsageError("sessions fork needs a session id.");
        const source = Journal.open(home, id);
        try {
            const { id: forked, turns } = forkThrough(home, source, ctx.flags.turn);
            ctx.output.event({ type: "session_forked", session_id: forked, from: id, turns });
            ctx.output.info(`Forked ${id} (${turns} turn(s)) into ${forked}. No file was touched. Continue it with \`tomverse resume ${forked}\`.`);
        } finally {
            source.release();
        }
        return EXIT_CODES.success;
    }
    throw new UsageError(`Unknown sessions command '${sub}'.`);
};

const diff = async (ctx: Context) => {
    const root = normalizeRoot(ctx.flags.cwd ?? process.cwd());
    const id = ctx.flags.session ?? latestSessionFor(root);
    if (!id) {
        process.stdout.write("No session for this folder.\n");
        return EXIT_CODES.success;
    }
    const journal = openSessionReadOnly(id);
    try {
        const views = viewChanges(journal);
        if (!views.length) process.stdout.write(`Session ${id} changed no files.\n`);
        for (const view of views) {
            const note = { as_written: "as the CLI left it", changed_since: "CHANGED SINCE (undo will refuse)", missing: "MISSING", undone: "undone", not_applied: "not applied", outside: "NO LONGER INSIDE THE WORKSPACE (undo will refuse)" }[view.current];
            process.stdout.write(`\n${view.changeId}  ${view.kind} ${safeLine(view.path)}  [${note}]\n`);
            if (view.state === "applied" || view.state === "undone") {
                try {
                    process.stdout.write(`${renderChange(journal, view)}\n`);
                } catch {
                    process.stdout.write("The recorded diff is unavailable.\n");
                }
            }
        }
        process.stdout.write("\nOnly changes this CLI made are listed; other uncommitted changes in the folder are yours and are not shown.\n");
    } finally {
        journal.release();
    }
    return EXIT_CODES.success;
};

const undo = async (ctx: Context, args: string[]) => {
    const changeId = args[0];
    if (!changeId) throw new UsageError("undo needs a change id from `tomverse diff`.");
    const root = normalizeRoot(ctx.flags.cwd ?? process.cwd());
    const id = ctx.flags.session ?? latestSessionFor(root);
    if (!id) throw new UsageError("No session for this folder; pass --session.");
    const journal = openSessionReadOnly(id);
    try {
        const change = undoChange(journal, changeId);
        ctx.output.info(`Undid ${change.changeId}: ${change.kind} ${change.path}.`);
    } finally {
        journal.release();
    }
    return EXIT_CODES.success;
};

// ---- trust / config -------------------------------------------------------------------

const trust = async (ctx: Context, args: string[]) => {
    const root = normalizeRoot(args[0] ?? ctx.flags.cwd ?? process.cwd());
    const roots = ctx.config.trustedRoots ?? [];
    if (!roots.some((r) => same(r, root))) writeConfig({ ...ctx.config, trustedRoots: [...roots, root] });
    ctx.output.info(`Trusted ${root}. The CLI may read files there and, with your approval for each one, change files and run commands.`);
    return EXIT_CODES.success;
};

const orchestrationFrom = (config: CliConfig) => normalizeOrchestration({ maxSubagents: config.orchestrateMaxSubagents, maxRequests: config.orchestrateMaxRequests });

const configCommand = async (ctx: Context, args: string[]) => {
    const [sub, key, value] = args;
    const config = { ...ctx.config };
    if (sub === "show" || sub === undefined) {
        // Shown even when the stored endpoint is invalid: this is where one looks at it.
        let endpointNote: string;
        try {
            const resolved = resolveEndpoint(config, { ...process.env, TOMVERSE_ENDPOINT: "" });
            const moved = endpointMoveNote(resolved);
            endpointNote = config.endpoint ? (moved ? `${config.endpoint} -- ${moved}` : config.endpoint) : `(default) ${resolved.base}`;
        } catch (error) {
            endpointNote = `${config.endpoint ?? "(default)"} -- invalid: ${(error as Error).message}`;
        }
        process.stdout.write(`${JSON.stringify({ ...config, endpoint: endpointNote }, null, 2)}\n`);
        return EXIT_CODES.success;
    }
    if (sub === "set") {
        if (value === undefined) throw new UsageError("config set needs a key and a value.");
        if (key === "endpoint") {
            resolveEndpoint({ ...config, endpoint: value }, { ...process.env, TOMVERSE_ENDPOINT: "" });
            config.endpoint = value;
        } else if (key === "model") config.model = value;
        else if (key === "allow-insecure-localhost") config.allowInsecureLocalhost = value === "true";
        else if (key === "memory") {
            if (!["true", "false", "on", "off"].includes(value)) throw new UsageError("memory must be on or off.");
            config.memory = value === "true" || value === "on";
        } else if (key === "agent-models") {
            if (!["true", "false", "on", "off"].includes(value)) throw new UsageError("agent-models must be on or off.");
            config.agentModels = value === "true" || value === "on";
        } else if (key === "web-search") {
            if (!["true", "false", "on", "off"].includes(value)) throw new UsageError("web-search must be on or off.");
            config.webSearch = value === "true" || value === "on";
        } else if (key === "orchestrate") {
            if (!["true", "false", "on", "off"].includes(value)) throw new UsageError("orchestrate must be on or off.");
            config.orchestrate = value === "true" || value === "on";
            if (config.orchestrate) process.stdout.write(`Orchestration is on for new sessions: ${describeOrchestration(orchestrationFrom(config))}. Change the numbers with orchestrate-max-subagents and orchestrate-max-requests.\n`);
        } else if (key === "orchestrate-max-subagents" || key === "orchestrate-max-requests") {
            const number = Number(value);
            const bounds = key === "orchestrate-max-subagents" ? ORCHESTRATION_BOUNDS.maxSubagents : ORCHESTRATION_BOUNDS.maxRequests;
            if (!Number.isInteger(number) || number < bounds.min || number > bounds.max) throw new UsageError(`${key} must be a whole number from ${bounds.min} to ${bounds.max}.`);
            if (key === "orchestrate-max-subagents") config.orchestrateMaxSubagents = number;
            else config.orchestrateMaxRequests = number;
        } else if (key === "mcp" || key === "hooks") {
            if (!["true", "false", "on", "off"].includes(value)) throw new UsageError(`${key} must be on or off.`);
            config[key] = value === "true" || value === "on";
        } else if (key === "command-env") config.commandEnv = value.split(",").map((v) => v.trim()).filter((v) => v && !/^TOMVERSE_/i.test(v));
        else if (key === "sandbox") {
            if (!sandboxModes.includes(value as SandboxMode)) throw new UsageError(`sandbox must be one of: ${sandboxModes.join(", ")}.`);
            config.sandbox = value;
        } else if (key === "sandbox-domains") config.sandboxDomains = normalizeAllowedDomains(value.split(","));
        else if (key === "sandbox-localhost") {
            if (!["true", "false", "on", "off"].includes(value)) throw new UsageError("sandbox-localhost must be on or off.");
            config.sandboxLocalhost = value === "true" || value === "on";
        } else throw new UsageError(`Unknown config key '${key}'.`);
        writeConfig(config);
        return EXIT_CODES.success;
    }
    if (sub === "unset") {
        const field = { endpoint: "endpoint", model: "model", "allow-insecure-localhost": "allowInsecureLocalhost", "command-env": "commandEnv", memory: "memory", "agent-models": "agentModels", "web-search": "webSearch", orchestrate: "orchestrate", "orchestrate-max-subagents": "orchestrateMaxSubagents", "orchestrate-max-requests": "orchestrateMaxRequests", mcp: "mcp", hooks: "hooks", sandbox: "sandbox", "sandbox-domains": "sandboxDomains", "sandbox-localhost": "sandboxLocalhost" }[key ?? ""] as keyof CliConfig | undefined;
        if (!field) throw new UsageError(`Unknown config key '${key}'.`);
        delete config[field];
        writeConfig(config);
        return EXIT_CODES.success;
    }
    throw new UsageError(`Unknown config command '${sub}'.`);
};

// ---- sessions that talk to the model -----------------------------------------------------

const ensureTrusted = async (ctx: Context, root: string, prompter: Prompter | null) => {
    if ((ctx.config.trustedRoots ?? []).some((r) => same(r, root))) return true;
    if (!prompter) {
        ctx.output.info(`${root} is not a trusted folder yet. Run \`tomverse trust\` there, or start \`tomverse\` interactively.`);
        return false;
    }
    if (!(await prompter.confirm(`Work in ${root}? The CLI will read files here and send what the model needs to Tomverse; changes and commands still ask each time.`))) return false;
    const roots = ctx.config.trustedRoots ?? [];
    ctx.config.trustedRoots = [...roots, root];
    writeConfig(ctx.config);
    return true;
};

const pickModel = async (ctx: Context, catalog: CatalogModel[], prompter: Prompter | null) => {
    const wanted = ctx.flags.model ?? ctx.config.model;
    if (wanted) {
        const entry = catalog.find((m) => m.id === wanted);
        if (!entry) throw new UsageError(`${wanted} is not offered to this key now. See \`tomverse models\`.`);
        return entry;
    }
    if (!prompter) throw new UsageError("Choose a model with --model or `tomverse config set model <id>` (see `tomverse models`).");
    catalog.forEach((m, i) => process.stderr.write(`  ${String(i + 1).padStart(2)}. ${safeLine(m.id)} (${safeLine(m.provider)}, ${creditsLabel(m, catalog)})\n`));
    const answer = await askLine("Model number: ");
    const entry = catalog[Number(answer) - 1];
    if (!entry) throw new UsageError("No model chosen.");
    writeConfig({ ...ctx.config, model: entry.id });
    ctx.output.info(`Saved ${entry.id} as your default model (change it with tomverse config set model <id>).`);
    return entry;
};

const exitFor = (outcome: Outcome) => EXIT_CODES[outcome];

/** The operating-system sandbox the config asks for, started for this working folder; null when it is off. One that cannot be built still comes back: it refuses every command. */
const startSandbox = async (ctx: Context, root: string): Promise<SandboxRuntime | null> => {
    const settings = normalizeSandboxSettings({ mode: ctx.config.sandbox, allowedDomains: ctx.config.sandboxDomains, allowLocalhost: ctx.config.sandboxLocalhost });
    const runtime = await createSandboxRuntime({ settings, workspaceRoot: root, stateDir: join(tomverseHome(), "sandbox") });
    if (!runtime) return null;
    const { enforcement } = runtime;
    ctx.output.info(enforcement.available
        ? `Sandbox ${settings.mode}: writes ${enforcement.writes === "os" ? "limited by the operating system" : "not limited"}, network ${enforcement.network}.`
        : `Sandbox ${settings.mode} cannot be created here (${enforcement.detail}); commands are refused until it is changed with: tomverse config set sandbox off`);
    return runtime;
};

/** The notes kept about a folder, in the CLI's own home next to the sessions. */
const projectMemory = (ctx: Context, root: string) => new ProjectMemory(memoryFileFor(join(tomverseHome(), "memory"), root), root);

/** `/name args` of a skill or command from the project or the user's own folders, as the prompt it stands for. Other text comes back as it is; null when the file cannot be read. */
const withSlashPrompt = (ctx: Context, root: string, text: string): string | null => {
    if (!text.startsWith("/")) return text;
    try {
        const invocation = expandInvocation(root, discoverExtensions(root), text);
        if (!invocation) return text;
        ctx.output.info(`Running ${invocation.kind} /${invocation.name} (${invocation.source})${invocation.ignored.length ? `; not applied: ${invocation.ignored.join(", ")}` : ""}.`);
        return invocation.prompt;
    } catch (error) {
        if (!(error instanceof ExtensionError)) throw error;
        ctx.output.info(error.message);
        return null;
    }
};

/** What a session in a terminal gets besides the basics: reading approved web pages, subfolder instructions, skills and agent definitions, and project memory unless it is turned off. */
const engineExtras = (ctx: Context, root: string) => ({
    extensions: discoverExtensions(root),
    agentModels: ctx.config.agentModels === true,
    web: {},
    // Off unless the person turned it on (tomverse config set web-search on): each search is charged to the account.
    webSearch: ctx.config.webSearch === true,
    backgroundCommands: true,
    images: true,
    subagents: true,
    nestedInstructions: true,
    ...(ctx.config.memory === false ? {} : { memory: projectMemory(ctx, root) }),
    // The permission rules (tomverse permissions): deny rules refuse, ask rules always ask, allow rules skip the question.
    permissions: new PermissionGate({ mode: "ask", rules: () => new PermissionRuleStore({ root }).effective(), protectedDirs: [tomverseHome()] }),
});

/** The MCP servers and hooks of this folder and the user (extensions.ts), unless turned off in the config. Reports what is waiting for approval. */
const localExtensions = async (ctx: Context, root: string, sessionId: () => string, readOnly: boolean) => {
    if (ctx.config.mcp === false && ctx.config.hooks === false) return null;
    const setup = await startLocalExtensions({ root, sessionId, connectServers: !readOnly && ctx.config.mcp !== false });
    for (const problem of setup.problems) ctx.output.info(`note: ${safeLine(problem)}`);
    for (const server of setup.mcp.status()) {
        if (server.state === "pending_approval") ctx.output.info(`MCP server ${safeLine(server.id)} (from this project) is waiting for your approval: tomverse mcp approve ${safeLine(server.id)}`);
        else if (server.state === "failed" || server.state === "needs_auth") ctx.output.info(`MCP server ${safeLine(server.id)}: ${safeLine(server.detail ?? server.state)}`);
    }
    return { close: setup.close, options: {
        ...(ctx.config.mcp === false ? {} : { mcp: setup.mcp }),
        ...(ctx.config.hooks === false ? {} : { lifecycleHooks: setup.hooks }),
    } };
};

const memoryCommand = async (ctx: Context, args: string[]) => {
    const [sub] = args;
    const root = normalizeRoot(ctx.flags.cwd ?? process.cwd());
    const memory = projectMemory(ctx, root);
    if (sub === "show" || sub === undefined) {
        const entries = memory.list();
        const lines = entries.length ? entries.map((entry) => `${entry.id}  ${safeLine(entry.text)}`) : ["Nothing is remembered for this folder."];
        if (ctx.config.memory === false) lines.push("Memory is off (tomverse config set memory true turns it on); nothing is read or written.");
        process.stdout.write(`${lines.join("\n")}\n`);
        return EXIT_CODES.success;
    }
    if (sub === "clear") {
        if (!ctx.flags.yes) {
            if (!isInteractive()) throw new UsageError("Deleting the notes needs confirmation: run in a terminal or add --yes.");
            if (!(await terminalPrompter().confirm(`Delete everything remembered for ${root}?`))) return EXIT_CODES.cancelled;
        }
        memory.clear();
        ctx.output.info("Deleted the notes kept for this folder.");
        return EXIT_CODES.success;
    }
    throw new UsageError(`Unknown memory command '${sub}'.`);
};

const installSigint = (runner: Runner, output: Output) => {
    // A second Ctrl+C within a few seconds of the first quits; a later one is a
    // new cancel. Quitting still gives the first cancel's process-tree cleanup
    // a moment to finish, so a running command is not left behind.
    let firstAt = 0;
    const handler = () => {
        const now = Date.now();
        if (firstAt && now - firstAt < 3000) {
            output.info("Stopping now.");
            runner.cancel();
            setTimeout(() => {
                runner.journal.release();
                process.exit(EXIT_CODES.cancelled);
            }, 2000).unref();
            return;
        }
        firstAt = now;
        output.info("\nCancelling (press Ctrl+C again to quit)...");
        runner.cancel();
    };
    process.on("SIGINT", handler);
    return () => process.off("SIGINT", handler);
};

const finalEvent = async (ctx: Context, runner: Runner, gateway: Gateway, outcome: Outcome) => {
    const cost = await sessionCost(gateway, runner.journal);
    ctx.output.event({ type: "final", status: outcome, exit_code: exitFor(outcome), session_id: runner.journal.state.id, persisted: runner.journal.persisted, cost });
    if (!ctx.output.json) ctx.output.info(`[${outcome}] session ${runner.journal.state.id}. ${costLine(cost)}`);
};

const startSession = async (ctx: Context, task: string | null, interactive: boolean) => {
    const prompter = interactive ? terminalPrompter() : null;
    const root = normalizeRoot(ctx.flags.cwd ?? process.cwd());
    if (!(await ensureTrusted(ctx, root, prompter))) return EXIT_CODES.needs_approval;
    const { endpoint, key, gateway } = await connect(ctx);
    const catalog = toolModels(await gateway.models());
    const model = await pickModel(ctx, catalog, prompter);
    const persist = !ctx.flags["no-persist"];
    let home: string | null = null;
    if (persist) {
        const before = existsSync(sessionsDir(tomverseHome()));
        home = ensureHome().home;
        if (!before) {
            ctx.output.info(
                `Sessions are saved in ${sessionsDir(home)}, readable only by you: the conversation (including file contents and command output the model saw), request ids, approvals, and the earlier content of files the CLI changes (for undo). Your API key is never saved, and nothing is uploaded. Use --no-persist to keep a session in memory only; delete one with tomverse sessions delete.`
            );
        }
    }
    const journal = createSession(home, {
        root, endpoint, keyPrefix: keyPrefix(key), readOnly: Boolean(ctx.flags["read-only"]), model,
        limits: resolveLimits(parseLimitProfile(ctx.flags.limits), {
            ...(ctx.flags["max-requests"] !== undefined ? { maxRequests: positiveInt(ctx.flags["max-requests"], "max-requests", DEFAULTS.maxRequests) } : {}),
            ...(ctx.flags.timeout !== undefined ? { timeoutMs: positiveInt(ctx.flags.timeout, "timeout", DEFAULTS.timeoutMinutes) * 60_000 } : {}),
            commandTimeoutMs: positiveInt(ctx.flags["command-timeout"], "command-timeout", DEFAULTS.commandTimeoutSeconds) * 1000,
        }),
        ...(ctx.flags.goal ? { goal: { maxContinuations: GOAL_MAX_CONTINUATIONS } } : {}),
        ...(ctx.config.orchestrate === true ? { orchestrate: orchestrationFrom(ctx.config) } : {}),
    });
    if (journal.state.orchestrate) ctx.output.info(`Orchestration: ${describeOrchestration(journal.state.orchestrate)}. Subtasks run in parallel with their own write scopes, are verified, and share these requests with the task's own limit.`);
    if (journal.state.limits.profile === "unlimited") ctx.output.info("Limits: unlimited. A task stops when you stop it, the API refuses a request, or the model is done.");
    if (journal.state.goal) ctx.output.info(`Goal mode: after the model is done, the goal is checked and the task continues until it is verified (at most ${journal.state.goal.maxContinuations} automatic continuations in a row).`);
    if (!persist) ctx.output.info("--no-persist: this session lives in memory only; it cannot be resumed and its changes cannot be undone after exit.");
    const workspace = new Workspace(root);
    const extensions = await localExtensions(ctx, workspace.root, () => journal.state.id, journal.state.readOnly);
    const sandbox = await startSandbox(ctx, workspace.root);
    const runner = new Runner({ gateway, journal, workspace, output: ctx.output, prompter, catalog, commandEnv: ctx.config.commandEnv ?? [], instructions: readInstructions(workspace), ...engineExtras(ctx, workspace.root), ...extensions?.options, ...(sandbox ? { launchCommand: sandbox.launch, sandboxed: sandbox.enforcement.available } : {}) });
    ctx.output.event({ type: "session", session_id: journal.state.id, root, model: model.id, read_only: journal.state.readOnly, persisted: journal.persisted });
    if (!ctx.output.json) ctx.output.info(`Session ${journal.state.id} in ${root} with ${model.id}${journal.state.readOnly ? " (read-only)" : ""}.`);
    const removeSigint = installSigint(runner, ctx.output);
    try {
        let outcome: Outcome = "success";
        const first = task ? withSlashPrompt(ctx, root, task) : null;
        if (task && first !== null) {
            outcome = await runner.runTask(first, parseEffort(ctx.flags.effort));
            await finalEvent(ctx, runner, gateway, outcome);
        }
        if (interactive) outcome = await repl(ctx, runner, gateway, outcome, prompter?.memory ?? null, task ? "default" : parseEffort(ctx.flags.effort));
        return exitFor(outcome);
    } finally {
        removeSigint();
        await extensions?.close();
        journal.release();
        await sandbox?.close();
    }
};

const repl = async (ctx: Context, runner: Runner, gateway: Gateway, initial: Outcome = "success", memory: ApprovalMemory | null = null, effort: Effort = "default"): Promise<Outcome> => {
    // The exit code is the last task's outcome, so `tomverse && …` never goes on after one that failed.
    let last: Outcome = initial;
    ctx.output.info("Type a task, or /help. Ctrl+D or /exit to leave.");
    for (;;) {
        const line = await askLine("tomverse> ");
        if (line === null || line.trim() === "/exit") return last;
        const text = line.trim();
        if (!text) continue;
        if (text === "/help") {
            ctx.output.info("/diff  changes this session made   /usage  credits of this session   /compact  summarise history now   /rewind  take files and conversation back to a turn   /fork [turn]  copy the conversation into a new session   /model  current model   /effort [level]  next task   /approvals [clear]  what is allowed without asking   /skills  skills, commands and agents found   /<name> [arguments]  run a skill or command   /exit");
            continue;
        }
        if (text === "/skills") {
            const lines = describeRegistry(discoverExtensions(runner.journal.state.workspace.root));
            ctx.output.info(lines.length ? lines.map((line) => safeLine(line)).join("\n") : "No skills, commands or agent definitions found (.claude/, .agents/, .codex/ in this folder or your home).");
            continue;
        }
        if (text === "/diff") {
            for (const view of viewChanges(runner.journal)) ctx.output.info(`${view.changeId} ${view.kind} ${view.path} [${view.current}]`);
            continue;
        }
        if (text === "/usage") {
            ctx.output.info(costLine(await sessionCost(gateway, runner.journal)));
            continue;
        }
        if (text === "/model") {
            const m = runner.journal.state.model;
            ctx.output.info(`${m.pinned ?? m.requested}${m.pinnedFrom === "smart_adaptive_first_response" ? " (picked by Smart Adaptive, kept for this session)" : ""}. To use another model, start a new session with --model.`);
            continue;
        }
        if (text === "/effort" || text.startsWith("/effort ")) {
            try {
                const next = text === "/effort" ? effort : parseEffort(text.slice("/effort ".length).trim());
                runner.assertEffort(next);
                effort = next;
                ctx.output.info("Next task reasoning effort: " + effort + ".");
            } catch (error) {
                ctx.output.info((error as Error).message);
            }
            continue;
        }
        if (text === "/approvals" || text === "/approvals clear") {
            if (text === "/approvals clear") {
                memory?.clear();
                ctx.output.info("Every action is asked again from now on.");
            } else {
                const rules = memory?.describe() ?? [];
                if (!rules.length) ctx.output.info("Nothing is allowed without asking: every change and command is asked.");
                else {
                    ctx.output.info("Allowed without asking for the rest of this run (not saved; a resumed session asks again):");
                    for (const rule of rules) ctx.output.info(`  - ${safeLine(rule)}`);
                }
            }
            continue;
        }
        if (text === "/compact") {
            await runner.maybeCompact(true);
            continue;
        }
        if (text === "/rewind") {
            await rewindDialog(runner.journal, { ask: askLine, say: (line) => ctx.output.info(line) }, () => runner.historyChanged());
            continue;
        }
        if (text === "/fork" || text.startsWith("/fork ")) {
            try {
                if (!runner.journal.persisted) throw new RewindError("A session kept in memory only (--no-persist) cannot be forked.");
                const { id: forked, turns } = forkThrough(tomverseHome(), runner.journal, text.slice("/fork".length).trim() || undefined);
                ctx.output.info(`Forked this session (${turns} turn(s)) into ${forked}. No file was touched, and this session goes on as it was. Continue the copy with \`tomverse resume ${forked}\`.`);
            } catch (error) {
                if (!(error instanceof RewindError)) throw error;
                ctx.output.info(error.message);
            }
            continue;
        }
        try {
            runner.assertEffort(effort);
        } catch (error) {
            ctx.output.info((error as Error).message);
            continue;
        }
        const prompt = withSlashPrompt(ctx, runner.journal.state.workspace.root, text);
        if (prompt === null) continue;
        last = await runner.runTask(prompt, effort);
        effort = "default";
        await finalEvent(ctx, runner, gateway, last);
    }
};

const resume = async (ctx: Context, args: string[], interactive: boolean) => {
    const [id, ...rest] = args;
    if (!id) throw new UsageError("resume needs a session id (see `tomverse sessions list`).");
    if (ctx.flags.effort !== undefined) throw new UsageError("Resume keeps the saved task effort. Use /effort for the next task.");
    if (ctx.flags.limits !== undefined || ctx.flags.goal) throw new UsageError("Resume keeps the saved limits and goal mode. Use --max-requests to allow more requests for the saved task.");
    const prompter = interactive ? terminalPrompter() : null;
    const journal = Journal.open(tomverseHome(), id);
    try {
        const state = journal.state;
        const { endpoint, key, gateway } = await connect(ctx);
        // Reject a different endpoint/key before even fetching that key's catalog.
        let root: string;
        try { root = validateSession(journal, endpoint, keyPrefix(key)); }
        catch (error) { throw new UsageError((error as Error).message); }
        const catalog = toolModels(await gateway.models());
        try { validateSession(journal, endpoint, keyPrefix(key), catalog); }
        catch (error) { throw new UsageError((error as Error).message); }
        const modelId = state.model.pinned ?? state.model.requested;
        if (ctx.flags["max-requests"]) {
            const task = state.tasks.at(-1);
            if (task) task.allowance = Math.max(task.allowance, task.requests + positiveInt(ctx.flags["max-requests"], "max-requests", DEFAULTS.maxRequests));
        }
        const workspace = new Workspace(root);
        const extensions = await localExtensions(ctx, workspace.root, () => state.id, state.readOnly);
        const sandbox = await startSandbox(ctx, workspace.root);
        const runner = new Runner({ gateway, journal, workspace, output: ctx.output, prompter, catalog, commandEnv: ctx.config.commandEnv ?? [], instructions: readInstructions(workspace), ...engineExtras(ctx, workspace.root), ...extensions?.options, ...(sandbox ? { launchCommand: sandbox.launch, sandboxed: sandbox.enforcement.available } : {}) });
        ctx.output.event({ type: "session", session_id: state.id, root, model: modelId, read_only: state.readOnly, persisted: true, resumed: true });
        const notes = reconcile(journal);
        for (const note of notes) ctx.output.info(note);
        // Requests whose end was not seen: look them up, never send them again on our own.
        const unresolved = journal.unresolvedGenerations();
        for (const record of unresolved) {
            await runner.lookUp(record);
            ctx.output.info(runner.unknownReport(record));
        }
        const wasMidTask = ["running", "needs_approval", "unknown_outcome", "limit_reached", "cancelled", "error"].includes(state.status);
        const removeSigint = installSigint(runner, ctx.output);
        try {
            let outcome: Outcome = "success";
            if (state.pendingApprovals.length) {
                const answered = await runner.answerApprovals(state.pendingApprovals);
                if (answered === "needs_approval") {
                    outcome = "needs_approval";
                    await finalEvent(ctx, runner, gateway, outcome);
                    return exitFor(outcome);
                }
            }
            const task = rest.join(" ").trim();
            if (unresolved.length || notes.length) {
                // Only an explicit yes at the terminal goes past an unknown outcome;
                // a task on the command line is not one.
                const continueIt = prompter ? await prompter.confirm("Continue? The next step is a new model request.") : false;
                if (!continueIt) {
                    if (!prompter) ctx.output.info("Run `tomverse resume` in a terminal to decide how to go on.");
                    outcome = unresolved.length ? "unknown_outcome" : "needs_approval";
                    await finalEvent(ctx, runner, gateway, outcome);
                    return exitFor(outcome);
                }
                // The user has seen what is unknown and chose to go on: those requests are closed.
                journal.closeGenerations(unresolved);
                if (notes.length) journal.state.messages.push({ role: "user", content: `[Tomverse CLI] The previous run stopped unexpectedly. ${notes.join(" ")}` });
                journal.commit();
            }
            if (task) outcome = await runner.runTask(task);
            else if (wasMidTask && state.tasks.length) outcome = await runner.loop();
            if (task || (wasMidTask && state.tasks.length)) await finalEvent(ctx, runner, gateway, outcome);
            if (interactive) outcome = await repl(ctx, runner, gateway, outcome, prompter?.memory ?? null);
            return exitFor(outcome);
        } finally {
            removeSigint();
            await extensions?.close();
            await sandbox?.close();
        }
    } finally {
        journal.release();
    }
};

// ---- main -------------------------------------------------------------------------------

export const main = async (argv: string[]): Promise<number> => {
    let parsed: ReturnType<typeof parse>;
    try {
        parsed = parse(argv);
    } catch (error) {
        process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`);
        return EXIT_CODES.usage;
    }
    const { values: flags, positionals } = parsed;
    if (flags.version) {
        process.stdout.write(`${CLI_VERSION}\n`);
        return EXIT_CODES.success;
    }
    if (flags.help) {
        process.stdout.write(`${HELP}\n`);
        return EXIT_CODES.success;
    }
    const [command, ...args] = positionals;
    const output = createOutput(Boolean(flags.json));
    try {
        const ctx: Context = { config: readConfig(), output, flags };
        switch (command) {
            case "doctor":
                return await doctor(ctx);
            case "models":
                return await models(ctx);
            case "usage":
                return await usage(ctx);
            case "sessions":
                return await sessions(ctx, args);
            case "diff":
                return await diff(ctx);
            case "undo":
                return await undo(ctx, args);
            case "trust":
                return await trust(ctx, args);
            case "config":
                return await configCommand(ctx, args);
            case "memory":
                return await memoryCommand(ctx, args);
            case "permissions":
                return await permissionsCommand(args, normalizeRoot(flags.cwd ?? process.cwd()), flags, {
                    write: (text) => void process.stdout.write(text), interactive: isInteractive(), confirm: (question) => terminalPrompter().confirm(question),
                });
            case "mcp":
            case "hooks": {
                const done = await extensionsCommand(command, args, normalizeRoot(flags.cwd ?? process.cwd()), { interactive: isInteractive(), confirm: (q) => terminalPrompter().confirm(q) });
                process.stdout.write(`${done.lines.join("\n")}\n`);
                return done.ok ? EXIT_CODES.success : EXIT_CODES.error;
            }
            case "plugin": {
                const root = normalizeRoot(flags.cwd ?? process.cwd());
                const done = await pluginCommand(args, { interactive: isInteractive(), confirm: (q) => terminalPrompter().confirm(q), root });
                process.stdout.write(`${done.lines.join("\n")}\n`);
                return done.ok ? EXIT_CODES.success : EXIT_CODES.error;
            }
            case "resume":
                return await resume(ctx, args, !flags.json && isInteractive());
            case "exec": {
                const task = args.join(" ").trim();
                if (!task) throw new UsageError("exec needs a task.");
                return await startSession(ctx, task, false);
            }
            case "help":
                process.stdout.write(`${HELP}\n`);
                return EXIT_CODES.success;
            default: {
                if (flags.json) throw new UsageError("--json is for exec, models, usage, sessions and doctor.");
                if (!isInteractive()) throw new UsageError("Not a terminal: use `tomverse exec <task>` for a non-interactive run.");
                const task = positionals.join(" ").trim() || null;
                return await startSession(ctx, task, true);
            }
        }
    } catch (error) {
        const known =
            error instanceof UsageError ||
            error instanceof PermissionsUsageError ||
            error instanceof ConfigError ||
            error instanceof AuthError ||
            error instanceof PathError ||
            error instanceof JournalError ||
            error instanceof SessionLockedError ||
            error instanceof UndoError ||
            error instanceof RewindError ||
            error instanceof GatewayError;
        const message = error instanceof GatewayError ? describeApiError(error) : (error as Error).message;
        output.event({ type: "error", code: error instanceof GatewayError ? (error.extra.code ?? error.kind) : (error as Error).constructor.name, message });
        output.info(known ? message : `Unexpected error: ${message}`);
        return error instanceof UsageError || error instanceof PermissionsUsageError ? EXIT_CODES.usage : EXIT_CODES.error;
    }
};
