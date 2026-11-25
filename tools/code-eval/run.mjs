#!/usr/bin/env node
// Runs coding tasks through one or more execution routes and records whether
// each task's hidden check passes. See README.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { envWithout, runProcess } from "./lib/proc.mjs";
import { renderSummary, routesIn, summarizeRoute, percent } from "./lib/report.mjs";
import { CATEGORIES, loadTasks, selectTasks } from "./lib/tasks.mjs";
import { changedFiles, installCheck, prepareWorkspace } from "./lib/workspace.mjs";
import { ROUTE_NAMES, getRoute } from "./routes/index.mjs";
import { ENGINE_FEATURES, LIMIT_PROFILES, engineConditions, parseEngineFeatures, parseLimitProfile } from "./routes/tomverse.mjs";

export const CHECK_TIMEOUT_MS = 120_000;

const USAGE = `Usage: node tools/code-eval/run.mjs --route <name>[,<name>] [options]

  --route <name>       fake, noop, tomverse, codex, claude (repeat or comma-separate)
  --task <id>          only this task (repeatable)
  --category <name>    only this category: ${CATEGORIES.join(", ")} (repeatable)
  --out <dir>          where results.json and summary.md go (default: a new folder under the OS temp dir)
  --concurrency <n>    jobs at the same time (default 1)
  --allow-paid         required for tomverse, codex and claude: they call real models and cost money
  --model <id>         model for the real routes (default: each tool's own default)
  --max-requests <n>   model requests per task for the tomverse route (default: what --limits gives; a number here wins over it)
  --limits <profile>   tomverse route: ${LIMIT_PROFILES.join(", ")} (default extended: 200 requests; the task's own time limit always applies)
  --engine <list>      tomverse route: engine features to turn on: "none", or a list of ${ENGINE_FEATURES.join(", ")}
                       (default: all of them; web_fetch and the Code memory are never on in a measurement)
  --keep-workdirs      keep the temporary working folders (for debugging a failure)
  --list               print the task ids and exit`;

const parse = (argv) =>
    parseArgs({
        args: argv,
        allowPositionals: false,
        options: {
            route: { type: "string", multiple: true },
            task: { type: "string", multiple: true },
            category: { type: "string", multiple: true },
            out: { type: "string" },
            concurrency: { type: "string" },
            "allow-paid": { type: "boolean" },
            model: { type: "string" },
            "max-requests": { type: "string" },
            limits: { type: "string" },
            engine: { type: "string" },
            "keep-workdirs": { type: "boolean" },
            list: { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    }).values;

const positiveInt = (value, name, fallback) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive whole number.`);
    return n;
};

/** Runs one (route, task) pair and returns its result record. Never throws. */
export const runJob = async ({ route, task, options, env = process.env }) => {
    const record = { route: route.name, taskId: task.id, category: task.category, passed: false };
    const startedAt = Date.now();
    let workspace;
    try {
        workspace = await prepareWorkspace(task);
        const { workDir } = workspace;
        const agentStart = Date.now();
        let outcome;
        try {
            outcome = await route.run({ task, workDir, prompt: task.prompt, timeoutMs: task.timeoutSeconds * 1000, options, env });
        } catch (error) {
            outcome = { status: "error", error: String(error?.message ?? error) };
        }
        record.agentMs = Date.now() - agentStart;
        record.adapterStatus = outcome.status ?? "ok";
        if (outcome.error) record.adapterError = String(outcome.error).slice(0, 500);
        if (outcome.metrics && Object.keys(outcome.metrics).length) record.metrics = outcome.metrics;
        if (outcome.approvals) record.approvals = outcome.approvals;
        if (outcome.engine) record.engine = outcome.engine;
        if (outcome.logTail) record.agentLogTail = outcome.logTail;
        record.changedFiles = await changedFiles(workDir);

        installCheck(task, workDir);
        const [file, ...args] = task.check;
        const checkStart = Date.now();
        const check = await runProcess({
            file: file === "node" ? process.execPath : file,
            args,
            cwd: workDir,
            env: { ...envWithout(["TOMVERSE_API_KEY", "NODE_TEST_CONTEXT"], env), NODE_OPTIONS: "" },
            timeoutMs: CHECK_TIMEOUT_MS,
        });
        record.checkMs = Date.now() - checkStart;
        record.checkExit = check.timedOut ? "timeout" : check.code;
        record.passed = check.code === 0 && !check.timedOut && !check.spawnError;
        if (!record.passed) record.checkOutputTail = `${check.spawnError ?? ""}${check.stdout}\n${check.stderr}`.trim().slice(-1500);
    } catch (error) {
        record.adapterStatus = record.adapterStatus ?? "harness-error";
        record.adapterError = String(error?.message ?? error).slice(0, 500);
    } finally {
        record.totalMs = Date.now() - startedAt;
        if (workspace && !options.keepWorkdirs) workspace.dispose();
        else if (workspace) record.workDir = workspace.workDir;
    }
    return record;
};

const pool = async (jobs, concurrency, work) => {
    const results = new Array(jobs.length);
    let next = 0;
    const lane = async () => {
        for (;;) {
            const index = next++;
            if (index >= jobs.length) return;
            results[index] = await work(jobs[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, lane));
    return results;
};

/** Self-check routes have an expected outcome; anything else is a harness bug. */
const EXPECTATION = { fake: { passed: true, word: "pass" }, noop: { passed: false, word: "fail" } };

export const main = async (argv = process.argv.slice(2), env = process.env) => {
    let values;
    try {
        values = parse(argv);
    } catch (error) {
        console.error(`${error.message}\n\n${USAGE}`);
        return 2;
    }
    if (values.help) {
        console.log(USAGE);
        return 0;
    }
    try {
        const all = loadTasks();
        if (values.list) {
            for (const t of all) console.log(`${t.id}\t${t.category}\t${t.title}`);
            return 0;
        }
        const routeNames = [...new Set((values.route ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean))];
        if (!routeNames.length) throw Object.assign(new Error(`Pass --route (${ROUTE_NAMES.join(", ")}).`), { usage: true });
        const routes = routeNames.map(getRoute);

        // Paid routes are refused before any folder is created or any model is called.
        const paid = routes.filter((r) => r.paid);
        if (paid.length && !values["allow-paid"]) {
            for (const r of paid) console.error(`Refusing to run: ${r.paidNotice}\nPass --allow-paid to run it.`);
            return 2;
        }
        for (const r of paid) {
            const problem = r.preflight?.(env);
            if (problem) throw new Error(`Route ${r.name}: ${problem}`);
        }

        const tasks = selectTasks(all, { ids: values.task ?? [], categories: values.category ?? [] });
        if (!tasks.length) throw new Error("No task matches the filters.");
        const concurrency = positiveInt(values.concurrency, "concurrency", 1);
        const options = {
            model: values.model,
            maxRequests: positiveInt(values["max-requests"], "max-requests", undefined),
            limits: parseLimitProfile(values.limits),
            engine: parseEngineFeatures(values.engine),
            keepWorkdirs: Boolean(values["keep-workdirs"]),
        };
        const out = resolve(values.out ?? join(tmpdir(), "tomverse-code-eval", new Date().toISOString().replace(/[:.]/g, "-")));
        mkdirSync(out, { recursive: true });

        const startedAt = new Date().toISOString();
        const jobs = routes.flatMap((route) => tasks.map((task) => ({ route, task })));
        let finished = 0;
        const results = await pool(jobs, concurrency, async ({ route, task }) => {
            const result = await runJob({ route, task, options, env });
            finished += 1;
            console.error(`[${finished}/${jobs.length}] ${route.name} ${task.id} ${result.passed ? "PASS" : "FAIL"} ${(result.totalMs / 1000).toFixed(1)}s${result.adapterStatus !== "ok" ? ` (${result.adapterStatus})` : ""}`);
            return result;
        });

        const meta = {
            version: 1,
            startedAt,
            finishedAt: new Date().toISOString(),
            node: process.version,
            platform: process.platform,
            routes: routeNames,
            tasks: tasks.map((t) => t.id),
            concurrency,
            model: values.model ?? null,
            // The conditions of the tomverse route, so compare.mjs can show them next to the results.
            ...(routeNames.includes("tomverse") ? { engine: engineConditions({ limits: options.limits, engine: options.engine, maxRequests: options.maxRequests }) } : {}),
        };
        writeFileSync(join(out, "results.json"), `${JSON.stringify({ ...meta, results }, null, 2)}\n`);
        writeFileSync(join(out, "summary.md"), `${renderSummary({ results, meta })}\n`);

        for (const route of routesIn(results)) {
            const s = summarizeRoute(results, route);
            console.log(`${route}: ${s.passed}/${s.total} passed (${percent(s.passed, s.total)})`);
        }
        console.log(`Results: ${out}`);

        let code = 0;
        for (const [name, expected] of Object.entries(EXPECTATION)) {
            const wrong = results.filter((r) => r.route === name && r.passed !== expected.passed);
            if (wrong.length) {
                console.error(`Self-check failed: route ${name} must ${expected.word} every task, but ${wrong.length} did not: ${wrong.map((r) => r.taskId).join(", ")}`);
                code = 1;
            }
        }
        return code;
    } catch (error) {
        console.error(`${error.message}${error.usage ? `\n\n${USAGE}` : ""}`);
        return 2;
    }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
