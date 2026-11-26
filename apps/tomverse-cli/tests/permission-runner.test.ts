/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, scriptedPrompter } from "./helpers.js";
import type { ApprovalView, Prompter } from "../src/agent.js";
import { PermissionGate, type PermissionMode, type ScopedRule } from "../src/permissions.js";

const isReview = (body: any) => JSON.stringify(body.messages?.[0] ?? "").includes("You review ONE action");
const create = (path: string) => ({ toolCalls: [{ name: "apply_patch", args: { edits: [{ path, action: "create", content: `${path}\n` }] } }] });
const gateFor = (mode: PermissionMode, rules: ScopedRule[] = []) => new PermissionGate({ mode, rules: () => rules });
const neverAsked: Prompter = { approve: async () => assert.fail("a person was asked"), confirm: async () => assert.fail("a person was asked") };

test("read-only mode refuses a change and a command without asking anyone, and says so to the model", async () => {
    const gateway = await new FakeGateway({
        script: (body) => {
            const n = toolResultsSinceUser(body).length;
            if (n === 0) return create("new.txt");
            if (n === 1) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "--version"] } }] };
            return { text: "done" };
        },
    }).start();
    try {
        const root = makeRepo();
        const { runner, journal } = await makeRunner(gateway, root, { prompter: neverAsked, runner: { permissions: gateFor("read_only") } });
        assert.equal(await runner.runTask("Add a file."), "success");
        assert.equal(existsSync(join(root, "new.txt")), false);
        assert.deepEqual(journal.state.approvals.map((a) => [a.toolName, a.decision, a.by, a.policy?.source]), [
            ["apply_patch", "denied", "permission_policy", "mode"],
            ["run_command", "denied", "permission_policy", "mode"],
        ]);
        assert.equal(journal.state.tools.filter((t) => t.state === "completed").length, 0, "nothing ran");
    } finally {
        await gateway.stop();
    }
});

test("allow-all runs ordinary work without asking, but a command that leaves the computer is still a person's call", async () => {
    const gateway = await new FakeGateway({
        script: (body) => {
            const n = toolResultsSinceUser(body).length;
            if (n === 0) return create("a.txt");
            if (n === 1) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "--version"] } }] };
            if (n === 2) return { toolCalls: [{ name: "run_command", args: { argv: ["git", "push", "origin", "main"] } }] };
            return { text: "done" };
        },
    }).start();
    try {
        const root = makeRepo();
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([false], seen), runner: { permissions: gateFor("allow_all") } });
        assert.equal(await runner.runTask("Add a file and push."), "success");
        assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a.txt\n");
        assert.equal(seen.length, 1, "only the push reached a person");
        assert.match(seen[0]!.command!.display, /git push/);
        assert.deepEqual(journal.state.approvals.map((a) => [a.toolName, a.decision, a.by ?? null]), [
            ["apply_patch", "approved", "permission_policy"],
            ["run_command", "approved", "permission_policy"],
            ["run_command", "denied", null],
        ]);
    } finally {
        await gateway.stop();
    }
});

test("a deny rule refuses a command that allow-all would run", async () => {
    const gateway = await new FakeGateway({
        script: (body) => (toolResultsSinceUser(body).length === 0
            ? { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "--version"] } }] } : { text: "done" }),
    }).start();
    try {
        const root = makeRepo();
        const rules: ScopedRule[] = [{ effect: "deny", tool: "run_command", pattern: "--version", scope: "project" }];
        const { runner, journal } = await makeRunner(gateway, root, { prompter: neverAsked, runner: { permissions: gateFor("allow_all", rules) } });
        await runner.runTask("Print the version.");
        assert.equal(journal.state.approvals[0]?.decision, "denied");
        assert.equal(journal.state.approvals[0]?.policy?.source, "deny_rule");
        assert.equal(journal.state.tools.some((t) => t.toolName === "run_command" && t.state === "completed"), false);
    } finally {
        await gateway.stop();
    }
});

test("auto review: a separate recorded model request judges each approval; three denials in a row hand the fourth to a person", async () => {
    const reviews: string[] = ["deny", "deny", "deny"];
    const reviewBodies: any[] = [];
    const gateway = await new FakeGateway({
        script: (body) => {
            if (isReview(body)) {
                reviewBodies.push(body);
                return { text: JSON.stringify({ verdict: reviews.shift() ?? "allow", reason: "scripted" }) };
            }
            const n = toolResultsSinceUser(body).length;
            return n < 4 ? create(`n${n}.txt`) : { text: "done" };
        },
    }).start();
    try {
        const root = makeRepo();
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([true], seen), runner: { permissions: gateFor("auto_review") } });
        assert.equal(await runner.runTask("Add four files."), "success");
        for (const name of ["n0.txt", "n1.txt", "n2.txt"]) assert.equal(existsSync(join(root, name)), false, `${name} was declined by the review`);
        assert.equal(existsSync(join(root, "n3.txt")), true, "the fourth was approved by the person");
        assert.equal(seen.length, 1);
        assert.deepEqual(journal.state.approvals.map((a) => [a.decision, a.by ?? null, a.policy?.source ?? null]), [
            ["denied", "permission_policy", "auto_review"],
            ["denied", "permission_policy", "auto_review"],
            ["denied", "permission_policy", "auto_review"],
            ["approved", null, null],
        ]);
        // The review requests are ordinary recorded requests of the task, and carry the action as JSON data.
        assert.equal(journal.state.generations.filter((g) => g.purpose === "review").length, 3);
        assert.equal(reviewBodies.length, 3);
        assert.equal(reviewBodies[0].messages.length, 2);
        assert.equal(reviewBodies[0].tools, undefined, "the reviewer is given no tools");
        assert.equal(JSON.parse(reviewBodies[0].messages[1].content).proposedAction.tool, "apply_patch");
        assert.equal(journal.unresolvedGenerations().length, 0);
    } finally {
        await gateway.stop();
    }
});

test("auto review: an allowed action runs; an unreadable answer or a failed request asks the person", async () => {
    const answers: Array<string | { fault: "http"; status: number; code: string }> = [
        JSON.stringify({ verdict: "allow", reason: "adds the requested file" }),
        "Looks fine to me!",
        { fault: "http", status: 500, code: "upstream_error" },
    ];
    const gateway = await new FakeGateway({
        script: (body) => {
            if (isReview(body)) {
                const next = answers.shift()!;
                return typeof next === "string" ? { text: next } : next;
            }
            const n = toolResultsSinceUser(body).length;
            return n < 3 ? create(`m${n}.txt`) : { text: "done" };
        },
    }).start();
    try {
        const root = makeRepo();
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([true, false], seen), runner: { permissions: gateFor("auto_review") } });
        await runner.runTask("Add three files.");
        assert.equal(existsSync(join(root, "m0.txt")), true, "allowed by the review");
        assert.equal(existsSync(join(root, "m1.txt")), true, "an unreadable answer: the person said yes");
        assert.equal(existsSync(join(root, "m2.txt")), false, "a failed review request: the person said no");
        assert.equal(seen.length, 2);
        assert.deepEqual(journal.state.approvals.map((a) => [a.decision, a.by ?? null]), [["approved", "permission_policy"], ["approved", null], ["denied", null]]);
    } finally {
        await gateway.stop();
    }
});
