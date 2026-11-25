/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { reconcile, SUBAGENT_LIMITS, undoChange } from "../src/runtime.js";
import type { ApprovalView, Prompter } from "../src/agent.js";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, scriptedPrompter } from "./helpers.js";

const isSub = (body: any) => /subagent of Tomverse CLI/.test(String(body.messages?.[0]?.content));
const assignmentOf = (body: any) => String(body.messages.find((m: any) => m.role === "user")?.content);
const toolNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function.name);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A main agent that delegates once and then answers, and subagents that read one file and report. */
const delegating = (tasks: string[], kind = "explore", extra: { delay?: number; track?: { now: number; max: number } } = {}) => async (body: any) => {
    if (isSub(body)) {
        const track = extra.track;
        if (track) {
            track.now += 1;
            track.max = Math.max(track.max, track.now);
        }
        try {
            if (extra.delay) await wait(extra.delay);
            if (!body.messages.some((m: any) => m.role === "tool")) return { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
            return { text: `Report for "${assignmentOf(body)}": sum.js subtracts instead of adding.` };
        } finally {
            if (track) track.now -= 1;
        }
    }
    if (!toolResultsSinceUser(body).length) return { toolCalls: [{ name: "delegate", args: { kind, tasks } }] };
    return { text: "Both reports are in." };
};

const delegateResult = (gateway: FakeGateway) => {
    const last = gateway.completions.at(-1)!.body.messages.filter((m: any) => m.role === "tool").at(-1);
    return JSON.parse(last.content);
};

test("delegate is not offered unless the host turns subagents on", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
    try {
        const { runner } = await makeRunner(gateway, root);
        await runner.runTask("hello");
        assert.ok(!toolNames(gateway.completions[0]!.body).includes("delegate"));
        assert.doesNotMatch(JSON.stringify(gateway.completions[0]!.body.messages[0]), /delegate/);
    } finally {
        await gateway.stop();
    }
});

test("explore subagents run in parallel with a fresh read-only context, and only their reports come back", async () => {
    const root = makeRepo();
    const track = { now: 0, max: 0 };
    const gateway = await new FakeGateway({ script: delegating(["Where is sum defined?", "Which test covers it?"], "explore", { delay: 120, track }) }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, root, { runner: { subagents: true } });
        assert.equal(await runner.runTask("Look at the project, then tell me what is wrong."), "success");
        // The main agent sees the tool and is told when to use it.
        const first = gateway.completions[0]!.body;
        assert.ok(toolNames(first).includes("delegate"));
        assert.match(first.messages[0].content, /delegate gives self-contained work to subagents/);
        // The two runs overlapped.
        assert.ok(track.max >= 2 && track.max <= SUBAGENT_LIMITS.maxExplore, `max concurrent subagent requests: ${track.max}`);
        const subRequests = gateway.completions.filter((c) => isSub(c.body));
        assert.equal(subRequests.length, 4, "two runs of two requests each");
        for (const request of subRequests) {
            // A fresh context: the assignment is the only user message; no earlier conversation; no way to change anything or to delegate again.
            assert.equal(request.body.messages.filter((m: any) => m.role === "user").length, 1);
            assert.match(String(request.body.messages.find((m: any) => m.role === "user").content), /^(Where is sum defined\?|Which test covers it\?)$/);
            assert.deepEqual(toolNames(request.body).sort(), ["list_files", "read_file", "search_text"]);
        }
        // Only the reports reach the main conversation, marked as unverified.
        const result = delegateResult(gateway);
        assert.equal(result.status, "ok");
        assert.equal(result.unverified, true);
        assert.equal(result.results.length, 2);
        for (const run of result.results) {
            assert.equal(run.kind, "explore");
            assert.equal(run.status, "completed");
            assert.equal(run.requests, 2);
            assert.deepEqual(run.filesRead, ["sum.js"]);
            assert.match(run.report, /sum\.js subtracts instead of adding/);
        }
        const mainMessages = JSON.stringify(journal.state.messages);
        assert.ok(!mainMessages.includes("function sum"), "the file the subagents read never entered the main conversation");
        // The session records the runs and every request.
        assert.equal(journal.state.subagents?.length, 2);
        assert.deepEqual(journal.state.subagents!.map((r) => [r.kind, r.state, r.requests]), [["explore", "completed", 2], ["explore", "completed", 2]]);
        const generations = journal.state.generations;
        assert.equal(generations.length, 6, "two main requests and four subagent requests");
        assert.equal(generations.filter((g) => g.purpose === "subagent").length, 4);
        assert.ok(generations.filter((g) => g.purpose === "subagent").every((g) => g.subagentId && journal.state.subagents!.some((r) => r.id === g.subagentId)));
        assert.ok(generations.every((g) => g.closed), "every request is settled");
        // They count against the one request limit of the task.
        assert.equal(journal.state.tasks[0]!.requests, 6);
        assert.equal(journal.state.usage.requests, 6);
    } finally {
        await gateway.stop();
    }
});

test("subagents use the main model and effort; the call cannot pick another", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: delegating(["one"]) }).start();
    try {
        const { runner } = await makeRunner(gateway, root, { runner: { subagents: true } });
        await runner.runTask("go", "high");
        const models = new Set(gateway.completions.map((c) => c.body.model));
        assert.deepEqual([...models], ["fake-coder"]);
        for (const c of gateway.completions) assert.equal(c.body.tomverse_effort, "high");
        const schema = gateway.completions[0]!.body.tools.find((t: any) => t.function.name === "delegate").function.parameters;
        assert.deepEqual(Object.keys(schema.properties).sort(), ["kind", "tasks"], "no model or effort argument");
    } finally {
        await gateway.stop();
    }
});

test("a subagent cannot delegate again, and worker is not offered where nothing can be changed", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: delegating(["one"]) }).start();
    try {
        for (const options of [{ readOnly: true }, { prompter: null }, { taskPlan: "plan" as const }]) {
            gateway.completions.length = 0;
            const { runner } = await makeRunner(gateway, root, { ...options, runner: { subagents: true } });
            await runner.runTask("go");
            const schema = gateway.completions[0]!.body.tools.find((t: any) => t.function.name === "delegate").function.parameters;
            assert.deepEqual(schema.properties.kind.enum, ["explore"], JSON.stringify(options));
            for (const c of gateway.completions.filter((c) => isSub(c.body))) assert.ok(!toolNames(c.body).includes("delegate"));
        }
    } finally {
        await gateway.stop();
    }
});

test("a delegate call that asks for too many runs is refused, and a call that cannot fit the request limit starts nothing", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: delegating(["a", "b"]) }).start();
    try {
        // 4 requests in all: after the main agent's first one, 2 are left for two runs: less than the least worth starting.
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 4, runner: { subagents: true } });
        assert.equal(await runner.runTask("go"), "success");
        const result = delegateResult(gateway);
        assert.equal(result.status, "error");
        assert.match(result.error, /Not enough of this task's request limit/);
        assert.equal(gateway.completions.filter((c) => isSub(c.body)).length, 0);
        assert.equal(journal.state.subagents, undefined);
    } finally {
        await gateway.stop();
    }
    const tooMany = await new FakeGateway({ script: delegating(["a", "b", "c"]) }).start();
    try {
        const { runner, journal } = await makeRunner(tooMany, root, { runner: { subagents: true } });
        await runner.runTask("go");
        assert.equal(journal.state.subagents?.length, 3);
        assert.equal(SUBAGENT_LIMITS.maxExplore, 3);
    } finally {
        await tooMany.stop();
    }
});

test("the runs of a task share what is left of its request limit", async () => {
    const root = makeRepo();
    // The main agent keeps one request; the runs split the rest, each capped, and the last request of a capped run is its report.
    const gateway = await new FakeGateway({
        script: async (body) => {
            if (isSub(body)) {
                // Never says it is done: keeps reading until it is told to stop.
                if (/no more requests/.test(JSON.stringify(body.messages.at(-1)))) return { text: "Partial report." };
                return { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
            }
            if (!toolResultsSinceUser(body).length) return { toolCalls: [{ name: "delegate", args: { kind: "explore", tasks: ["endless"] } }] };
            return { text: "done" };
        },
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 8, runner: { subagents: true } });
        assert.equal(await runner.runTask("go"), "success");
        const subs = gateway.completions.filter((c) => isSub(c.body));
        // 8 - 1 (main) - 1 (kept for the main agent's answer) = 6 for the run.
        assert.equal(subs.length, 6);
        assert.deepEqual(toolNames(subs.at(-1)!.body), [], "the last request has no tools: it writes the report");
        const result = delegateResult(gateway);
        assert.equal(result.results[0].status, "completed");
        assert.match(result.results[0].report, /Partial report/);
        assert.equal(journal.state.tasks[0]!.requests, 8);
    } finally {
        await gateway.stop();
    }
});

test("stopping the task stops the subagents", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({
        script: (body) => {
            if (isSub(body)) return { fault: "hang" };
            return { toolCalls: [{ name: "delegate", args: { kind: "explore", tasks: ["slow one", "slow two"] } }] };
        },
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, root, { runner: { subagents: true } });
        const outcome = runner.runTask("go");
        const started = Date.now();
        while (gateway.completions.filter((c) => isSub(c.body)).length < 2 && Date.now() - started < 8000) await wait(20);
        assert.equal(gateway.completions.filter((c) => isSub(c.body)).length, 2, "both runs are waiting on the hung request");
        runner.cancel();
        assert.equal(await outcome, "cancelled");
        assert.deepEqual(journal.state.subagents!.map((r) => r.state), ["cancelled", "cancelled"]);
        assert.ok(journal.state.subagents!.every((r) => r.endedAt));
        // The held requests are not guessed at: they stay open for the user to look up.
        assert.equal(journal.state.tasks[0]!.status, "cancelled");
    } finally {
        await gateway.stop();
    }
});

test("a session that was cut off while a subagent ran tells the model its result is not known", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
    try {
        const first = await makeRunner(gateway, root, { runner: { subagents: true } });
        first.journal.state.subagents = [{ id: "sa-aaaaaa", toolCallId: "call_1", kind: "explore", task: "map the build", state: "running", requests: 1, startedAt: new Date().toISOString(), epoch: "old-epoch" }];
        assert.match(reconcile(first.journal).join("\n"), /Subagent sa-aaaaaa .* was running when the CLI stopped/);
        assert.equal(first.journal.state.subagents![0]!.state, "unknown");
        await first.runner.runTask("continue");
        assert.match(gateway.completions[0]!.body.messages[0].content, /never reported back.*sa-aaaaaa \(explore\): map the build/);
        assert.equal(first.journal.state.subagents![0]!.acknowledged, true);
        await first.runner.runTask("again");
        assert.doesNotMatch(gateway.completions.at(-1)!.body.messages[0].content, /never reported back/, "said once");
    } finally {
        await gateway.stop();
    }
});

const workerScript = (path: string) => async (body: any) => {
    if (isSub(body)) {
        if (!body.messages.some((m: any) => m.role === "tool")) {
            return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path, action: "update", replacements: [{ old: "a - b", new: "a + b" }] }], explanation: "fix the sum" } }] };
        }
        const answer = JSON.parse(body.messages.filter((m: any) => m.role === "tool").at(-1).content);
        return { text: answer.status === "denied" ? "I was not allowed to change it." : "Changed sum.js to add." };
    }
    if (!toolResultsSinceUser(body).length) return { toolCalls: [{ name: "delegate", args: { kind: "worker", tasks: ["Fix sum() in sum.js"] } }] };
    return { text: "The worker is done." };
};

test("a worker asks the same prompter as the main agent, and its change is recorded and can be undone", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: workerScript("sum.js") }).start();
    try {
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([true], seen), runner: { subagents: true } });
        assert.equal(await runner.runTask("Fix the failing sum."), "success");
        assert.equal(seen.length, 1, "one approval, through the main prompter");
        assert.equal(seen[0]!.toolName, "apply_patch");
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a \+ b/);
        const result = delegateResult(gateway);
        assert.equal(result.results[0].kind, "worker");
        assert.deepEqual(result.results[0].filesChanged, ["sum.js"]);
        assert.match(result.results[0].report, /Changed sum\.js/);
        // The change belongs to the session like any other, and so does the approval that allowed it.
        assert.equal(journal.state.changes.length, 1);
        assert.match(journal.state.changes[0]!.toolCallId, /^sa-[0-9a-f]{6}:/);
        assert.equal(journal.state.approvals.length, 1);
        assert.equal(journal.state.approvals[0]!.decision, "approved");
        assert.equal(journal.state.approvals[0]!.toolCallId, journal.state.changes[0]!.toolCallId);
        undoChange(journal, journal.state.changes[0]!.changeId);
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a - b/, "undo restores the file the worker changed");
        const workerRequests = gateway.completions.filter((c) => isSub(c.body));
        assert.deepEqual(toolNames(workerRequests[0]!.body).sort(), ["apply_patch", "list_files", "read_file", "run_command", "search_text"]);
    } finally {
        await gateway.stop();
    }
});

test("a worker whose change is declined changes nothing and reports it", async () => {
    const root = makeRepo();
    const before = readFileSync(join(root, "sum.js"), "utf8");
    const gateway = await new FakeGateway({ script: workerScript("sum.js") }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([false]), runner: { subagents: true } });
        assert.equal(await runner.runTask("Fix the failing sum."), "success");
        assert.equal(readFileSync(join(root, "sum.js"), "utf8"), before);
        assert.equal(journal.state.changes.length, 0);
        assert.equal(journal.state.approvals[0]!.decision, "denied");
        assert.match(delegateResult(gateway).results[0].report, /not allowed/);
    } finally {
        await gateway.stop();
    }
});

test("a worker cannot reach a credential file, whatever the person approves", async () => {
    const root = makeRepo({ ".env": "SECRET=1\n" });
    const gateway = await new FakeGateway({
        script: async (body) => {
            if (isSub(body)) {
                if (!body.messages.some((m: any) => m.role === "tool")) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: ".env", action: "create", content: "X=1\n" }] } }] };
                return { text: "Could not." };
            }
            if (!toolResultsSinceUser(body).length) return { toolCalls: [{ name: "delegate", args: { kind: "worker", tasks: ["write .env"] } }] };
            return { text: "done" };
        },
    }).start();
    try {
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([true, true], seen), runner: { subagents: true } });
        await runner.runTask("go");
        assert.equal(readFileSync(join(root, ".env"), "utf8"), "SECRET=1\n");
        assert.equal(journal.state.changes.length, 0);
        // The path check refuses before the person is even asked.
        assert.equal(seen.length, 0);
    } finally {
        await gateway.stop();
    }
});

test("only one worker runs at a time", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: workerScript("sum.js") }).start();
    try {
        let release!: () => void;
        const open = new Promise<void>((resolve) => { release = resolve; });
        let asked = false;
        const prompter: Prompter = { async approve() { asked = true; await open; return false; }, async confirm() { return false; } };
        const { runner, journal } = await makeRunner(gateway, root, { prompter, runner: { subagents: true } });
        journal.state.tasks.push({ prompt: "go", startedAt: new Date().toISOString(), requests: 0, activeMs: 0, allowance: 20, timeAllowanceMs: 900_000 });
        const delegate = runner.tools.delegate as any;
        const first = delegate.execute({ kind: "worker", tasks: ["first"] }, { toolCallId: "t1", messages: [] });
        const started = Date.now();
        while (!asked && Date.now() - started < 8000) await wait(20);
        assert.ok(asked, "the first worker waits for the person");
        const second = await delegate.execute({ kind: "worker", tasks: ["second"] }, { toolCallId: "t2", messages: [] });
        assert.equal(second.status, "error");
        assert.match(second.error, /already running/);
        release();
        assert.equal((await first).results[0].status, "completed");
        // Two workers in one call are refused outright.
        const pair = await delegate.execute({ kind: "worker", tasks: ["a", "b"] }, { toolCallId: "t3", messages: [] });
        assert.match(pair.error, /exactly one task/);
    } finally {
        await gateway.stop();
    }
});

test("the time a worker waits for an answer does not count as the task's active time", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: workerScript("sum.js") }).start();
    try {
        const slow: Prompter = {
            async approve() {
                await wait(900);
                return true;
            },
            async confirm() {
                return false;
            },
        };
        const { runner, journal } = await makeRunner(gateway, root, { prompter: slow, runner: { subagents: true } });
        assert.equal(await runner.runTask("Fix the failing sum."), "success");
        assert.ok(journal.state.tasks[0]!.activeMs < 700, `active ${journal.state.tasks[0]!.activeMs} ms while the person took 900 ms to answer`);
    } finally {
        await gateway.stop();
    }
});
