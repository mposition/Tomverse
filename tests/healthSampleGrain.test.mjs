import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/**
 * The grain columns on the two tables health is actually sampled from.
 *
 * What these hold is that the columns exist without anything pretending they
 * carry a value: no default, no backfill, no writer, and a deletion rule that
 * keeps a historical record saying what happened.
 */

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923260000_health_sample_grain_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

const schema = () =>
    readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

const statements = () =>
    migration()
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");

test("the two sampled tables get the columns, and the status page table does not", () => {
    // The candidate filter reads ProviderProbeResult and its dispatch signals
    // come from RoutingAttempt. ProviderHealthState is the public status page
    // and the operator recovery path, and cutting it over here would change
    // what an operator reads during an incident.
    const sql = statements();
    for (const table of ["ProviderProbeResult", "RoutingAttempt"]) {
        assert.match(
            sql,
            new RegExp(
                `ALTER TABLE "${table}"\\s*\\n\\s*ADD COLUMN "providerEndpointId" TEXT,\\s*\\n\\s*ADD COLUMN "modelDeploymentId" TEXT;`
            ),
            table
        );
    }
    assert.ok(!sql.includes("ProviderHealthState"), "the status page table is left alone");
});

test("neither column defaults and nothing is backfilled", () => {
    // Every existing row was written before deployments existed, and there is
    // no rule that could recover which placement served one. A default would
    // be the invented attribution this whole change exists to stop.
    const sql = statements();
    assert.ok(!/ADD COLUMN "(providerEndpointId|modelDeploymentId)" TEXT[^,;]*DEFAULT/.test(sql));
    assert.ok(!/UPDATE "(ProviderProbeResult|RoutingAttempt)"/.test(sql));
    // Looking at the ADD COLUMN lines, not the whole file: `IS NOT NULL`
    // appears legitimately inside both shape rules.
    for (const line of sql.split("\n")) {
        if (!line.includes("ADD COLUMN")) continue;
        assert.ok(
            !line.includes("NOT NULL"),
            `${line.trim()} is not nullable`
        );
    }
});

test("a sample that names a deployment names the endpoint it ran on", () => {
    // Otherwise it sits in the deployment view and vanishes from the endpoint
    // view, which reads as an endpoint that had no trouble. Same rule as
    // AvailabilityObservation, stated the same way.
    const sql = statements();
    for (const table of ["ProviderProbeResult", "RoutingAttempt"]) {
        assert.match(
            sql,
            new RegExp(
                `"${table}_deployment_has_endpoint_check"\\s*\\n\\s*CHECK \\("modelDeploymentId" IS NULL OR "providerEndpointId" IS NOT NULL\\)`
            ),
            table
        );
    }
});

test("deleting a placement cannot delete the record of what it did", () => {
    // RESTRICT rather than CASCADE or SET NULL: the way to stop routing to a
    // placement is to disable it, and one that answered turns is one whose
    // history has to keep saying so. Six foreign keys -- two tables here plus
    // the two AvailabilityObservation should have had when it was added.
    const sql = statements();
    const restricts = sql.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g) ?? [];
    assert.equal(restricts.length, 6);
    assert.ok(!sql.includes("ON DELETE CASCADE"));
    assert.ok(!sql.includes("ON DELETE SET NULL"));
    for (const table of [
        "ProviderProbeResult",
        "RoutingAttempt",
        "AvailabilityObservation",
    ]) {
        assert.match(sql, new RegExp(`ALTER TABLE "${table}"[\\s\\S]{0,200}?FOREIGN KEY \\("providerEndpointId"\\)`), table);
        assert.match(sql, new RegExp(`ALTER TABLE "${table}"[\\s\\S]{0,200}?FOREIGN KEY \\("modelDeploymentId"\\)`), table);
    }
});

test("no branch of either shape rule can evaluate to NULL", () => {
    // A CHECK passes when its expression is TRUE *or NULL* and refuses only on
    // FALSE, so a comparison against a nullable column has to be one that
    // cannot itself be NULL. `IS NULL` and `IS NOT NULL` qualify.
    const sql = statements();
    for (const match of sql.matchAll(/_deployment_has_endpoint_check"\s*\n\s*CHECK \(([^;]*)\)/g)) {
        for (const operator of ["=", "<>", "!=", " IN ", " ~ ", " LIKE "]) {
            assert.ok(!match[1].includes(operator), `${operator.trim()} can evaluate to NULL`);
        }
    }
});

test("the relation fields are named something a scan can protect", () => {
    // `endpoint` and `deployment` are words ordinary code uses for its own
    // purposes, and check-dark-tables matches a relation field by name. A
    // generic name there would either miss the read or fail on files that
    // never touch these tables, which is the trade the dark column list
    // already records.
    // A name per table, saying what the sample was. `servingDeployment` was
    // the first try and is already a function in the feedback auto-fix
    // modules, about a Railway deployment -- a name scan cannot tell those
    // apart, which is the failure this naming avoids.
    const source = schema();
    // Scoped to the two live tables. QuotaScope names its relations
    // `endpoint` and `deployment` too, and that is fine: it is itself dark,
    // so reaching its rows means querying its own delegate, which the scan
    // already sees.
    for (const model of ["ProviderProbeResult", "RoutingAttempt"]) {
        const block = new RegExp(
            `model ${model} \\{([\\s\\S]*?)\\n\\}`
        ).exec(source);
        assert.ok(block, model);
        assert.ok(!/\n\s+endpoint\s+ProviderEndpoint\?/.test(block[1]), model);
        assert.ok(!/\n\s+deployment\s+ModelDeployment\?/.test(block[1]), model);
    }
    for (const field of [
        "probedEndpoint",
        "probedDeployment",
        "dispatchedEndpoint",
        "dispatchedDeployment",
        "observedEndpoint",
        "observedDeployment",
    ]) {
        assert.match(source, new RegExp(`\\n\\s+${field}\\s+(ProviderEndpoint|ModelDeployment)\\?`), field);
    }

    // And the scan reads `Type?`, which an earlier version of its field regex
    // did not: an optional relation was invisible to it.
    const checker = readFileSync(
        new URL("../scripts/check-dark-tables.mjs", import.meta.url),
        "utf8"
    );
    assert.match(checker, /\(\\\[\\\]\|\\\?\)\?/);
});

test("nothing writes the four columns", () => {
    // The columns close a schema gap and nothing else. The probe scheduler
    // still dispatches one representative model per provider, so every row
    // carries null until a per-deployment canary exists.
    const roots = ["app", "lib", "components", "scripts"];
    const walk = (directory) =>
        readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
            if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
            const path = `${directory}/${entry.name}`;
            return entry.isDirectory()
                ? walk(path)
                : /\.(ts|tsx|mjs|js)$/.test(entry.name)
                  ? [path]
                  : [];
        });
    const names =
        /\b(probed|dispatched|observed)(Endpoint|Deployment)\b/;
    const offenders = roots
        .flatMap((root) => walk(root))
        .filter((file) => names.test(readFileSync(file, "utf8")));
    assert.deepEqual(offenders, []);
});
