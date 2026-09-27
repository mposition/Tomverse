import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    heldChunkIsCommitPoint,
    precommitBufferDecision,
} from "../lib/routingPrecommitBuffer.ts";

const chunkReadyAt = new Date("2026-09-23T00:00:00.000Z");

test("the first chunk stays withheld until the supplied instant", () => {
    const bufferMs = 40;
    assert.equal(
        precommitBufferDecision({
            bufferMs,
            chunkReadyAt,
            now: new Date(chunkReadyAt.getTime() + bufferMs - 1),
        }),
        "hold"
    );
    assert.equal(
        precommitBufferDecision({
            bufferMs,
            chunkReadyAt,
            now: new Date(chunkReadyAt.getTime() + bufferMs),
        }),
        "release"
    );
    assert.equal(heldChunkIsCommitPoint, false);
});

test("a missing duration or a bad clock is neither a flush nor a hold", () => {
    const now = new Date(chunkReadyAt.getTime() + 1);
    for (const bufferMs of [undefined, null, 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "40"]) {
        assert.equal(precommitBufferDecision({ bufferMs, chunkReadyAt, now }), "undecided");
    }
    assert.equal(precommitBufferDecision({ bufferMs: 40, chunkReadyAt: "now", now }), "undecided");
    assert.equal(precommitBufferDecision({ bufferMs: 40, chunkReadyAt, now: "now" }), "undecided");
});

test("the column is nullable, positive when present, and written by nobody", () => {
    const sql = readFileSync(
        "prisma/migrations/20260923460000_routing_precommit_buffer_dark/migration.sql",
        "utf8"
    );
    assert.match(sql, /ADD COLUMN "precommitBufferMs" INTEGER/);
    assert.doesNotMatch(sql, /DEFAULT/);
    assert.match(sql, /"precommitBufferMs" IS NULL OR "precommitBufferMs" > 0/);
    assert.doesNotMatch(sql, /\bUPDATE\b/i);
});

test("the request path does not import the buffer", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "routingPrecommitBuffer.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (
                source.includes("routingPrecommitBuffer") ||
                source.includes("precommitBufferDecision") ||
                source.includes("precommitBufferOpen") ||
                source.includes("precommitBufferMs")
            ) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
