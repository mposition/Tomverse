/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FakeGateway, TEST_KEY, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, scriptedPrompter } from "./helpers.js";
import type { ApprovalView } from "../src/agent.js";

/** The scripted model of a small bug fix: read, patch, run the test, report. */
const fixScript = (body: any) => {
    const results = toolResultsSinceUser(body);
    if (results.length === 0) return { text: "Reading sum.js.", toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
    if (results.length === 1)
        return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "return a - b;", new: "return a + b;" }] }], explanation: "sum should add" } }] };
    if (results.length === 2) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "test.js"] } }] };
    return { text: `Done: ${JSON.stringify(results.at(-1)).slice(0, 200)}` };
};

test("read -> approved patch -> approved test command -> report, over the real HTTP transport", async () => {
    const gateway = await new FakeGateway({ script: fixScript }).start();
    try {
        const root = makeRepo();
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([true, true], seen) });
        const outcome = await runner.runTask("Fix the failing test.");
        assert.equal(outcome, "success");
        assert.equal(readFileSync(join(root, "sum.js"), "utf8"), "export function sum(a, b) {\n  return a + b;\n}\n");
        // The user saw exactly one diff and one command, in order.
        assert.deepEqual(seen.map((v) => v.toolName), ["apply_patch", "run_command"]);
        assert.equal(seen[0]!.patch![0]!.path, "sum.js");
        assert.equal(seen[1]!.command!.mode, "argv");
        // The test really ran and passed.
        const command = journal.state.tools.find((t) => t.toolName === "run_command")!;
        assert.equal(command.state, "completed");
        assert.equal((command.output as { exitCode: number }).exitCode, 0);
        assert.match((command.output as { stdout: string }).stdout, /PASS/);

        // Wire: four generations, each POST /api/code/v1/chat/completions with its own
        // Idempotency-Key, the key only in Authorization, no retries.
        assert.equal(gateway.completions.length, 4);
        const keys = gateway.completions.map((c) => c.headers["idempotency-key"]);
        assert.equal(new Set(keys).size, 4, "a new Idempotency-Key per generation");
        for (const c of gateway.completions) {
            assert.equal(c.url, "/api/code/v1/chat/completions");
            assert.equal(c.headers.authorization, `Bearer ${TEST_KEY}`);
            assert.match(String(c.headers["user-agent"]), /^tomverse-cli\//);
            assert.equal(c.body.model, "fake-coder");
            assert.equal(c.body.stream, true);
            assert.ok(c.body.max_tokens <= 8000);
            assert.deepEqual(c.body.tools.map((t: any) => t.function.name).sort(), ["apply_patch", "list_files", "read_file", "run_command", "search_text"]);
        }
        // The journal holds the same keys, each recorded before its request.
        assert.deepEqual(journal.state.generations.map((g) => g.idempotencyKey), keys);
        assert.ok(journal.state.generations.every((g) => g.state === "complete" && g.requestId?.startsWith("req_")));
        assert.equal(journal.state.tasks[0]!.requests, 4);
        assert.equal(journal.state.changes.length, 1);
        assert.equal(journal.state.changes[0]!.state, "applied");
        assert.ok(!JSON.stringify(journal.state).includes(TEST_KEY.slice(13)), "the key secret is never in the journal");
    } finally {
        await gateway.stop();
    }
});

test("a denied patch changes nothing and the model is told", async () => {
    const gateway = await new FakeGateway({
        script: (body) => {
            const results = toolResultsSinceUser(body);
            if (results.length === 0) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "return a - b;", new: "return a + b;" }] }] } }] };
            return { text: `Understood: ${JSON.stringify(results[0]).slice(0, 300)}` };
        },
    }).start();
    try {
        const root = makeRepo();
        const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([false]) });
        assert.equal(await runner.runTask("Fix it."), "success");
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a - b/);
        assert.equal(journal.state.approvals[0]!.decision, "denied");
        assert.equal(journal.state.tools.length, 0, "nothing executed");
        const toolMessage = JSON.stringify(gateway.completions[1]!.body.messages.filter((m: any) => m.role === "tool"));
        assert.match(toolMessage, /declined|denied/i);
    } finally {
        await gateway.stop();
    }
});

test("read-only sessions offer no write or command tool at all", async () => {
    const gateway = await new FakeGateway({ script: () => ({ text: "I would change sum.js to add." }) }).start();
    try {
        const root = makeRepo();
        const { runner } = await makeRunner(gateway, root, { readOnly: true });
        assert.equal(await runner.runTask("What is wrong?"), "success");
        const names = gateway.completions[0]!.body.tools.map((t: any) => t.function.name).sort();
        assert.deepEqual(names, ["list_files", "read_file", "search_text"]);
        assert.match(gateway.completions[0]!.body.messages[0].content, /read-only/);
    } finally {
        await gateway.stop();
    }
});

test("without a terminal an approval stops the run as needs_approval; nothing is written", async () => {
    const gateway = await new FakeGateway({ script: fixScript }).start();
    try {
        const root = makeRepo();
        const { runner, journal } = await makeRunner(gateway, root, { prompter: null });
        assert.equal(await runner.runTask("Fix the failing test."), "needs_approval");
        assert.equal(journal.state.status, "needs_approval");
        assert.equal(journal.state.pendingApprovals.length, 1);
        assert.equal(journal.state.pendingApprovals[0]!.toolName, "apply_patch");
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a - b/);
        assert.equal(gateway.completions.length, 2);
    } finally {
        await gateway.stop();
    }
});

test("the chosen effort reaches every model call for a task and defaults on the next task", async () => {
    const gateway = await new FakeGateway({
        script: body => toolResultsSinceUser(body).length
            ? { text: "Done." }
            : { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] },
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { readOnly: true });
        assert.equal(await runner.runTask("Explain sum.js.", "high"), "success");
        assert.equal(journal.state.tasks[0].effort, "high");
        assert.deepEqual(gateway.completions.map(item => item.body.tomverse_effort), ["high", "high"]);
        assert.equal(await runner.runTask("Explain it again."), "success");
        assert.equal(gateway.completions.at(-1)?.body.tomverse_effort, undefined);
    } finally {
        await gateway.stop();
    }
});

test("effort unsupported by the model fails before journaling or sending a task", async () => {
    const gateway = await new FakeGateway({ script: () => ({ text: "unexpected request" }) }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { model: "fake-small" });
        await assert.rejects(runner.runTask("Explain sum.js.", "high"), /levels: default/);
        assert.equal(journal.state.tasks.length, 0);
        assert.equal(gateway.completions.length, 0);
    } finally {
        await gateway.stop();
    }
});
