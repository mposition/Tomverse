import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/index.js";

const schema = {
    options: {
        verbose: { type: "boolean", short: "v" },
        out: { type: "string", short: "o" },
        level: { type: "string", default: "info" },
    },
};

test("long options, flags and positionals", () => {
    const { values, positionals } = parseArgs(["build", "--out", "dist", "--verbose", "src"], schema);
    assert.deepEqual(values, { level: "info", out: "dist", verbose: true });
    assert.deepEqual(positionals, ["build", "src"]);
});
