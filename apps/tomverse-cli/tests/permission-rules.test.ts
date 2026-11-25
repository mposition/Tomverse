import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PermissionRuleStore, RuleFileError } from "../src/permission-rules.js";
import { PermissionGate, type PermissionRule } from "../src/permissions.js";
import { tempDir } from "./helpers.js";

const setup = () => {
    const home = tempDir("rules-home");
    const root = tempDir("rules-root");
    const env = { TOMVERSE_HOME: home } as NodeJS.ProcessEnv;
    return { home, root, env, store: new PermissionRuleStore({ root, env }) };
};
const writeProject = (root: string, rules: PermissionRule[]) => {
    mkdirSync(join(root, ".tomverse"), { recursive: true });
    writeFileSync(join(root, ".tomverse", "permissions.json"), JSON.stringify({ version: 1, rules }));
};
const allowTest: PermissionRule = { effect: "allow", tool: "run_command", pattern: "npm test" };
const denyRm: PermissionRule = { effect: "deny", tool: "run_command", pattern: "rm -rf" };
const askBuild: PermissionRule = { effect: "ask", tool: "run_command", pattern: "npm run build" };

test("rules are saved in the CLI's configuration folder (user) and in the project's .tomverse folder", () => {
    const { home, root, store } = setup();
    assert.deepEqual(store.list(), { user: [], project: [], trust: "not_needed", hasProject: true, problems: [] });
    assert.equal(store.add("user", denyRm), true);
    assert.equal(store.add("user", denyRm), false, "a rule is not added twice");
    assert.equal(store.add("project", askBuild), true);
    assert.equal(JSON.parse(readFileSync(join(home, "permissions.json"), "utf8")).rules.length, 1);
    assert.equal(JSON.parse(readFileSync(join(root, ".tomverse", "permissions.json"), "utf8")).version, 1);
    assert.deepEqual(store.list().user, [denyRm]);
    assert.equal(store.remove("user", denyRm), true);
    assert.equal(store.remove("user", denyRm), false);
    assert.deepEqual(store.list().user, []);
    assert.throws(() => store.add("user", { effect: "allow", tool: "run_command" }), RuleFileError);
    assert.throws(() => new PermissionRuleStore({ root: null, env: { TOMVERSE_HOME: home } }).add("project", askBuild), /Open a project folder/);
});

test("merge: user and project rules are one list, with the scope kept", () => {
    const { root, store } = setup();
    store.add("user", denyRm);
    writeProject(root, [askBuild]);
    assert.deepEqual(store.effective(), [{ ...denyRm, scope: "user" }, { ...askBuild, scope: "project" }]);
});

test("a repository's allow rules do not apply until the user trusts the project; its deny and ask rules apply at once", () => {
    const { root, home, store } = setup();
    writeProject(root, [allowTest, denyRm, askBuild]);
    assert.equal(store.trust(), "untrusted");
    assert.deepEqual(store.effective().map((r) => r.effect), ["deny", "ask"], "the allow rule is held back");
    // The gate, as the agent sees it: the allow rule does nothing yet.
    const view = {
        approvalId: "a", toolCallId: "t", toolName: "run_command", input: { argv: ["npm", "test"] }, root,
        command: { mode: "argv" as const, file: "/usr/bin/npm", args: ["test"], display: "npm test", shell: null, cwd: root, timeoutMs: 1000, envNames: [] },
    };
    const ctx = { review: async () => "", userRequest: "" };
    const gate = () => new PermissionGate({ mode: "ask", rules: () => store.effective() });
    return gate().decide(view, ctx).then(async (before) => {
        assert.equal(before.kind, "human");
        store.trustProject();
        assert.equal(store.trust(), "trusted");
        assert.equal((await gate().decide(view, ctx)).kind, "allow");
        // The trust is kept outside the repository, and only for these allow rules.
        assert.ok(JSON.parse(readFileSync(join(home, "permission-trust.json"), "utf8")).projects);
        assert.doesNotMatch(readFileSync(join(root, ".tomverse", "permissions.json"), "utf8"), /trust/i);
        // A pull that adds another allow rule asks again.
        writeProject(root, [allowTest, denyRm, askBuild, { effect: "allow", tool: "run_command", pattern: "curl" }]);
        assert.equal(store.trust(), "changed");
        assert.equal((await gate().decide(view, ctx)).kind, "human");
        store.untrustProject();
        assert.equal(store.trust(), "untrusted");
    });
});

test("a rule the user adds keeps the trust they had; rules that came with the repository stay unconfirmed", () => {
    const { root, store } = setup();
    // A project with no allow rules: adding one through the app is the user's own act.
    store.add("project", askBuild);
    store.add("project", allowTest);
    assert.equal(store.trust(), "trusted");
    store.remove("project", allowTest);
    assert.equal(store.trust(), "not_needed");
    // A project that came with an unconfirmed allow rule: the user's addition does not confirm it.
    writeProject(root, [{ effect: "allow", tool: "run_command", pattern: "curl" }]);
    assert.equal(store.trust(), "untrusted");
    store.add("project", denyRm);
    store.add("project", allowTest);
    assert.equal(store.trust(), "untrusted");
    assert.deepEqual(store.effective().map((r) => r.effect), ["deny"]);
});

test("a rules file that cannot be read is reported, never read as empty, and the gate asks about everything", async () => {
    const { root, home, store } = setup();
    mkdirSync(join(root, ".tomverse"), { recursive: true });
    writeFileSync(join(root, ".tomverse", "permissions.json"), "{ not json");
    assert.throws(() => store.effective(), /not valid JSON/);
    assert.equal(store.list().problems.length, 1);
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ version: 1, rules: [{ effect: "allow", tool: "bash", pattern: "x" }] }));
    assert.throws(() => store.read("user"), /tool must be/);
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ version: 2, rules: [] }));
    assert.throws(() => store.read("user"), /not a permission rules file/);
    const gate = new PermissionGate({ mode: "allow_all", rules: () => store.effective() });
    const view = {
        approvalId: "a", toolCallId: "t", toolName: "run_command", input: { argv: ["npm", "test"] }, root,
        command: { mode: "argv" as const, file: "/usr/bin/npm", args: ["test"], display: "npm test", shell: null, cwd: root, timeoutMs: 1000, envNames: [] },
    };
    assert.equal((await gate.decide(view, { review: async () => "", userRequest: "" })).kind, "human");
});

test("a rules file that is a link is not followed", { skip: process.platform === "win32" }, async () => {
    const { root, home, store } = setup();
    const { symlinkSync } = await import("node:fs");
    writeFileSync(join(home, "elsewhere.json"), JSON.stringify({ version: 1, rules: [] }));
    mkdirSync(join(root, ".tomverse"), { recursive: true });
    symlinkSync(join(home, "elsewhere.json"), join(root, ".tomverse", "permissions.json"));
    assert.throws(() => store.read("project"), /regular file/);
});

test("an 'always' answer on an approval card is saved as a project allow rule that later approvals use", async () => {
    const { root, store } = setup();
    const { ApprovalMemory } = await import("../src/approvals.js");
    const command = (display: string, args: string[]) => ({
        approvalId: "a", toolCallId: "t", toolName: "run_command", input: { argv: display.split(" ") }, root,
        command: { mode: "argv" as const, file: `/usr/bin/${display.split(" ")[0]}`, args, display, shell: null, cwd: root, timeoutMs: 1000, envNames: [] },
    });
    const memory = new ApprovalMemory((rule) => { store.add("project", rule); });
    assert.equal(memory.remember(command("npm test", ["test"])), "same_command");
    assert.deepEqual(store.list().project, [{ effect: "allow", tool: "run_command", pattern: "npm test", exact: true }]);
    assert.equal(store.trust(), "trusted", "the person's own answer needs no second confirmation");
    const ctx = { review: async () => "", userRequest: "" };
    const gate = new PermissionGate({ mode: "ask", rules: () => store.effective() });
    assert.equal((await gate.decide(command("npm test", ["test"]), ctx)).kind, "allow", "a new session finds the saved rule");
    assert.equal((await gate.decide(command("npm test --watch", ["test", "--watch"]), ctx)).kind, "human", "only that exact command");
    // An action that leaves the app is never saved as a rule.
    assert.equal(memory.remember(command("git push", ["push"])), null);
    assert.equal(store.list().project.length, 1);
});
