import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageError, parseArgs } from "../src/index.js";

const schema = {
    options: {
        verbose: { type: "boolean", short: "v" },
        quiet: { type: "boolean", short: "q" },
        out: { type: "string", short: "o" },
        count: { type: "number", short: "n" },
        tag: { type: "string", multiple: true },
        level: { type: "string", default: "info" },
    },
};
const fails = (argv, message) => assert.throws(() => parseArgs(argv, schema), (error) => error instanceof UsageError && error.message === message, argv.join(" "));

test("equals form", () => {
    assert.equal(parseArgs(["--out=a=b"], schema).values.out, "a=b");
    assert.equal(parseArgs(["--out="], schema).values.out, "");
});

test("negated booleans", () => {
    assert.equal(parseArgs(["--verbose", "--no-verbose"], schema).values.verbose, false);
    fails(["--no-out"], "option --no-out is not a boolean");
    fails(["--no-nothing"], "unknown option --no-nothing");
});

test("short options and combinations", () => {
    assert.deepEqual(parseArgs(["-v", "-o", "f"], schema).values, { level: "info", tag: [], verbose: true, out: "f" });
    assert.equal(parseArgs(["-ofile"], schema).values.out, "file");
    const combined = parseArgs(["-vq"], schema).values;
    assert.equal(combined.verbose, true);
    assert.equal(combined.quiet, true);
    const ending = parseArgs(["-vqo", "dir"], schema).values;
    assert.equal(ending.out, "dir");
    assert.equal(ending.verbose, true);
    assert.equal(parseArgs(["-vo=x"], schema).values.out, "=x");
});

test("double dash and a lone dash", () => {
    const { values, positionals } = parseArgs(["a", "--verbose", "--", "--out", "-x", "-"], schema);
    assert.equal(values.verbose, true);
    assert.equal(values.out, undefined);
    assert.deepEqual(positionals, ["a", "--out", "-x", "-"]);
    assert.deepEqual(parseArgs(["-", "b"], schema).positionals, ["-", "b"]);
});

test("multiple collects in order, single keeps the last", () => {
    assert.deepEqual(parseArgs(["--tag", "a", "--tag=b", "--tag", "c"], schema).values.tag, ["a", "b", "c"]);
    assert.deepEqual(parseArgs([], schema).values.tag, []);
    assert.equal(parseArgs(["--out", "a", "--out", "b"], schema).values.out, "b");
});

test("numbers", () => {
    assert.equal(parseArgs(["--count", "5"], schema).values.count, 5);
    assert.equal(parseArgs(["--count=-1"], schema).values.count, -1);
    assert.equal(parseArgs(["-n", "-2.5"], schema).values.count, -2.5);
    assert.equal(parseArgs(["-n3"], schema).values.count, 3);
    fails(["--count", "abc"], "option --count must be a number: abc");
    fails(["--count="], "option --count must be a number: ");
});

test("errors", () => {
    fails(["--nope"], "unknown option --nope");
    fails(["-z"], "unknown option -z");
    fails(["--out"], "option --out needs a value");
    fails(["--out", "--verbose"], "option --out needs a value");
    fails(["-o"], "option --out needs a value");
    fails(["--verbose=yes"], "option --verbose does not take a value");
    assert.equal(parseArgs(["--out=-x"], schema).values.out, "-x");
});

test("existing behaviour", () => {
    const { values, positionals } = parseArgs(["build", "--out", "dist", "--verbose", "src"], schema);
    assert.deepEqual(values, { level: "info", tag: [], out: "dist", verbose: true });
    assert.deepEqual(positionals, ["build", "src"]);
});
