// Result aggregation and the markdown tables. Pure functions over results.json.
import { CATEGORIES } from "./tasks.mjs";

export const median = (values) => {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const sum = (values) => {
    const known = values.filter((v) => Number.isFinite(v));
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

export const percent = (passed, total) => (total ? `${((passed / total) * 100).toFixed(1)}%` : "n/a");
const seconds = (ms) => (ms === null || ms === undefined ? "n/a" : (ms / 1000).toFixed(1));
const cell = (passed, total) => `${passed}/${total} (${percent(passed, total)})`;

export const routesIn = (results) => [...new Set(results.map((r) => r.route))];

export const summarizeRoute = (results, route) => {
    const mine = results.filter((r) => r.route === route);
    const passed = mine.filter((r) => r.passed).length;
    const byCategory = {};
    for (const category of CATEGORIES) {
        const inCategory = mine.filter((r) => r.category === category);
        byCategory[category] = { total: inCategory.length, passed: inCategory.filter((r) => r.passed).length };
    }
    return {
        route,
        total: mine.length,
        passed,
        byCategory,
        medianAgentMs: median(mine.map((r) => r.agentMs)),
        medianTotalMs: median(mine.map((r) => r.totalMs)),
        medianChangedFiles: median(mine.map((r) => r.changedFiles)),
        costUsd: sum(mine.map((r) => r.metrics?.costUsd)),
        credits: sum(mine.map((r) => r.metrics?.credits)),
        inputTokens: sum(mine.map((r) => r.metrics?.inputTokens)),
        outputTokens: sum(mine.map((r) => r.metrics?.outputTokens)),
        notOk: mine.filter((r) => r.adapterStatus !== "ok").length,
    };
};

const num = (value, digits = 0) => (value === null ? "n/a" : value.toLocaleString("en-US", { maximumFractionDigits: digits }));

const table = (header, rows) => [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

export const renderSummary = ({ results, meta = {} }) => {
    const routes = routesIn(results);
    const summaries = routes.map((route) => summarizeRoute(results, route));
    const taskIds = [...new Set(results.map((r) => r.taskId))].sort();
    const lines = ["# Code eval summary", ""];
    if (meta.startedAt) lines.push(`Started: ${meta.startedAt}  `);
    lines.push(`Routes: ${routes.join(", ")}  `, `Tasks: ${taskIds.length}`, "");

    lines.push("## Success rate by route", "", table(["Route", "Passed", "Rate", "Agent not ok"], summaries.map((s) => [s.route, `${s.passed}/${s.total}`, percent(s.passed, s.total), String(s.notOk)])), "");
    lines.push("A task passes when its hidden check passes; `Agent not ok` counts runs where the agent errored, timed out or hit its own limit (the folder is still checked).", "");

    lines.push("## Success rate by category", "", table(["Category", ...routes], CATEGORIES.map((category) => [category, ...summaries.map((s) => cell(s.byCategory[category].passed, s.byCategory[category].total))])), "");

    lines.push(
        "## Time and cost",
        "",
        table(
            ["Route", "Median agent s", "Median total s", "Median files changed", "Cost USD", "Credits", "Input tokens", "Output tokens"],
            summaries.map((s) => [s.route, seconds(s.medianAgentMs), seconds(s.medianTotalMs), num(s.medianChangedFiles, 1), num(s.costUsd, 4), num(s.credits, 2), num(s.inputTokens), num(s.outputTokens)]),
        ),
        "",
        "`n/a` means no run of that route reported the value (not that it was zero). Cost and credits are as the route itself reports them.",
        "",
    );

    const status = (r) => (r.passed ? "PASS" : "FAIL") + (r.adapterStatus && r.adapterStatus !== "ok" ? ` (${r.adapterStatus})` : "");
    lines.push(
        "## Per-task results",
        "",
        table(
            ["Task", "Category", ...routes],
            taskIds.map((id) => {
                const first = results.find((r) => r.taskId === id);
                return [id, first.category, ...routes.map((route) => { const r = results.find((x) => x.taskId === id && x.route === route); return r ? status(r) : "-"; })];
            }),
        ),
        "",
    );
    return lines.join("\n");
};

/** Side-by-side comparison of several runs; the first run is the baseline. */
export const renderComparison = (runs, { route } = {}) => {
    const lines = ["# Code eval comparison", "", `Baseline: ${runs[0].label}`, ""];
    const routes = [...new Set(runs.flatMap((run) => routesIn(run.results)))].filter((r) => !route || r === route);
    for (const name of routes) {
        const present = runs.filter((run) => run.results.some((r) => r.route === name));
        if (!present.length) continue;
        lines.push(`## Route ${name}`, "");
        const base = present[0];
        const rows = present.map((run) => {
            const s = summarizeRoute(run.results, name);
            const delta = run === base ? "-" : `${((s.passed / s.total - summarizeRoute(base.results, name).passed / summarizeRoute(base.results, name).total) * 100).toFixed(1)} pt`;
            return [run.label, `${s.passed}/${s.total}`, percent(s.passed, s.total), delta, seconds(s.medianAgentMs), num(s.costUsd, 4), num(s.credits, 2)];
        });
        lines.push(table(["Run", "Passed", "Rate", "vs baseline", "Median agent s", "Cost USD", "Credits"], rows), "");
        for (const run of present.slice(1)) {
            const was = new Map(base.results.filter((r) => r.route === name).map((r) => [r.taskId, r.passed]));
            const fixed = [];
            const regressed = [];
            const notCompared = [];
            for (const r of run.results.filter((x) => x.route === name)) {
                if (!was.has(r.taskId)) notCompared.push(r.taskId);
                else if (!was.get(r.taskId) && r.passed) fixed.push(r.taskId);
                else if (was.get(r.taskId) && !r.passed) regressed.push(r.taskId);
            }
            lines.push(`### ${run.label} against ${base.label}`, "");
            lines.push(`- fixed (fail to pass): ${fixed.length ? fixed.join(", ") : "none"}`);
            lines.push(`- regressed (pass to fail): ${regressed.length ? regressed.join(", ") : "none"}`);
            if (notCompared.length) lines.push(`- only in this run: ${notCompared.join(", ")}`);
            lines.push("");
        }
    }
    if (!routes.length) lines.push("No route to compare.", "");
    return lines.join("\n");
};
