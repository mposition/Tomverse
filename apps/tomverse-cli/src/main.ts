import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EXIT_CODES, Runner, SMART_ADAPTIVE, type Outcome, type Prompter } from "./agent.js";
import { AuthError, keyPrefix, maskKey, readKey } from "./auth.js";
import type { ApprovalMemory } from "./approvals.js";
import { UndoError, renderChange, undoChange, viewChanges } from "./changes.js";
import { userShell } from "./commands.js";
import { ConfigError, ensureHome, readConfig, resolveEndpoint, tomverseHome, writeConfig, type CliConfig } from "./config.js";
import { createOutput, safeLine, type Output } from "./display.js";
import { Gateway, GatewayError, type CatalogModel, type Receipt } from "./gateway.js";
import { askLine, isInteractive, terminalPrompter } from "./interactive.js";
import { deleteSession, Journal, JournalError, listSessions, SessionLockedError, sessionsDir } from "./session.js";
import { CLI_VERSION } from "./version.js";
import { gitAvailable, normalizeRoot, PathError, ripgrepAvailable, same, Workspace } from "./workspace.js";

export const DEFAULTS = { maxRequests: 20, timeoutMinutes: 15, commandTimeoutSeconds: 120 } as const;

const HELP = `tomverse ${CLI_VERSION} -- a coding agent for your own folder, on your Tomverse API key.

Usage:
  tomverse [task]                 Interactive session in the current folder
  tomverse exec <task> [--json]   Run one task without prompts; stops at the first approval
  tomverse resume <session> [task]
  tomverse models [--json]        Models this key can use, with credits per request
  tomverse usage [--session <id>] [--json]
  tomverse sessions list [--json] | sessions delete <session> [--yes]
  tomverse diff [--session <id>]  Changes this CLI made (and only those)
  tomverse undo <change-id> [--session <id>]
  tomverse doctor [--json]        Checks Node, folder, key and API without a model request
  tomverse trust [folder]         Allow the CLI to work in a folder
  tomverse config show | set <endpoint|model|allow-insecure-localhost|command-env> <value> | unset <key>

Options:
  --cwd <folder>            Folder to work in (default: current folder)
  --model <id>              Model from \`tomverse models\` (default: config model)
  --read-only               No file changes or commands: the model can only list, search and read
  --max-requests <n>        Model requests per task (default ${DEFAULTS.maxRequests})
  --timeout <minutes>       Active time per task (default ${DEFAULTS.timeoutMinutes})
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
            "read-only": { type: "boolean" },
            "max-requests": { type: "string" },
            timeout: { type: "string" },
            "command-timeout": { type: "string" },
            "no-persist": { type: "boolean" },
            json: { type: "boolean" },
            session: { type: "string" },
            yes: { type: "boolean" },
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "v" },
        },
    });

type Flags = ReturnType<typeof parse>["values"];

const positiveInt = (value: string | undefined, name: string, fallback: number) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) throw new UsageError(`--${name} must be a positive whole number.`);
    return n;
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
    add("node", major === 22 ? "pass" : "warn", `Node ${process.versions.node}${major === 22 ? "" : " (supported: 22.x)"}`);
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
        add("endpoint", "pass", endpoint.base);
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

const models = async (ctx: Context) => {
    const { gateway } = await connect(ctx);
    const list = toolModels(await gateway.models());
    if (ctx.output.json) {
        for (const m of list) ctx.output.event({ type: "model", ...m });
        return EXIT_CODES.success;
    }
    for (const m of list) {
        process.stdout.write(
            `${safeLine(m.id).padEnd(28)} ${safeLine(m.provider).padEnd(10)} ${String(m.creditsPerRequest).padStart(4)} credits/request  context ${m.contextWindowTokens}  output ${m.maxOutputTokens}${m.id === SMART_ADAPTIVE ? "  (picks a model; the session stays on the first one picked)" : ""}\n`
        );
    }
    return EXIT_CODES.success;
};

/** This session's own receipts, summed. Never the key's total before and after. */
export const sessionCost = async (gateway: Gateway, journal: Journal) => {
    const generations = journal.state.generations;
    const byId = new Map<string, Receipt>();
    try {
        for (const receipt of (await gateway.usage(100)).requests) byId.set(receipt.requestId, receipt);
    } catch {
        // fall back to one lookup per request below
    }
    // Another key cannot see this session's requests; nothing it answers is recorded.
    if (gateway.keyPrefix !== journal.state.keyPrefix) {
        const unknown = generations.filter((g) => !(g.receipt && g.receipt.status !== "held")).map((g) => g.seq);
        const charged = generations.reduce((sum, g) => sum + (g.receipt && g.receipt.status !== "held" && typeof g.receipt.chargedCredits === "number" ? g.receipt.chargedCredits : 0), 0);
        return { requests: generations.length, charged, held: 0, unknown };
    }
    // Every receipt /usage returned is applied first, whatever its position.
    for (const g of generations) {
        if (g.requestId && byId.has(g.requestId)) {
            g.receipt = byId.get(g.requestId)!;
            g.lookup = "found";
        }
    }
    // Then single lookups for what is still open, the least recently checked
    // first, so repeated runs reach every request rather than the same 40.
    const open = generations
        .filter((g) => !(g.receipt && g.receipt.status !== "held") && !(g.requestId && byId.has(g.requestId)))
        .sort((x, y) => (x.lookupAt ?? "").localeCompare(y.lookupAt ?? ""))
        .slice(0, 40);
    for (const g of open) {
        try {
            const found = await gateway.requestStatus(g.requestId ? { requestId: g.requestId } : { idempotencyKey: g.idempotencyKey });
            g.lookup = found.found ? "found" : "not_found";
            g.receipt = found.found ? found.receipt : null;
            if (found.found) g.requestId = found.receipt.requestId;
        } catch {
            // left as it was: unknown
        }
        g.lookupAt = new Date().toISOString();
    }
    try {
        journal.commit();
    } catch {
        // the totals below are still right for this process
    }
    let charged = 0;
    let held = 0;
    const unknown: number[] = [];
    for (const g of generations) {
        if (g.receipt && g.receipt.status !== "held" && typeof g.receipt.chargedCredits === "number") charged += g.receipt.chargedCredits;
        else if (g.receipt?.status === "held") held += g.receipt.heldCredits;
        else unknown.push(g.seq);
    }
    return { requests: generations.length, charged, held, unknown };
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
            for (const g of journal.state.generations) ctx.output.event({ type: "request", seq: g.seq, purpose: g.purpose, request_id: g.requestId ?? null, state: g.state, lookup: g.lookup ?? null, receipt: g.receipt ?? null });
            ctx.output.event({ type: "session_cost", session_id: journal.state.id, ...cost });
        } else {
            for (const g of journal.state.generations) {
                const r = g.receipt;
                process.stdout.write(
                    `#${g.seq} ${g.purpose.padEnd(7)} ${(g.requestId ?? "-").padEnd(36)} ${r ? `${r.status}${r.chargedCredits !== null ? ` ${r.chargedCredits} credits` : ` ${r.heldCredits} held`}` : g.lookup === "not_found" ? "not found (not proof of no charge)" : "unknown"}\n`
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
            if (view.current === "as_written" || view.current === "changed_since") process.stdout.write(`${renderChange(journal, view)}\n`);
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

const configCommand = async (ctx: Context, args: string[]) => {
    const [sub, key, value] = args;
    const config = { ...ctx.config };
    if (sub === "show" || sub === undefined) {
        // Shown even when the stored endpoint is invalid: this is where one looks at it.
        let endpointNote: string;
        try {
            endpointNote = config.endpoint ?? `(default) ${resolveEndpoint(config).base}`;
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
        else if (key === "command-env") config.commandEnv = value.split(",").map((v) => v.trim()).filter((v) => v && !/^TOMVERSE_/i.test(v));
        else throw new UsageError(`Unknown config key '${key}'.`);
        writeConfig(config);
        return EXIT_CODES.success;
    }
    if (sub === "unset") {
        const field = { endpoint: "endpoint", model: "model", "allow-insecure-localhost": "allowInsecureLocalhost", "command-env": "commandEnv" }[key ?? ""] as keyof CliConfig | undefined;
        if (!field) throw new UsageError(`Unknown config key '${key}'.`);
        delete config[field];
        writeConfig(config);
        return EXIT_CODES.success;
    }
    throw new UsageError(`Unknown config command '${sub}'.`);
};

// ---- sessions that talk to the model -----------------------------------------------------

export const readInstructions = (workspace: Workspace) => {
    // Through the same real-path check as every read: an AGENTS.md that is a
    // link out of the folder is not sent.
    let path: string;
    try {
        const resolved = workspace.resolve("AGENTS.md", "read");
        if (!resolved.exists || !statSync(resolved.absolute).isFile()) return null;
        path = resolved.absolute;
    } catch {
        return null;
    }
    const text = readFileSync(path, "utf8");
    return text.length > 32_000 ? `${text.slice(0, 32_000)}\n[AGENTS.md continues; read the file for the rest]` : text;
};

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
    catalog.forEach((m, i) => process.stderr.write(`  ${String(i + 1).padStart(2)}. ${safeLine(m.id)} (${safeLine(m.provider)}, ${m.creditsPerRequest} credits/request)\n`));
    const answer = await askLine("Model number: ");
    const entry = catalog[Number(answer) - 1];
    if (!entry) throw new UsageError("No model chosen.");
    writeConfig({ ...ctx.config, model: entry.id });
    ctx.output.info(`Saved ${entry.id} as your default model (change it with tomverse config set model <id>).`);
    return entry;
};

const exitFor = (outcome: Outcome) => EXIT_CODES[outcome];

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
    const journal = Journal.create(home, {
        workspace: { root },
        endpointOrigin: endpoint.origin,
        keyPrefix: keyPrefix(key),
        readOnly: Boolean(ctx.flags["read-only"]),
        model: {
            requested: model.id,
            pinned: model.id === SMART_ADAPTIVE ? null : model.id,
            pinnedFrom: model.id === SMART_ADAPTIVE ? null : "user",
            contextWindowTokens: model.contextWindowTokens,
            maxOutputTokens: model.maxOutputTokens,
        },
        limits: {
            maxRequests: positiveInt(ctx.flags["max-requests"], "max-requests", DEFAULTS.maxRequests),
            timeoutMs: positiveInt(ctx.flags.timeout, "timeout", DEFAULTS.timeoutMinutes) * 60_000,
            commandTimeoutMs: positiveInt(ctx.flags["command-timeout"], "command-timeout", DEFAULTS.commandTimeoutSeconds) * 1000,
        },
    });
    if (!persist) ctx.output.info("--no-persist: this session lives in memory only; it cannot be resumed and its changes cannot be undone after exit.");
    const workspace = new Workspace(root);
    const runner = new Runner({ gateway, journal, workspace, output: ctx.output, prompter, catalog, commandEnv: ctx.config.commandEnv ?? [], instructions: readInstructions(workspace) });
    ctx.output.event({ type: "session", session_id: journal.state.id, root, model: model.id, read_only: journal.state.readOnly, persisted: journal.persisted });
    if (!ctx.output.json) ctx.output.info(`Session ${journal.state.id} in ${root} with ${model.id}${journal.state.readOnly ? " (read-only)" : ""}.`);
    const removeSigint = installSigint(runner, ctx.output);
    try {
        let outcome: Outcome = "success";
        if (task) {
            outcome = await runner.runTask(task);
            await finalEvent(ctx, runner, gateway, outcome);
        }
        if (interactive) outcome = await repl(ctx, runner, gateway, outcome, prompter?.memory ?? null);
        return exitFor(outcome);
    } finally {
        removeSigint();
        journal.release();
    }
};

const repl = async (ctx: Context, runner: Runner, gateway: Gateway, initial: Outcome = "success", memory: ApprovalMemory | null = null): Promise<Outcome> => {
    // The exit code is the last task's outcome, so `tomverse && …` never goes on after one that failed.
    let last: Outcome = initial;
    ctx.output.info("Type a task, or /help. Ctrl+D or /exit to leave.");
    for (;;) {
        const line = await askLine("tomverse> ");
        if (line === null || line.trim() === "/exit") return last;
        const text = line.trim();
        if (!text) continue;
        if (text === "/help") {
            ctx.output.info("/diff  changes this session made   /usage  credits of this session   /compact  summarise history now   /model  current model   /approvals [clear]  what is allowed without asking   /exit");
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
        last = await runner.runTask(text);
        await finalEvent(ctx, runner, gateway, last);
    }
};

const resume = async (ctx: Context, args: string[], interactive: boolean) => {
    const [id, ...rest] = args;
    if (!id) throw new UsageError("resume needs a session id (see `tomverse sessions list`).");
    const prompter = interactive ? terminalPrompter() : null;
    const journal = Journal.open(tomverseHome(), id);
    try {
        const state = journal.state;
        const root = normalizeRoot(state.workspace.root);
        if (!same(root, state.workspace.root)) throw new UsageError(`The session's folder now resolves to ${root}; not resuming.`);
        const { endpoint, key, gateway } = await connect(ctx);
        if (endpoint.origin !== state.endpointOrigin) throw new UsageError(`This session used ${state.endpointOrigin}; the endpoint is now ${endpoint.origin}. Not resuming.`);
        // A session's requests can only be looked up with the key that sent
        // them, so a session stays on one key.
        if (state.keyPrefix !== keyPrefix(key)) {
            throw new UsageError(`This session belongs to key ${state.keyPrefix}; you are using ${keyPrefix(key)}. Resume it with that key, or start a new session.`);
        }
        const catalog = toolModels(await gateway.models());
        const modelId = state.model.pinned ?? state.model.requested;
        if (!catalog.some((m) => m.id === modelId)) {
            throw new UsageError(`${modelId} is no longer offered to this key, and the CLI does not switch models silently. Start a new session with a model from \`tomverse models\`.`);
        }
        if (ctx.flags["max-requests"]) {
            const task = state.tasks.at(-1);
            if (task) task.allowance = Math.max(task.allowance, task.requests + positiveInt(ctx.flags["max-requests"], "max-requests", DEFAULTS.maxRequests));
        }
        const workspace = new Workspace(root);
        const runner = new Runner({ gateway, journal, workspace, output: ctx.output, prompter, catalog, commandEnv: ctx.config.commandEnv ?? [], instructions: readInstructions(workspace) });
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
        }
    } finally {
        journal.release();
    }
};

/**
 * After a crash: what the journal says was under way. A write whose end was
 * not recorded is checked against the file; a command that started and never
 * finished is reported as unknown and is never run again.
 */
const reconcile = (journal: Journal) => {
    const notes: string[] = [];
    for (const change of journal.state.changes.filter((c) => c.state === "writing")) {
        const view = viewChanges({ ...journal, state: { ...journal.state, changes: [{ ...change, state: "applied" }] } } as Journal)[0];
        change.state = view?.current === "as_written" ? "applied" : "failed";
        notes.push(`A write of ${change.path} was under way: it is ${change.state === "applied" ? "complete" : "not complete (the file was left as it is)"}.`);
    }
    for (const tool of journal.state.tools.filter((t) => t.state === "started")) {
        notes.push(`${tool.toolName} (${tool.toolCallId}) had started and its outcome is unknown; it was not run again.`);
    }
    if (notes.length) journal.commit();
    return notes;
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
            error instanceof ConfigError ||
            error instanceof AuthError ||
            error instanceof PathError ||
            error instanceof JournalError ||
            error instanceof SessionLockedError ||
            error instanceof UndoError ||
            error instanceof GatewayError;
        const message = error instanceof GatewayError ? describeApiError(error) : (error as Error).message;
        output.event({ type: "error", code: error instanceof GatewayError ? (error.extra.code ?? error.kind) : (error as Error).constructor.name, message });
        output.info(known ? message : `Unexpected error: ${message}`);
        return error instanceof UsageError ? EXIT_CODES.usage : EXIT_CODES.error;
    }
};
