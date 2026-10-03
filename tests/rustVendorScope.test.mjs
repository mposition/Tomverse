import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import { vendorScope } from "../scripts/rust-vendor-scope.mjs";

// The vendored AMUX server runs only when a change can affect it, and nothing
// writes this lane's cache: the workflow can run on develop or main, so its
// cache-mode is read and GitHub refuses the write at the token. See the header
// of .github/workflows/orchestrator-rust.yml.

test("a change under vendor/amux runs the vendored server", () => {
    assert.equal(vendorScope(["lib/foo.ts", "vendor/amux/crates/amux-server/src/lib.rs"]).vendor, true);
    assert.equal(vendorScope(["vendor/amux/Cargo.lock"]).vendor, true);
});

test("a change to the lane, its scope script or the toolchain runs it", () => {
    for (const path of [
        ".github/workflows/orchestrator-rust.yml",
        "scripts/rust-vendor-scope.mjs",
        "rust-toolchain.toml",
        "rust-toolchain",
    ]) {
        assert.equal(vendorScope([path]).vendor, true, path);
    }
});

test("an unrelated change skips it", () => {
    assert.equal(
        vendorScope(["lib/chat.ts", "apps/tomverse-orchestrator/src/main.rs", "Cargo.lock", "docs/x.md"]).vendor,
        false
    );
    // A path that merely mentions the vendor directory elsewhere is not in it.
    assert.equal(vendorScope(["docs/vendor/amux-notes.md"]).vendor, false);
});

test("no input runs everything", () => {
    assert.equal(vendorScope([]).vendor, true);
    assert.equal(vendorScope(["", "  "]).vendor, true);
});

test("the CLI prints the output line for both answers", () => {
    const run = (input, ...args) =>
        spawnSync(process.execPath, ["scripts/rust-vendor-scope.mjs", ...args], {
            input,
            encoding: "utf8",
            env: { ...process.env, GITHUB_OUTPUT: "" },
        });
    assert.equal(run("lib/a.ts\n").stdout.trim(), "vendor=false");
    assert.equal(run("vendor/amux/x.rs\n").stdout.trim(), "vendor=true");
    assert.equal(run("", "--all").stdout.trim(), "vendor=true");
});

const workflow = parse(
    readFileSync(new URL("../.github/workflows/orchestrator-rust.yml", import.meta.url), "utf8")
);
const steps = workflow.jobs.workspace.steps;
const step = (name) => {
    const found = steps.find((candidate) => candidate.name === name);
    assert.ok(found, `step "${name}" exists`);
    return found;
};

test("every vendored step is gated on the scope decision", () => {
    const vendored = steps.filter((candidate) => candidate["working-directory"] === "vendor/amux");
    assert.equal(vendored.length, 3);
    for (const candidate of vendored) {
        assert.equal(candidate.if, "steps.scope.outputs.vendor == 'true'", candidate.name);
    }
});

test("the workspace build and test are never gated", () => {
    assert.equal(step("Build").if, undefined);
    assert.equal(step("Test").if, undefined);
});

test("the cache is restored and nothing in this lane saves one", () => {
    // #1990 saved on pushes to develop, because a ~3 GiB `target` per pull
    // request filled the repository's 10 GB budget and evicted develop's
    // entries. The audit's P1 forbids writing from a run that can land on main
    // or develop at all, since such an entry is restorable by every run that can
    // see that scope. The merge of the two resolved it by removing what the
    // dispute was about: `target` is no longer cached, only the downloaded
    // crates.
    //
    // P1a then took the write away at the token (`cache-mode: read`), and a
    // measured run proved it binds pull requests too -- "cache write denied:
    // token has no writable scopes". The save step could no longer reserve an
    // entry, so every run paid for the tar and got a warning; it is gone. This
    // asserts the absence, because a save step added back here would be dead on
    // arrival and would look like warming that works.
    const cacheSteps = steps.filter((s) => String(s.uses ?? "").startsWith("actions/cache"));
    assert.equal(cacheSteps.length, 1);
    assert.ok(cacheSteps[0].uses.startsWith("actions/cache/restore@"), cacheSteps[0].uses);
    assert.equal(workflow["cache-mode"], "read");
});

test("no cache step names the build output directory", () => {
    // `target` holds build-script binaries that cargo executes, with nothing
    // verifying them, and it is what made this cache both a poisoning path and
    // a budget problem. Removing it is the resolution; this keeps it removed.
    for (const candidate of steps.filter((s) => String(s.uses ?? "").startsWith("actions/cache"))) {
        const paths = String(candidate.with?.path ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        for (const path of paths) {
            assert.ok(
                !/(^|\/)target(\/|$)/.test(path),
                `${candidate.name} caches "${path}"`
            );
        }
    }
});
