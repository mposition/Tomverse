import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    heldChunkIsCommitPoint,
    precommitBufferOpen,
} from "../lib/routingPrecommitBuffer.ts";

const startedAt = new Date("2026-09-23T00:00:00.000Z");

test("the first chunk stays withheld until the supplied instant", () => {
    const bufferMs = 40;
    assert.equal(
        precommitBufferOpen({
            bufferMs,
            startedAt,
            now: new Date(startedAt.getTime() + bufferMs - 1),
        }),
        true
    );
    assert.equal(
        precommitBufferOpen({
            bufferMs,
            startedAt,
            now: new Date(startedAt.getTime() + bufferMs),
        }),
        false
    );
    assert.equal(heldChunkIsCommitPoint, false);
});

test("a missing duration or a bad clock is not a decision to flush or to hold", () => {
    const now = new Date(startedAt.getTime() + 1);
    for (const bufferMs of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "40"]) {
        assert.equal(precommitBufferOpen({ bufferMs, startedAt, now }), null);
    }
    assert.equal(precommitBufferOpen({ bufferMs: 40, startedAt: "now", now }), null);
    assert.equal(precommitBufferOpen({ bufferMs: 40, startedAt, now: "now" }), null);
});

test("the column is nullable, positive when present, and written by nobody", () => {
    const sql = readFileSync(
        "prisma/migrations/20260923460000_routing_precommit_buffer_dark/migration.sql",
        "utf8"
    );
    assert.match(sql, /ADD COLUMN "precommitBufferMs" INTEGER/);
    assert.doesNotMatch(sql, /DEFAULT/);
    assert.match(sql, /"precommitBufferMs" IS NULL OR "precommitBufferMs" > 0/);
    assert.doesNotMatch(sql, /UPDATE\s+"/i);
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
