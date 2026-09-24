import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    STICKY_GRAIN_REWRITES_STORED_IDS,
    compareGrainShadow,
    projectDeploymentScores,
    readStickyAsLogical,
} from "../lib/routingStickyGrain.ts";

const logicalModelIds = ["deepseek-v4-pro", "kimi-k3"];
const deploymentIds = ["dep_deepinfra_pro", "dep_together_pro"];

test("stored sticky ids stay logical and are not rewritten", () => {
    const read = readStickyAsLogical({
        routerModelId: "deepseek-v4-pro",
        routerRecoveryModelId: "kimi-k3",
        logicalModelIds,
        deploymentIds,
    });
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.routerModelId, "deepseek-v4-pro");
    assert.equal(read.routerRecoveryModelId, "kimi-k3");
    assert.equal(STICKY_GRAIN_REWRITES_STORED_IDS, false);
});

test("a deployment id in sticky state is refused", () => {
    assert.deepEqual(
        readStickyAsLogical({
            routerModelId: "dep_deepinfra_pro",
            routerRecoveryModelId: null,
            logicalModelIds,
            deploymentIds,
        }),
        { ok: false, field: "routerModelId", reason: "deployment_id" }
    );
    assert.deepEqual(
        readStickyAsLogical({
            routerModelId: "deepseek-v4-pro",
            routerRecoveryModelId: "dep_together_pro",
            logicalModelIds,
            deploymentIds,
        }),
        { ok: false, field: "routerRecoveryModelId", reason: "deployment_id" }
    );
});

test("blank, unknown, ambiguous, and untrimmed ids are refused", () => {
    assert.equal(
        readStickyAsLogical({
            routerModelId: "",
            routerRecoveryModelId: null,
            logicalModelIds,
            deploymentIds,
        }).reason,
        "blank"
    );
    assert.equal(
        readStickyAsLogical({
            routerModelId: "deepseek-v4-pro ",
            routerRecoveryModelId: null,
            logicalModelIds,
            deploymentIds,
        }).reason,
        "unknown"
    );
    assert.equal(
        readStickyAsLogical({
            routerModelId: "not-a-model",
            routerRecoveryModelId: null,
            logicalModelIds,
            deploymentIds,
        }).reason,
        "unknown"
    );
    assert.equal(
        readStickyAsLogical({
            routerModelId: "deepseek-v4-pro",
            routerRecoveryModelId: null,
            logicalModelIds: ["deepseek-v4-pro"],
            deploymentIds: ["deepseek-v4-pro"],
        }).reason,
        "ambiguous"
    );
    const empty = readStickyAsLogical({
        routerModelId: null,
        routerRecoveryModelId: null,
        logicalModelIds,
        deploymentIds,
    });
    assert.equal(empty.ok, true);
});

test("a logical score cell is not copied onto a deployment that lacks its own evidence", () => {
    const shared = projectDeploymentScores({
        entries: [{ modelId: "deepseek-v4-pro", providerId: "deepseek" }],
        bindings: [
            { logicalModelId: "deepseek-v4-pro", deploymentId: "dep_deepinfra_pro", hasOwnEvidence: false },
            { logicalModelId: "deepseek-v4-pro", deploymentId: "dep_together_pro", hasOwnEvidence: false },
        ],
    });
    assert.equal(shared.ok, true);
    if (!shared.ok) return;
    assert.deepEqual(
        shared.cells.map((cell) => cell.kind),
        ["abstain", "abstain"]
    );
    assert.equal(shared.cells.every((cell) => cell.reason === "shared_without_evidence"), true);

    const oneSided = projectDeploymentScores({
        entries: [{ modelId: "deepseek-v4-pro", providerId: "deepseek" }],
        bindings: [
            { logicalModelId: "deepseek-v4-pro", deploymentId: "dep_deepinfra_pro", hasOwnEvidence: true },
            { logicalModelId: "deepseek-v4-pro", deploymentId: "dep_together_pro", hasOwnEvidence: false },
        ],
    });
    assert.equal(oneSided.ok, true);
    if (!oneSided.ok) return;
    assert.deepEqual(oneSided.cells, [
        { kind: "deployment", logicalModelId: "deepseek-v4-pro", deploymentId: "dep_deepinfra_pro" },
        {
            kind: "abstain",
            logicalModelId: "deepseek-v4-pro",
            deploymentId: "dep_together_pro",
            reason: "missing_evidence",
        },
    ]);
});

test("no binding abstains, and the provider id is not turned into a deployment", () => {
    const projected = projectDeploymentScores({
        entries: [{ modelId: "kimi-k3", providerId: "moonshot" }],
        bindings: [],
    });
    assert.deepEqual(projected, {
        ok: true,
        cells: [{ kind: "abstain", logicalModelId: "kimi-k3", deploymentId: null, reason: "no_binding" }],
    });
    assert.equal(
        projectDeploymentScores({
            entries: [
                { modelId: "kimi-k3", providerId: "moonshot" },
                { modelId: "kimi-k3", providerId: "deepinfra" },
            ],
            bindings: [],
        }).reason,
        "duplicate_logical"
    );
    assert.equal(
        projectDeploymentScores({
            entries: [{ modelId: "", providerId: "moonshot" }],
            bindings: [],
        }).reason,
        "blank_model"
    );
    assert.equal(
        projectDeploymentScores({
            entries: [{ modelId: "kimi-k3", providerId: "moonshot" }],
            bindings: [{ logicalModelId: "kimi-k3", deploymentId: "", hasOwnEvidence: true }],
        }).reason,
        "blank_deployment"
    );
});

test("shadow match does not select a model, and abstention is not agreement", () => {
    const match = compareGrainShadow({
        logicalOrder: ["deepseek-v4-pro", "kimi-k3"],
        cells: [
            { kind: "deployment", logicalModelId: "deepseek-v4-pro", deploymentId: "dep_deepinfra_pro" },
            { kind: "deployment", logicalModelId: "kimi-k3", deploymentId: "dep_together_kimi" },
        ],
    });
    assert.deepEqual(match, { kind: "match" });
    assert.equal("selectedModelId" in match, false);

    assert.deepEqual(
        compareGrainShadow({
            logicalOrder: ["deepseek-v4-pro", "kimi-k3"],
            cells: [
                { kind: "deployment", logicalModelId: "kimi-k3", deploymentId: "dep_together_kimi" },
                { kind: "deployment", logicalModelId: "deepseek-v4-pro", deploymentId: "dep_deepinfra_pro" },
            ],
        }),
        { kind: "diverge" }
    );
    assert.deepEqual(
        compareGrainShadow({
            logicalOrder: ["deepseek-v4-pro"],
            cells: [
                { kind: "deployment", logicalModelId: "deepseek-v4-pro", deploymentId: "dep_a" },
                {
                    kind: "abstain",
                    logicalModelId: "deepseek-v4-pro",
                    deploymentId: "dep_b",
                    reason: "missing_evidence",
                },
            ],
        }),
        { kind: "inconclusive", reason: "abstained" }
    );
    assert.equal(
        compareGrainShadow({
            logicalOrder: [],
            cells: [],
        }).reason,
        "empty"
    );
    assert.equal(
        compareGrainShadow({
            logicalOrder: ["deepseek-v4-pro"],
            cells: [
                { kind: "deployment", logicalModelId: "deepseek-v4-pro", deploymentId: "dep_a" },
                { kind: "deployment", logicalModelId: "deepseek-v4-pro", deploymentId: "dep_b" },
            ],
        }).reason,
        "unpaired"
    );
});

test("the request path does not import the grain resolver", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                if (name === "node_modules" || name === ".next") continue;
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "routingStickyGrain.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (source.includes("routingStickyGrain") || source.includes("readStickyAsLogical") || source.includes("projectDeploymentScores") || source.includes("compareGrainShadow")) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});

test("the resolver does not write rows or rewrite the catalogue snapshot", () => {
    const source = readFileSync("lib/routingStickyGrain.ts", "utf8");
    assert.doesNotMatch(source, /prisma|ROUTER_SCORE_SNAPSHOT|\bUPDATE\b/);
});
