import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PermissionsUsageError, permissionsCommand } from "../src/permission-cli.js";
import { tempDir } from "./helpers.js";

const run = async (home: string, root: string, args: string[], flags: Parameters<typeof permissionsCommand>[2] = {}, answer = true) => {
    const previous = process.env.TOMVERSE_HOME;
    process.env.TOMVERSE_HOME = home;
    const out: string[] = [];
    try {
        const code = await permissionsCommand(args, root, flags, { write: (text) => out.push(text), interactive: true, confirm: async () => answer });
        return { code, text: out.join("") };
    } finally {
        if (previous === undefined) delete process.env.TOMVERSE_HOME;
        else process.env.TOMVERSE_HOME = previous;
    }
};

test("permissions command: add, list and remove write the same files the Desktop screen edits", async () => {
    const home = tempDir("cli-home");
    const root = tempDir("cli-root");
    assert.equal((await run(home, root, ["add", "deny", "run_command", "rm -rf"])).code, 0);
    assert.equal((await run(home, root, ["add", "allow", "run_command", "npm test", "--exact"], { project: true, exact: true })).code, 0);
    assert.equal((await run(home, root, ["add", "deny", "run_command", "rm -rf"])).code, 1, "already there");
    assert.equal(JSON.parse(readFileSync(join(home, "permissions.json"), "utf8")).rules[0].pattern, "rm -rf");
    assert.equal(JSON.parse(readFileSync(join(root, ".tomverse", "permissions.json"), "utf8")).rules[0].exact, true);
    const listed = (await run(home, root, ["list"])).text;
    assert.match(listed, /deny run_command "rm -rf"/);
    assert.match(listed, /allow run_command "npm test" \(exact\)/);
    assert.equal((await run(home, root, ["remove", "deny", "run_command", "rm -rf"])).code, 0);
    await assert.rejects(run(home, root, ["add", "allow", "bash", "x"]), PermissionsUsageError);
    await assert.rejects(run(home, root, ["add", "maybe", "run_command", "x"]), PermissionsUsageError);
    await assert.rejects(run(home, root, ["frobnicate"]), PermissionsUsageError);
});

test("permissions trust: lists what a repository brought and applies it only after confirmation", async () => {
    const home = tempDir("cli-home");
    const root = tempDir("cli-root");
    mkdirSync(join(root, ".tomverse"));
    writeFileSync(join(root, ".tomverse", "permissions.json"), JSON.stringify({ version: 1, rules: [{ effect: "allow", tool: "run_command", pattern: "curl" }] }));
    assert.match((await run(home, root, ["list"])).text, /NOT applied/);
    const declined = await run(home, root, ["trust"], {}, false);
    assert.equal(declined.code, 4);
    assert.match(declined.text, /allow run_command "curl"/);
    assert.match((await run(home, root, ["list"])).text, /NOT applied/);
    assert.equal((await run(home, root, ["trust"])).code, 0);
    assert.doesNotMatch((await run(home, root, ["list"])).text, /NOT applied/);
    assert.equal((await run(home, root, ["trust"], { revoke: true })).code, 0);
    assert.match((await run(home, root, ["list"])).text, /NOT applied/);
});
