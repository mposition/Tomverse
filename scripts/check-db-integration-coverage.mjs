// Fails when the DB integration runner and tests/integration/ disagree about
// which suites exist. See check-db-integration-coverage-core.mjs for why the
// list is hand-written and why that needs a check.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { auditDbIntegrationCoverage } from "./check-db-integration-coverage-core.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const suiteFiles = readdirSync(join(repoRoot, "tests", "integration"))
    .filter((name) => name.endsWith(".db.test.ts"))
    .sort();

const { failures, referenced } = auditDbIntegrationCoverage({
    suiteFiles,
    runnerSource: readFileSync(
        join(repoRoot, "scripts", "run-db-integration-tests.mjs"),
        "utf8"
    ),
});

if (failures.length > 0) {
    console.error("DB integration coverage check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(
    `DB integration coverage check passed: ${suiteFiles.length} suite(s) in ` +
        `tests/integration/, all ${referenced.length} named by the runner.`
);
