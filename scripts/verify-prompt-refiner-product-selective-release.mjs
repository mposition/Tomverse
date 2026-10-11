import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
    PROMPT_REFINER_PRODUCT_SELECTIVE_OMITTED_RUNTIME_SOURCES,
    promptRefinerProductSelectiveReleaseProblems,
} from "./prompt-refiner-product-limited-dark-access.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const roots = ["app", "lib", "components", "scripts", "packages", "prisma/seed"];
const sourceExtension = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/;

const walk = (directory) => {
    const absolute = join(root, directory);
    let entries;
    try {
        entries = readdirSync(absolute);
    } catch {
        return [];
    }
    return entries.flatMap((entry) => {
        if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) {
            return [];
        }
        const path = join(absolute, entry);
        if (statSync(path).isDirectory()) return walk(join(directory, entry));
        return sourceExtension.test(entry) ? [join(directory, entry)] : [];
    });
};

const runtimeSources = new Map(roots.flatMap((directory) => walk(directory)).map((file) => {
    const normalised = relative(root, join(root, file)).split("\\").join("/");
    return [normalised, readFileSync(join(root, file), "utf8")];
}));
const problems = promptRefinerProductSelectiveReleaseProblems(runtimeSources);

console.log("");
console.log("Prompt Refiner selective release verification");
console.log("---------------------------------------------");
if (problems.length !== 0) {
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
}
console.log(
    `${PROMPT_REFINER_PRODUCT_SELECTIVE_OMITTED_RUNTIME_SOURCES.length} lifecycle source(s) ` +
    "are omitted and mixed evidence modules have read-only runtime callers."
);
