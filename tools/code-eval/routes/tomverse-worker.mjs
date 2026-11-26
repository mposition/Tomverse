// Runs the Tomverse agent on one working folder through its runtime API, with
// an approval policy that only accepts changes and commands inside that folder.
// Started by routes/tomverse.mjs as `node tomverse-worker.mjs`; it reads one
// JSON request from stdin and writes one JSON result to the file it names.
//
// The API key is read from TOMVERSE_API_KEY only, removed from the process
// environment at once, and never written to the result, the log or any file.
//
// `--selftest` loads the runtime and exits without any network request.
import { writeFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
import { decideApproval } from "./tomverse-approval.mjs";

const RUNTIME = "../../../apps/tomverse-cli/src/runtime.ts";
const readStdin = async () => {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return text;
};

const toolModels = (models) => models.filter((m) => m.tools && m.protocols.includes("chat_completions"));

const main = async () => {
    const runtime = await tsImport(RUNTIME, import.meta.url);
    if (process.argv.includes("--selftest")) {
        for (const name of ["Gateway", "Runner", "createSession", "Workspace", "normalizeRoot", "resolveEndpoint", "sessionCost", "readInstructions", "resolveLimits"]) {
            if (typeof runtime[name] !== "function") throw new Error(`runtime export ${name} is missing`);
        }
        console.log("selftest ok");
        return;
    }
    const request = JSON.parse(await readStdin());
    const { Gateway, Runner, createSession, Workspace, normalizeRoot, resolveEndpoint, sessionCost, readInstructions, resolveLimits, NO_LIMIT, SMART_ADAPTIVE, EXIT_CODES } = runtime;

    const key = process.env.TOMVERSE_API_KEY?.trim();
    delete process.env.TOMVERSE_API_KEY;
    const finish = (result) => writeFileSync(request.resultFile, JSON.stringify(result));
    if (!key) return finish({ status: "error", error: "TOMVERSE_API_KEY is not set" });

    const lines = [];
    const output = {
        json: true,
        info: (text) => lines.push(String(text)),
        stream: () => {},
        event: () => {},
    };
    const root = normalizeRoot(request.workDir);
    const endpoint = resolveEndpoint({}, process.env);
    const gateway = new Gateway(endpoint, key);
    const catalog = toolModels(await gateway.models());
    const wanted = request.model || SMART_ADAPTIVE;
    const model = catalog.find((m) => m.id === wanted);
    if (!model) return finish({ status: "error", error: `model "${wanted}" is not offered to this key; offered: ${catalog.map((m) => m.id).join(", ")}` });

    const journal = createSession(null, {
        root,
        endpoint,
        keyPrefix: key.slice(0, 12),
        model,
        readOnly: false,
        // The profile gives the request count and time; a count given on the command line and the task's own time limit are more specific and win.
        limits: resolveLimits(request.limits ?? "extended", {
            ...(request.maxRequests ? { maxRequests: request.maxRequests } : {}),
            timeoutMs: request.timeoutMs,
            commandTimeoutMs: request.commandTimeoutMs,
        }),
    });
    const decisions = { approved: 0, denied: 0, deniedReasons: [] };
    const prompter = {
        approve: async (view) => {
            const decision = decideApproval(view, root);
            if (decision.approved) decisions.approved += 1;
            else {
                decisions.denied += 1;
                if (decisions.deniedReasons.length < 10) decisions.deniedReasons.push(decision.reason);
            }
            return decision.approved ? { approved: true } : { approved: false, reason: decision.reason };
        },
        confirm: async () => false,
    };
    const workspace = new Workspace(root);
    // The engine features of this measurement, by Runner option. web and memory are never among them (see routes/tomverse.mjs).
    const features = request.engine ?? [];
    const engineOptions = Object.fromEntries(["backgroundCommands", "images", "nestedInstructions", "subagents"].filter((name) => features.includes(name)).map((name) => [name, true]));
    const runner = new Runner({ gateway, journal, workspace, output, prompter, catalog, commandEnv: [], instructions: readInstructions(workspace), ...engineOptions });
    let outcome = "error";
    try {
        outcome = await runner.runTask(request.prompt);
    } finally {
        let cost = null;
        try {
            cost = await sessionCost(gateway, journal);
        } catch {
            // cost stays unknown
        }
        const usage = journal.state.generations.reduce(
            (sum, g) => ({
                inputTokens: sum.inputTokens + (g.receipt?.usage?.inputTokens ?? 0),
                outputTokens: sum.outputTokens + (g.receipt?.usage?.outputTokens ?? 0),
                cachedInputTokens: sum.cachedInputTokens + (g.receipt?.usage?.cachedInputTokens ?? 0),
            }),
            { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        );
        const subagents = journal.state.subagents ?? [];
        const limits = journal.state.limits;
        journal.release();
        finish({
            status: outcome === "success" ? "ok" : outcome,
            outcome,
            exitCode: EXIT_CODES[outcome] ?? null,
            model: model.id,
            metrics: {
                credits: cost ? cost.charged : null,
                creditsHeld: cost ? cost.held : null,
                creditsUnknownRequests: cost ? cost.unknown.length : null,
                turns: cost ? cost.requests : journal.state.generations.length,
                ...usage,
                // Included in the turns and the credits above: the requests subagents made.
                subagentRuns: subagents.length,
                subagentRequests: journal.state.generations.filter((g) => g.purpose === "subagent").length,
            },
            // The conditions this run had, recorded so a comparison of two runs shows them.
            engine: {
                limits: {
                    profile: limits.profile ?? "standard",
                    maxRequests: limits.maxRequests >= NO_LIMIT ? null : limits.maxRequests,
                    timeoutMs: limits.timeoutMs >= NO_LIMIT ? null : limits.timeoutMs,
                },
                features,
            },
            approvals: decisions,
            logTail: lines.join("\n").slice(-4000),
        });
    }
};

main().catch((error) => {
    // Never echo the environment: only the message.
    console.error(String(error?.message ?? error));
    process.exit(1);
});
