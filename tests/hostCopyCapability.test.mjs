import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { hostCopyMaySubstitute } from "../lib/hostCopyCapability.ts";

const catalogue = {
    logicalModelId: "deepseek-v4-pro",
    maxOutputTokens: 128000,
    contextTokens: 1000000,
};

test("a host that meets both stated limits may substitute", () => {
    assert.deepEqual(
        hostCopyMaySubstitute({
            catalogue,
            host: {
                logicalModelId: "deepseek-v4-pro",
                deploymentId: "dep_deepinfra",
                maxOutputTokens: 128000,
                contextTokens: 1000000,
            },
        }),
        { ok: true, logicalModelId: "deepseek-v4-pro", deploymentId: "dep_deepinfra" }
    );
});

test("a missing or shorter host limit is not the catalogue model", () => {
    assert.equal(
        hostCopyMaySubstitute({
            catalogue,
            host: {
                logicalModelId: "deepseek-v4-pro",
                deploymentId: "dep_deepinfra",
                maxOutputTokens: 16384,
                contextTokens: 1000000,
            },
        }).reason,
        "shorter_output"
    );
    assert.equal(
        hostCopyMaySubstitute({
            catalogue,
            host: {
                logicalModelId: "deepseek-v4-pro",
                deploymentId: "dep_deepinfra",
                maxOutputTokens: 128000,
                contextTokens: 524288,
            },
        }).reason,
        "shorter_context"
    );
    assert.equal(
        hostCopyMaySubstitute({
            catalogue,
            host: {
                logicalModelId: "deepseek-v4-pro",
                deploymentId: "dep_deepinfra",
                maxOutputTokens: null,
                contextTokens: 1000000,
            },
        }).reason,
        "unproven_output"
    );
    assert.equal(
        hostCopyMaySubstitute({
            catalogue,
            host: {
                logicalModelId: "kimi-k3",
                deploymentId: "dep_deepinfra",
                maxOutputTokens: 128000,
                contextTokens: 1000000,
            },
        }).reason,
        "different_model"
    );
    assert.equal(
        hostCopyMaySubstitute({
            catalogue,
            host: {
                logicalModelId: "deepseek-v4-pro",
                deploymentId: " ",
                maxOutputTokens: 128000,
                contextTokens: 1000000,
            },
        }).reason,
        "blank_deployment"
    );
    assert.equal(
        hostCopyMaySubstitute({
            catalogue: { ...catalogue, maxOutputTokens: 0 },
            host: {
                logicalModelId: "deepseek-v4-pro",
                deploymentId: "dep_deepinfra",
                maxOutputTokens: 128000,
                contextTokens: 1000000,
            },
        }).reason,
        "unusable_catalogue"
    );
});

test("the request path does not import the capability gate", () => {
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
            if (path === join("lib", "hostCopyCapability.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (source.includes("hostCopyCapability") || source.includes("hostCopyMaySubstitute")) hits.push(path);
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
