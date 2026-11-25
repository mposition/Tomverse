/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FakeGateway, fixtureWorkAnalysis, TEST_KEY, toolResultsSinceUser } from "./fakeGateway.js";
import { captureOutput, makeRepo, makeRunner, scriptedPrompter } from "./helpers.js";
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

test("Desktop Agent keeps analysis read-only and only offers approved actions after publishing a work plan", async () => {
    const plannedPatch = { name: "apply_patch", args: {
        edits: [{ path: "sum.js", action: "update", replacements: [{ old: "return a - b;", new: "return a + b;" }] }],
    } };
    const gateway = await new FakeGateway({
        script(body, index) {
            const toolNames = body.tools.map((tool: any) => tool.function.name);
            if (index < 2) assert.deepEqual([...toolNames].sort(), ["list_files", "read_file", "search_text", "update_task_plan"]);
            if (index === 0) return { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
            if (index === 1) return { toolCalls: [{ name: "update_task_plan", args: {
                revision: 0, items: [{ id: "fix", title: "Correct the sum result" }], activeId: "fix",
                analysis: { ...fixtureWorkAnalysis, verifiedFacts: ["sum.js subtracts the two inputs."] },
            } }, plannedPatch] };
            if (index === 2) {
                assert.ok(toolNames.includes("apply_patch"));
                assert.match(JSON.stringify(body.messages), /read-only analysis|not available|not registered|denied|not found/i);
                return { toolCalls: [plannedPatch] };
            }
            return { text: "The sum now adds its two inputs." };
        },
    }).start();
    try {
        const root = makeRepo();
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { taskPlan: "agent", prompter: scriptedPrompter([true], seen) });
        assert.equal(await runner.runTask("The sum is wrong. Inspect and correct it."), "success");
        assert.equal(seen.length, 1);
        assert.equal(journal.state.changes.length, 1);
        assert.equal(journal.state.tasks[0]?.plan?.analysis?.verifiedFacts[0], "sum.js subtracts the two inputs.");
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a \+ b/);
        assert.equal(gateway.completions.length, 4);
    } finally {
        await gateway.stop();
    }
});

test("Desktop Agent can inspect an ambiguous request and ask before choosing work", async () => {
    const gateway = await new FakeGateway({
        script(body, index) {
            assert.deepEqual(body.tools.map((tool: any) => tool.function.name).sort(),
                ["list_files", "read_file", "search_text", "update_task_plan"]);
            assert.match(body.messages[0].content, /clarification field/);
            if (index === 0) return { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
            assert.match(JSON.stringify(toolResultsSinceUser(body)), /return a - b/);
            return { toolCalls: [{ name: "update_task_plan", args: {
                revision: 0, items: [], activeId: null, analysis: fixtureWorkAnalysis,
                clarification: "Should the function add the inputs or keep subtracting?",
            } }] };
        },
    }).start();
    try {
        const root = makeRepo();
        const seen: ApprovalView[] = [];
        const captured = captureOutput();
        const { runner, journal } = await makeRunner(gateway, root,
            { taskPlan: "agent", output: captured.output, prompter: scriptedPrompter([], seen) });
        assert.equal(await runner.runTask("The result looks wrong. Can you check it?"), "success");
        assert.match(captured.out.join(""), /Should the function add the inputs or keep subtracting\?/);
        assert.equal(gateway.completions.length, 2);
        assert.deepEqual(journal.state.tasks[0]?.plan?.items, []);
        assert.equal(journal.state.tasks[0]?.plan?.activeId, null);
        assert.equal(journal.state.tasks[0]?.plan?.clarification, "Should the function add the inputs or keep subtracting?");
        assert.deepEqual(journal.state.messages.at(-1), {
            role: "assistant", content: "Should the function add the inputs or keep subtracting?",
        });
        assert.equal(journal.state.tools.length, 0);
        assert.equal(seen.length, 0);
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /return a - b/);
    } finally {
        await gateway.stop();
    }
});

for (const mode of ["tool arguments", "assistant text"]) {
    test("A clarification keeps a denied tool response adjacent before resuming (" + mode + ")", async () => {
        const question = "Should the report include archived records?";
        const answer = "Include the archived records.";
        const rows = [{ id: "change", title: "Check the report" }];
        const gateway = await new FakeGateway({
            script(body, index) {
                if (index === 0) return { toolCalls: [{ name: "update_task_plan", args: {
                    revision: 0, items: rows, activeId: "change", analysis: fixtureWorkAnalysis,
                } }] };
                if (index === 1) return { ...(mode === "assistant text" ? { text: question } : {}), toolCalls: [
                    { name: "update_task_plan", args: { revision: 1, items: [], activeId: null,
                        analysis: fixtureWorkAnalysis, clarification: question } },
                    { name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update",
                        replacements: [{ old: "return a - b;", new: "return a + b;" }] }] } },
                ] };
                const transcript = JSON.stringify(body.messages);
                assert.ok(transcript.includes(question) && transcript.includes(answer));
                return { finish: "length", text: "I will check the archived records." };
            },
        }).start();
        try {
            const root = makeRepo();
            const seen: ApprovalView[] = [];
            const captured = captureOutput();
            const { runner, journal } = await makeRunner(gateway, root,
                { taskPlan: "agent", output: captured.output, prompter: scriptedPrompter([], seen) });
            assert.equal(await runner.runTask("Check the search report."), "success");
            assert.equal(gateway.completions.length, 2);
            assert.equal(seen.length, 0);
            assert.equal(journal.state.approvals.at(-1)?.decision, "denied");
            assert.match(readFileSync(join(root, "sum.js"), "utf8"), /return a - b/);
            const messages = journal.state.messages;
            const responseIndex = messages.findIndex((message) => message.role === "tool" &&
                message.content.some((part) => part.type === "tool-approval-response"));
            const questionIndex = messages.findIndex((message) => message.role === "assistant" && (
                typeof message.content === "string" ? message.content === question :
                message.content.some((part) => part.type === "text" && part.text === question)));
            assert.ok(responseIndex >= 0 && questionIndex >= 0);
            if (mode === "tool arguments") assert.equal(questionIndex, responseIndex + 1);
            else assert.ok(questionIndex < responseIndex);
            const denial = messages[responseIndex];
            assert.ok(denial?.role === "tool" && denial.content.some((part) =>
                part.type === "tool-result" && part.toolName === "apply_patch" && part.output.type === "execution-denied"));
            assert.equal(await runner.loop({ text: answer, confirmed() {} }), "success", captured.err.join("") + captured.out.join(""));
            assert.match(captured.err.join("") + captured.out.join(""), /reached the output limit/);
            assert.equal(gateway.completions.length, 3);
        } finally {
            await gateway.stop();
        }
    });
}

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
        assert.deepEqual(journal.state.generations.map(item => item.appliedEffort), ["high", "high"]);
        assert.equal(await runner.runTask("Explain it again."), "success");
        assert.equal(gateway.completions.at(-1)?.body.tomverse_effort, undefined);
    } finally {
        await gateway.stop();
    }
});

test("Smart Adaptive keeps its chosen model and records Default across tool calls", async () => {
    const gateway = await new FakeGateway({
        routedModel: "fake-small",
        script: body => toolResultsSinceUser(body).length
            ? { text: "Done." }
            : { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] },
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { model: "smart-adaptive", readOnly: true });
        assert.equal(await runner.runTask("Explain sum.js.", "high"), "success");
        assert.equal(journal.state.model.pinned, "fake-small");
        assert.deepEqual(gateway.completions.map(item => item.body.model), ["smart-adaptive", "fake-small"]);
        assert.deepEqual(journal.state.generations.map(item => item.appliedEffort), ["default", "default"]);
        assert.equal(journal.state.tasks[0].effort, "high");
    } finally {
        await gateway.stop();
    }
});
