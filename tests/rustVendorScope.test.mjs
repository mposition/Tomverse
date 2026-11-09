import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { vendorScope, workspaceScope } from "../scripts/rust-vendor-scope.mjs";

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
    const vendorLine = (result) => result.stdout.trim().split("\n")[0];
    assert.equal(vendorLine(run("lib/a.ts\n")), "vendor=false");
    assert.equal(vendorLine(run("vendor/amux/x.rs\n")), "vendor=true");
    assert.equal(run("", "--all").stdout.trim(), "vendor=true\nworkspace=true");
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

test("the workspace build and test are gated on the workspace decision", () => {
    assert.equal(step("Build").if, "steps.scope.outputs.workspace == 'true'");
    assert.equal(step("Test").if, "steps.scope.outputs.workspace == 'true'");
    // The job itself is never path-filtered: it is a required check.
    assert.equal(workflow.on.pull_request.paths, undefined);
    assert.equal(workflow.on.pull_request["paths-ignore"], undefined);
});

test("a change in the root workspace, its fixtures or its manifest runs it", () => {
    for (const path of [
        "crates/amux-core/src/lib.rs",
        "apps/tomverse-orchestrator/src/main.rs",
        "Cargo.toml",
        "Cargo.lock",
        "tests/fixtures/amux-routing-snapshot-v1.json",
        ".github/workflows/orchestrator-rust.yml",
        "scripts/rust-vendor-scope.mjs",
        "rust-toolchain.toml",
    ]) {
        assert.equal(workspaceScope(["docs/x.md", path]).workspace, true, path);
    }
});

test("a change with no Rust in it skips the root workspace", () => {
    assert.equal(workspaceScope(["lib/chat.ts", "docs/x.md", "vendor/amux/src/a.rs"]).workspace, false);
    assert.equal(workspaceScope(["tests/fixtures/chat-v1.json"]).workspace, false);
    assert.equal(workspaceScope([]).workspace, true);
});

test("every file the root workspace includes from outside its trees is a trigger", () => {
    // include_str!/include_bytes! of a repository file the triggers miss would
    // let a change to that file skip the tests that read it.
    const listed = spawnSync("git", ["ls-files", "crates", "apps/tomverse-orchestrator"], {
        encoding: "utf8",
    }).stdout.split("\n").filter((file) => file.endsWith(".rs"));
    assert.ok(listed.length > 0, "the workspace sources are listed");
    const outside = [];
    for (const file of listed) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
        for (const [, spec] of source.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"/g)) {
            const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
            if (workspaceScope([resolved]).workspace !== true) outside.push(`${file} -> ${resolved}`);
        }
    }
    assert.deepEqual(outside, []);
});

test("the CLI prints the workspace line too", () => {
    const run = (input) =>
        spawnSync(process.execPath, ["scripts/rust-vendor-scope.mjs"], {
            input,
            encoding: "utf8",
            env: { ...process.env, GITHUB_OUTPUT: "" },
        }).stdout.trim().split("\n");
    assert.deepEqual(run("lib/a.ts\n"), ["vendor=false", "workspace=false"]);
    assert.deepEqual(run("crates/amux-core/src/lib.rs\n"), ["vendor=false", "workspace=true"]);
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
