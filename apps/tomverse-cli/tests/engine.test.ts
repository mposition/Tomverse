/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, scriptedPrompter } from "./helpers.js";
import { DEFAULTS, GOAL_MAX_CONTINUATIONS, LIMIT_PROFILES, NO_LIMIT, isLimitProfile, resolveLimits } from "../src/runtime.js";
import { parseGoalVerdict, type Runner } from "../src/agent.js";

const isJudge = (body: any) => typeof body.messages?.[0]?.content === "string" && body.messages[0].content.startsWith("You judge whether");
const userTexts = (body: any): string[] => (body.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => String(m.content));

test("limit profiles: standard is the long-standing default, flags override a profile", () => {
    assert.deepEqual(LIMIT_PROFILES, ["standard", "extended", "unlimited"]);
    assert.ok(isLimitProfile("extended") && !isLimitProfile("fast"));
    const standard = resolveLimits();
    assert.equal(standard.maxRequests, DEFAULTS.maxRequests);
    assert.equal(standard.timeoutMs, DEFAULTS.timeoutMinutes * 60_000);
    assert.equal(standard.commandTimeoutMs, DEFAULTS.commandTimeoutSeconds * 1000);
    assert.equal(standard.profile, "standard");
    const extended = resolveLimits("extended");
    assert.deepEqual([extended.maxRequests, extended.timeoutMs], [200, 120 * 60_000]);
    const unlimited = resolveLimits("unlimited");
    assert.deepEqual([unlimited.maxRequests, unlimited.timeoutMs], [NO_LIMIT, NO_LIMIT]);
    assert.equal(JSON.parse(JSON.stringify(unlimited)).maxRequests, NO_LIMIT, "a saved task keeps the number");
    const mixed = resolveLimits("unlimited", { maxRequests: 7 });
    assert.deepEqual([mixed.maxRequests, mixed.timeoutMs], [7, NO_LIMIT]);
});

const readLoop = (count: number) => (body: any) => {
    const done = toolResultsSinceUser(body).length;
    return done < count ? { toolCalls: [{ name: "list_files", args: { path: "." } }] } : { text: "All read." };
};

test("standard stops at its request limit; unlimited runs past it and ends when the model is done", async () => {
    const gateway = await new FakeGateway({ script: readLoop(24) }).start();
    try {
        const root = makeRepo();
        const standard = await makeRunner(gateway, root, { limits: resolveLimits("standard"), prompter: null });
        assert.equal(await standard.runner.runTask("Look around."), "limit_reached");
        assert.equal(standard.journal.state.tasks[0]!.requests, DEFAULTS.maxRequests);
        const before = gateway.completions.length;
        const unlimited = await makeRunner(gateway, root, { limits: resolveLimits("unlimited"), prompter: null });
        assert.equal(await unlimited.runner.runTask("Look around."), "success");
        assert.equal(unlimited.journal.state.tasks[0]!.requests, 25);
        assert.equal(gateway.completions.length - before, 25);
        assert.equal(unlimited.journal.state.limits.profile, "unlimited");
    } finally {
        await gateway.stop();
    }
});

test("an unlimited task still stops when the user cancels", async () => {
    let runner: Runner | undefined;
    const gateway = await new FakeGateway({ script: (body, index) => {
        if (index === 3) runner!.cancel();
        return readLoop(1000)(body);
    } }).start();
    try {
        const made = await makeRunner(gateway, makeRepo(), { limits: resolveLimits("unlimited"), prompter: null });
        runner = made.runner;
        assert.equal(await runner.runTask("Look around forever."), "cancelled");
    } finally {
        await gateway.stop();
    }
});

test("the goal verdict is read from the first JSON object, and an unusable answer is null", () => {
    assert.deepEqual(parseGoalVerdict('Sure.\n{"met": false, "summary": "no test ran", "next": "run the tests"}'), { met: false, summary: "no test ran", next: "run the tests" });
    assert.deepEqual(parseGoalVerdict('{"met": true}'), { met: true, summary: "" });
    assert.equal(parseGoalVerdict("done"), null);
    assert.equal(parseGoalVerdict('{"met": "yes"}'), null);
});

test("goal mode: an unmet goal continues with the judge's next action, then stops when it is verified", async () => {
    let judged = 0;
    const gateway = await new FakeGateway({ script: (body) => {
        if (isJudge(body)) {
            judged += 1;
            return { text: judged === 1 ? '{"met": false, "summary": "No test was run.", "next": "Run the tests."}' : '{"met": true, "summary": "Tests ran and passed."}' };
        }
        return { text: userTexts(body).some((t) => t.startsWith("[Goal check 1/")) ? "Ran the tests: all pass." : "Changed the code." };
    } }).start();
    try {
        const made = await makeRunner(gateway, makeRepo(), { goal: { maxContinuations: GOAL_MAX_CONTINUATIONS }, prompter: scriptedPrompter([]) });
        const events: any[] = [];
        const original = made.runner["options"].output.event.bind(made.runner["options"].output);
        made.runner["options"].output.event = (event: any) => { events.push(event); original(event); };
        assert.equal(await made.runner.runTask("Make the change and verify it."), "success");
        const task = made.journal.state.tasks[0]!;
        assert.equal(task.goalContinuations, 1);
        assert.deepEqual(made.journal.state.generations.map((g) => g.purpose), ["agent", "goal", "agent", "goal"]);
        assert.equal(task.requests, 4);
        assert.deepEqual(task.goalChecks!.map((c) => c.met), [false, true]);
        const continuation = made.journal.state.messages.find((m) => typeof m.content === "string" && m.content.startsWith("[Goal check 1/"));
        assert.match(String(continuation?.content), /No test was run\.[\s\S]*Next: Run the tests\./);
        assert.deepEqual(events.filter((e) => e.type === "goal_check").map((e) => e.status), ["continue", "met"]);
        // The judge request carries no tools: it can only answer.
        assert.ok(gateway.completions.filter((c) => isJudge(c.body)).every((c) => !c.body.tools?.length));
    } finally {
        await gateway.stop();
    }
});

test("goal mode stops after its continuation cap and says the goal is not verified", async () => {
    const gateway = await new FakeGateway({ script: (body) =>
        isJudge(body) ? { text: '{"met": false, "summary": "Still unverified.", "next": "Try again."}' } : { text: "Working." } }).start();
    try {
        const made = await makeRunner(gateway, makeRepo(), { goal: { maxContinuations: 2 }, prompter: scriptedPrompter([]) });
        assert.equal(await made.runner.runTask("Do it."), "limit_reached");
        assert.equal(made.journal.state.tasks[0]!.goalContinuations, 2);
        assert.equal(made.journal.state.generations.filter((g) => g.purpose === "goal").length, 3);
        assert.match(made.journal.state.lastError ?? "", /not verified/);
    } finally {
        await gateway.stop();
    }
});

test("goal mode leaves the task as it is when the check is unusable, and does not run in a read-only session", async () => {
    const gateway = await new FakeGateway({ script: (body) => isJudge(body) ? { text: "I cannot say." } : { text: "Done." } }).start();
    try {
        const unclear = await makeRunner(gateway, makeRepo(), { goal: { maxContinuations: 3 } });
        assert.equal(await unclear.runner.runTask("Do it."), "success");
        assert.equal(unclear.journal.state.generations.filter((g) => g.purpose === "goal").length, 1);
        const before = gateway.completions.length;
        const readOnly = await makeRunner(gateway, makeRepo(), { goal: { maxContinuations: 3 }, readOnly: true });
        assert.equal(await readOnly.runner.runTask("Explain it."), "success");
        assert.equal(gateway.completions.length - before, 1, "no goal check without edits");
    } finally {
        await gateway.stop();
    }
});

test("goal mode does not widen approvals: a needed approval still waits for the user", async () => {
    const gateway = await new FakeGateway({ script: (body) => {
        if (isJudge(body)) return { text: '{"met": false, "summary": "Nothing changed.", "next": "Apply the change."}' };
        const results = toolResultsSinceUser(body);
        return userTexts(body).some((t) => t.startsWith("[Goal check")) && !results.length
            ? { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "return a - b;", new: "return a + b;" }] }] } }] }
            : { text: "Done." };
    } }).start();
    try {
        const root = makeRepo();
        const made = await makeRunner(gateway, root, { goal: { maxContinuations: 3 }, prompter: null });
        assert.equal(await made.runner.runTask("Fix sum."), "needs_approval");
        assert.equal(made.journal.state.pendingApprovals.length, 1);
        assert.equal(made.journal.state.changes.length, 0, "nothing was written without an answer");
    } finally {
        await gateway.stop();
    }
});

test("queued messages run in order after the model is done; edit, move and remove change what runs", async () => {
    let runner: Runner | undefined;
    const ids: string[] = [];
    const gateway = await new FakeGateway({ script: (body, index) => {
        if (index === 0) {
            ids.push(runner!.enqueue("first")!, runner!.enqueue("second")!, runner!.enqueue("third")!, runner!.enqueue("fourth")!);
            assert.ok(ids.every(Boolean));
            assert.ok(runner!.editQueued(ids[0]!, "first (edited)"));
            assert.ok(runner!.moveQueued(ids[2]!, -1));
            assert.ok(!runner!.moveQueued(ids[0]!, -1), "the first message cannot move earlier");
            assert.ok(runner!.removeQueued(ids[3]!));
            assert.ok(!runner!.removeQueued("q-missing"));
        }
        return { text: `reply ${index}` };
    } }).start();
    try {
        const made = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([]) });
        runner = made.runner;
        assert.equal(await runner.runTask("start"), "success");
        assert.equal(gateway.completions.length, 4);
        assert.deepEqual(userTexts(gateway.completions[3]!.body), ["start", "first (edited)", "third", "second"]);
        assert.deepEqual(made.journal.state.tasks[0]!.queued, []);
        assert.equal(made.journal.state.tasks[0]!.requests, 4);
    } finally {
        await gateway.stop();
    }
});

test("a message queued after the task ended is refused", async () => {
    const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
    try {
        const made = await makeRunner(gateway, makeRepo());
        assert.equal(made.runner.enqueue("early"), null, "no task yet");
        await made.runner.runTask("go");
        assert.equal(made.runner.enqueue("late"), null);
    } finally {
        await gateway.stop();
    }
});

test("steer goes in as a user message right before the next request, never between a tool call and its result", async () => {
    let runner: Runner | undefined;
    const gateway = await new FakeGateway({ script: (body, index) => {
        if (index === 0) {
            assert.ok(runner!.steer("Also check the README."));
            return { toolCalls: [{ name: "list_files", args: { path: "." } }] };
        }
        return { text: "ok" };
    } }).start();
    try {
        const made = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([]) });
        runner = made.runner;
        assert.equal(await runner.runTask("Look."), "success");
        const roles = (gateway.completions[1]!.body.messages as any[]).map((m) => m.role);
        const assistant = roles.lastIndexOf("assistant");
        assert.deepEqual(roles.slice(assistant), ["assistant", "tool", "user"]);
        assert.equal(userTexts(gateway.completions[1]!.body).at(-1), "Also check the README.");
        assert.ok(!runner.steer("late"), "nothing to steer once the task is over");
    } finally {
        await gateway.stop();
    }
});

test("a manual compaction of a finished task is one recorded request and keeps the tail of the history", async () => {
    const gateway = await new FakeGateway({ script: (body) =>
        typeof body.messages?.[0]?.content === "string" && body.messages[0].content.startsWith("You compress a coding session")
            ? { text: "The user asked to look around; the files were listed." } : { text: "All looked at." } }).start();
    try {
        const made = await makeRunner(gateway, makeRepo());
        assert.equal(await made.runner.maybeCompact(true), "skipped", "nothing to summarise before the first task");
        await made.runner.runTask("Look around.");
        assert.equal(await made.runner.maybeCompact(true), "compacted");
        assert.equal(made.journal.state.compactions.length, 1);
        assert.deepEqual(made.journal.state.generations.map((g) => g.purpose), ["agent", "compact"]);
        assert.match(String(made.journal.state.messages[0]!.content), /^Summary of the earlier part of this session/);
        assert.equal(made.journal.state.messages.at(-1)!.role, "assistant");
        assert.ok(made.journal.state.generations.every((g) => g.closed), "the summary request is settled in the same checkpoint");
    } finally {
        await gateway.stop();
    }
});
