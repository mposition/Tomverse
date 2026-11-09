import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { ADMIN_E2E_ENTRIES, NOT_VISITED, adminE2EScope } from "../scripts/admin-e2e-scope.mjs";
import { walk } from "../scripts/import-closure.mjs";

// Admin Console E2E builds and runs only when a change can reach what the
// suite exercises. See scripts/admin-e2e-scope.mjs.

const ROOT = resolve(import.meta.dirname, "..");
const runs = (...paths) => adminE2EScope(paths, ROOT).code;

test("no input, the schema, package files, configs and the workflow run the suite", () => {
    assert.equal(runs(), true);
    for (const path of [
        "prisma/schema.prisma",
        "prisma/migrations/20990101000000_x/migration.sql",
        "package-lock.json",
        "next.config.ts",
        "public/logo.svg",
        "scripts/ci/install-playwright.sh",
        "scripts/admin-e2e-scope.mjs",
        "scripts/import-closure.mjs",
        ".github/workflows/admin-console-e2e.yml",
        "app/(site)/(application)/layout.tsx",
    ]) {
        assert.equal(runs(path), true, path);
    }
});

test("the admin pages, their components and routes, and the suite run it", () => {
    for (const path of [
        "app/(site)/(application)/admin/layout.tsx",
        "app/api/admin/marketing/posts/route.ts",
        "app/(site)/(application)/auth/signin/page.tsx",
        "components/admin/AdminMarketingPanel.tsx",
        "tests/e2e-admin/marketing-console.spec.ts",
        "tests/e2e-admin/support/console.ts",
        "playwright.admin.config.ts",
        "scripts/run-admin-e2e.mjs",
        "proxy.ts",
    ]) {
        if (!existsSync(resolve(ROOT, path))) continue;
        assert.equal(runs(path), true, path);
    }
});

test("a marketing page, a docs change or a unit test skips it", () => {
    assert.equal(runs("app/(site)/(marketing)/pricing/page.tsx"), false);
    assert.equal(runs("components/marketing/PricingPageContent.tsx"), false);
    assert.equal(runs("docs/policy/marketing-automation.md", "tests/rustVendorScope.test.mjs"), false);
    assert.equal(runs("tests/e2e/chat.spec.ts"), false);
});

const specText = walk(ROOT, "tests/e2e-admin")
    .filter((file) => /\.ts$/.test(file))
    .map((file) => readFileSync(resolve(ROOT, file), "utf8"))
    .join("\n");

test("every page the specs open is under an entry", () => {
    // The entries name two auth pages rather than the whole auth tree; a spec
    // that opens a third must add it, or a change to it would skip the suite.
    const opened = new Set(
        [...specText.matchAll(/goto\(\s*[`"'](\/(?:admin|auth)\/[a-z0-9-]+)/g)].map((match) => match[1])
    );
    assert.ok(opened.size > 5, "the specs' navigations were found");
    for (const path of opened) {
        const page = `app/(site)/(application)${path}`;
        assert.ok(
            ADMIN_E2E_ENTRIES.some((entry) => page === entry || page.startsWith(`${entry}/`)),
            `${path} is opened by a spec but ${page} is not under an entry`
        );
    }
});

test("the pages left out are pages no spec opens", () => {
    assert.doesNotMatch(specText, /\/admin\/chat-e2e/);
    // The E04 fixture page lives on develop only; a selective release into main
    // carries the entry without the page, so there it matches nothing.
    if (!existsSync(resolve(ROOT, "app/(site)/(application)/admin/chat-e2e/page.tsx"))) return;
    for (const pattern of NOT_VISITED) {
        assert.ok(walk(ROOT, "app/(site)/(application)/admin").some((file) => pattern.test(file)), `${pattern} still matches a page`);
    }
});

test("the CLI prints code=true or code=false", () => {
    const run = (input, ...args) =>
        spawnSync(process.execPath, ["scripts/admin-e2e-scope.mjs", ...args], {
            cwd: ROOT,
            input,
            encoding: "utf8",
            env: { ...process.env, GITHUB_OUTPUT: "" },
        }).stdout.trim();
    assert.equal(run("", "--all"), "code=true");
    assert.equal(run("docs/policy/marketing-automation.md\n"), "code=false");
    assert.equal(run("components/admin/AdminMarketingPanel.tsx\n"), "code=true");
});
