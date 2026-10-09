import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

import { scriptsReachedByApp, uiScope } from "../scripts/pr-ui-scope.mjs";

// The browser checks (PR Fast Gate's build-and-e2e and ui-risk, Review
// Parity) run unless a pull request provably cannot change what the app
// renders. See scripts/pr-ui-scope.mjs.

const reached = scriptsReachedByApp(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const runs = (...paths) => uiScope(paths, reached).code;

test("paths outside the app skip the browser checks", () => {
    assert.equal(runs("docs/policy/x.md", ".github/audits/a.md", "README.md"), false);
    assert.equal(runs("tests/someUnit.test.mjs", "tests/client/a.test.tsx", "tests/integration/b.db.test.ts"), false);
    assert.equal(runs("vendor/amux/crates/x.rs", "apps/tomverse-orchestrator/src/main.rs", "Cargo.lock"), false);
    assert.equal(runs(".github/workflows/codeql.yml", "scripts/check-accent-tokens.mjs"), false);
});

test("anything the app is built from runs them", () => {
    for (const path of [
        "app/page.tsx",
        "components/chat/ChatInput.tsx",
        "lib/models.ts",
        "locales/ko.ts",
        "public/logo.svg",
        "prisma/schema.prisma",
        "package.json",
        "package-lock.json",
        "next.config.ts",
        "playwright.config.ts",
        "tests/e2e/chat.spec.ts",
        "tests/fixtures/x.json",
        "docs-not-really/x.md",
        "some/nested/README.md",
    ]) {
        assert.equal(runs(path), true, path);
    }
});

test("the workflows that hold these jobs run them", () => {
    assert.equal(runs(".github/workflows/pr-fast-gate.yml"), true);
    assert.equal(runs(".github/workflows/review-parity-shadow.yml"), true);
});

test("every scripts/ file the app imports is reached", () => {
    // Found here independently of the script: any app-tree import specifier
    // naming a scripts/ file. Which files these are differs between develop
    // and main, so the test reads the tree rather than naming them.
    const root = new URL("..", import.meta.url);
    const listed = execFileSync("git", ["ls-files", "app", "components", "lib", "locales"], {
        cwd: root,
        encoding: "utf8",
    })
        .split("\n")
        .filter((file) => /\.(m?[jt]sx?)$/.test(file));
    const imported = new Set();
    for (const file of listed) {
        const text = readFileSync(new URL(file, root), "utf8");
        for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']*scripts\/[^"']+)["']/g)) {
            imported.add(spec.replace(/^@\//, "").replace(/^(\.\.\/)+/, ""));
        }
    }
    for (const path of imported) {
        assert.ok(reached.has(path), `${path} is imported by the app but not reached`);
        assert.equal(runs(path), true, path);
    }
});

test("a scripts/ file the build or the e2e npm scripts run is reached", () => {
    for (const path of [
        "scripts/run-next-build.mjs",
        "scripts/run-next-build-core.mjs",
        "scripts/run-ui-risk-shard.mjs",
        "scripts/verify-smoke-coverage.mjs",
        "scripts/ci/install-playwright.sh",
    ]) {
        assert.ok(reached.has(path) || path.startsWith("scripts/ci/"), `${path} is reached`);
        assert.equal(runs(path), true, path);
    }
});

test("no input runs everything", () => {
    assert.equal(uiScope([], reached).code, true);
    assert.equal(uiScope(["", " "], reached).code, true);
});

const load = (name) =>
    parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));

test("each browser job decides with the script and gates its expensive steps on it", () => {
    const fastGate = load("pr-fast-gate.yml");
    const parity = load("review-parity-shadow.yml");
    for (const [label, job] of [
        ["build-and-e2e", fastGate.jobs["build-and-e2e"]],
        ["ui-risk", fastGate.jobs["ui-risk"]],
        ["review-parity", parity.jobs["review-parity"]],
    ]) {
        const scope = job.steps.find((step) => step.id === "scope");
        assert.ok(scope, `${label} has a scope step`);
        assert.match(scope.run, /node scripts\/pr-ui-scope\.mjs/, label);
        // Every fallback in the shell writes code=true itself.
        assert.equal((scope.run.match(/echo "code=true" >> "\$GITHUB_OUTPUT"/g) ?? []).length, 2, label);
        const gated = job.steps.filter((step) => step.if === "steps.scope.outputs.code == 'true'");
        assert.ok(gated.some((step) => /npm ci/.test(String(step.run))), `${label} gates the install`);
    }
});

test("the PR-commit secret scan stays on the required check's path", () => {
    const fastGate = load("pr-fast-gate.yml");
    const staticJob = fastGate.jobs["static-and-unit"];
    assert.ok(staticJob.steps.some((step) => String(step.uses).startsWith("gitleaks/gitleaks-action@")));
    assert.ok(fastGate.jobs["fast-gate"].needs.includes("static-and-unit"));
    assert.equal(fastGate.jobs["secret-scan"], undefined);
});
