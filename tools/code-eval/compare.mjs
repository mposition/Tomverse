#!/usr/bin/env node
// Compares several results.json files (or --out directories) side by side.
// The first one is the baseline: later runs show which tasks they fixed and
// which they regressed. Use it before and after changing the agent engine.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { renderComparison } from "./lib/report.mjs";

const USAGE = `Usage: node tools/code-eval/compare.mjs <results> <results> [...] [--route <name>] [--out <file>]
  <results>  a results.json file or the --out directory of a run (first = baseline)`;

export const loadRun = (input) => {
    const path = resolve(input);
    const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "results.json") : path;
    if (!existsSync(file)) throw new Error(`No results.json at ${input}`);
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(data.results)) throw new Error(`${input} is not a code-eval results file`);
    const label = statSync(path).isDirectory() ? basename(path) : basename(join(file, ".."));
    // The conditions the run recorded (older results files have none).
    return { label, results: data.results, ...(data.engine ? { engine: data.engine } : {}) };
};

export const main = (argv = process.argv.slice(2)) => {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, allowPositionals: true, options: { route: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" } } });
    } catch (error) {
        console.error(`${error.message}\n${USAGE}`);
        return 2;
    }
    if (parsed.values.help || parsed.positionals.length < 2) {
        console.error(USAGE);
        return parsed.values.help ? 0 : 2;
    }
    try {
        const runs = parsed.positionals.map(loadRun);
        const labels = new Set();
        for (const run of runs) {
            let label = run.label;
            for (let i = 2; labels.has(label); i++) label = `${run.label}#${i}`;
            labels.add(label);
            run.label = label;
        }
        const text = renderComparison(runs, { route: parsed.values.route });
        if (parsed.values.out) writeFileSync(parsed.values.out, `${text}\n`);
        else console.log(text);
        return 0;
    } catch (error) {
        console.error(error.message);
        return 2;
    }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
