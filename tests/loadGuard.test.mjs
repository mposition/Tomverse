import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    allocationHerds,
    guardedWeight,
    loadGuardPhasesChecked,
} from "../lib/loadGuard.ts";

const quiet = { capacitySaturated: false, deploymentLoaded: false };
const hot = { capacitySaturated: true, deploymentLoaded: false };

test("a quiet candidate keeps its weight and a hot one needs a caller decay", () => {
    assert.equal(guardedWeight(4, quiet, null), 4);
    assert.equal(guardedWeight(4, hot, 0.5), 2);
    assert.equal(guardedWeight(4, { capacitySaturated: false, deploymentLoaded: true }, 0.25), 1);
    assert.equal(guardedWeight(4, hot, null), null);
    assert.equal(guardedWeight(4, hot, 0), null);
    assert.equal(guardedWeight(4, hot, 1), null);
    assert.equal(guardedWeight(4, hot, 1.2), null);
    assert.equal(guardedWeight(-1, quiet, 0.5), null);
    assert.equal(guardedWeight(Number.NaN, hot, 0.5), null);
});

test("a decay leaves the hot weight positive", () => {
    const decayed = guardedWeight(0.4, hot, 0.1);
    assert.equal(typeof decayed, "number");
    assert.ok(decayed > 0);
});

test("moving every remaining share onto one provider is a herd", () => {
    const before = [
        { providerId: "deepinfra", weight: 0.6 },
        { providerId: "together", weight: 0.4 },
    ];
    assert.equal(
        allocationHerds(before, [
            { providerId: "deepinfra", weight: 0 },
            { providerId: "together", weight: 1 },
        ]),
        true
    );
    assert.equal(
        allocationHerds(before, [
            { providerId: "deepinfra", weight: 0.3 },
            { providerId: "together", weight: 0.4 },
        ]),
        false
    );
    assert.equal(
        allocationHerds(
            [{ providerId: "deepinfra", weight: 1 }],
            [{ providerId: "together", weight: 1 }]
        ),
        false
    );
    assert.equal(allocationHerds(before, [{ providerId: "deepinfra", weight: -1 }]), null);
});

test("both phases have to be named", () => {
    assert.equal(loadGuardPhasesChecked(["before_softmax", "after_softmax"]), true);
    assert.equal(loadGuardPhasesChecked(["before_softmax"]), false);
    assert.equal(loadGuardPhasesChecked(["after_softmax"]), false);
    assert.equal(loadGuardPhasesChecked([]), false);
});

test("the request path does not import the load guard", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "loadGuard.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (source.includes("loadGuard") || source.includes("guardedWeight")) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
