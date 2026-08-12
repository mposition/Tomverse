// Fails when a ChatAccessError details bag carries micro-USD under a name the
// `internal` stripper cannot see. See check-error-detail-cost-core.mjs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { auditErrorDetailCostFields } from "./check-error-detail-cost-core.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const sources = [];
const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
            walk(full);
        } else if (
            (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
            !entry.includes(".test.")
        ) {
            const source = readFileSync(full, "utf8");
            if (source.includes("new ChatAccessError(")) {
                sources.push({ path: relative(repoRoot, full), source });
            }
        }
    }
};
walk(join(repoRoot, "lib"));
walk(join(repoRoot, "app"));

const { failures } = auditErrorDetailCostFields(sources);

if (failures.length > 0) {
    console.error("Error detail cost check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(
    `Error detail cost check passed: ${sources.length} file(s) throwing ` +
        `ChatAccessError, no unstripped micro-USD in any details bag.`
);
