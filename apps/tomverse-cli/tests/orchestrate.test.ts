/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ApprovalView, Prompter } from "../src/agent.js";
import { discoverExtensions } from "../src/extensions.js";
import { normalizeOrchestration, ORCHESTRATION_DEFAULTS } from "../src/orchestrate-config.js";
import { parseScope, scopeContains, scopesOverlap, outsideScope } from "../src/orchestrate-scope.js";
import { parseVerdict, SubagentSlots } from "../src/orchestrate.js";
import { reconcile } from "../src/runtime.js";
import { Workspace } from "../src/workspace.js";
import { DEFAULT_MODELS, FakeGateway, toolResultsSinceUser, type ScriptedReply } from "./fakeGateway.js";
import { makeRepo, makeRunner, scriptedPrompter, tempDir } from "./helpers.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const systemOf = (body: any) => String(body.messages?.[0]?.content);
const roleOf = (body: any): "main" | "explore" | "worker" | "verify" => {
    const system = systemOf(body);
    if (/independent verifier of one subtask/.test(system)) return "verify";
    if (/worker subagent of Tomverse CLI/.test(system)) return "worker";
    if (/exploration subagent of Tomverse CLI/.test(system)) return "explore";
    return "main";
};
const assignmentOf = (body: any) => String(body.messages.find((m: any) => m.role === "user")?.content);
const toolNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function.name);
const hasTool = (body: any) => body.messages.some((m: any) => m.role === "tool");
const lastTool = (body: any) => JSON.parse(body.messages.filter((m: any) => m.role === "tool").at(-1).content);

/** A main agent that makes one delegate call and then answers; `sub` answers every subagent request. */
const orchestrated = (args: unknown, sub: (body: any, role: "explore" | "worker" | "verify", index: number) => ScriptedReply | Promise<ScriptedReply>) =>
    async (body: any, index: number): Promise<ScriptedReply> => {
        const role = roleOf(body);
        if (role !== "main") return sub(body, role, index);
        return toolResultsSinceUser(body).length ? { text: "All reported." } : { toolCalls: [{ name: "delegate", args }] };
    };

const delegateResult = (gateway: FakeGateway) => {
    const main = gateway.completions.filter((c) => roleOf(c.body) === "main").at(-1)!.body;
    return lastTool(main);
};
const limits = (maxSubagents: number, maxRequests: number) => ({ maxSubagents, maxRequests });
const patchSum = { name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "a - b", new: "a + b" }] }], explanation: "fix the sum" } };

/** The most subtasks that were ever in flight at once, from the first to the last request of each goal. */
const peak = (windows: Map<string, { start: number; end: number }>) => {
    const points = [...windows.values()].flatMap((w) => [[w.start, 1], [w.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0;
    let most = 0;
    for (const [, delta] of points) {
        now += delta;
        most = Math.max(most, now);
    }
    return most;
};
const clock = () => {
    const windows = new Map<string, { start: number; end: number }>();
    return {
        windows,
        async around<T>(goal: string, delay: number, reply: T): Promise<T> {
            const window = windows.get(goal) ?? { start: Date.now(), end: 0 };
            windows.set(goal, window);
            await wait(delay);
            window.end = Date.now();
            return reply;
        },
    };
};

/* ------------------------------------------------------------------ pure parts */

test("limits are clamped to what is allowed and default to three subagents", () => {
    assert.deepEqual(normalizeOrchestration(), ORCHESTRATION_DEFAULTS);
    assert.equal(ORCHESTRATION_DEFAULTS.maxSubagents, 3);
    assert.deepEqual(normalizeOrchestration({ maxSubagents: 99, maxRequests: 1 }), { maxSubagents: 6, maxRequests: 6 });
    assert.deepEqual(normalizeOrchestration({ maxSubagents: 2.7, maxRequests: Number.NaN }), { maxSubagents: 2, maxRequests: ORCHESTRATION_DEFAULTS.maxRequests });
});

test("a write scope names files and folders; overlap and containment are decided on resolved paths", () => {
    const root = makeRepo({ "src/a.js": "a", "src/b.js": "b", "docs/x.md": "x" });
    const workspace = new Workspace(root);
    const scope = (...paths: string[]) => {
        const parsed = parseScope(workspace, paths);
        assert.ok(parsed.ok, JSON.stringify(parsed));
        return parsed.scope;
    };
    assert.deepEqual(scope("src", "./src/a.js", "docs/"), ["src", "docs"], "a folder covers what is inside it");
    assert.ok(scopeContains(["src"], "src/a.js") && scopeContains(["src"], "src"));
    assert.ok(!scopeContains(["src"], "srcs/a.js") && !scopeContains(["src/a.js"], "src/b.js"));
    assert.ok(scopeContains(["."], "anything/at/all.txt"));
    assert.ok(scopesOverlap(["src"], ["src/a.js"]) && scopesOverlap(["."], ["docs"]) && !scopesOverlap(["src"], ["docs"]));
    for (const bad of [[], ["src/*.js"], ["../outside"], [".env"], [".git/config"]]) assert.equal(parseScope(workspace, bad).ok, false, JSON.stringify(bad));
    const inside = outsideScope(workspace, ["src"], [{ path: "src/a.js" }, { path: "src/new/file.js" }]);
    assert.deepEqual(inside, { outside: [] });
    assert.deepEqual(outsideScope(workspace, ["src"], [{ path: "docs/x.md" }, { path: "./src/../sum.js" }]).outside, ["docs/x.md", "sum.js"]);
    assert.ok(outsideScope(workspace, ["src"], [{ path: "../escape.txt" }]).error);
});

test("the verifier's answer is the first JSON object, and only a boolean verdict counts", () => {
    assert.deepEqual(parseVerdict('Looks fine.\n{"met": true, "reason": "ok"}'), { met: true, reason: "ok" });
    assert.equal(parseVerdict("no json here"), null);
    assert.equal(parseVerdict('{"met": "yes"}'), null);
    assert.equal(parseVerdict('{"reason": "missing met"}'), null);
});

test("the scheduler runs at most max at once, keeps overlapping scopes in order and lets a waiting one be stopped", async () => {
    const scheduler = new SubagentSlots(() => 2);
    const order: string[] = [];
    const live = new Set<string>();
    let most = 0;
    const job = async (id: string, scope: string[] | null, ms: number, signal = new AbortController().signal) => {
        await scheduler.acquire(id, scope, signal);
        live.add(id);
        most = Math.max(most, live.size);
        order.push(`start ${id}`);
        await wait(ms);
        live.delete(id);
        order.push(`end ${id}`);
        scheduler.release(id);
    };
    const stop = new AbortController();
    const stopped = job("w", null, 10, stop.signal).catch(() => "stopped");
    await Promise.all([job("a", ["src"], 60), job("b", ["src/x.js"], 10), job("c", ["docs"], 30), job("d", null, 10)]);
    assert.ok(most <= 2, `at most 2 at once, saw ${most}`);
    assert.ok(order.indexOf("end a") < order.indexOf("start b"), "b overlaps a, so it starts after a ends");
    await stopped;
    // A subtask waiting for a slot can be stopped without ever starting.
    const full = new SubagentSlots(() => 1);
    await full.acquire("first", null, new AbortController().signal);
    const waiting = new AbortController();
    const second = full.acquire("second", null, waiting.signal);
    waiting.abort(new Error("Stopped by the user."));
    await assert.rejects(second, /Stopped by the user/);
    assert.equal(full.waiting, 0);
    full.release("first");
});

/* ------------------------------------------------------------------ in the agent */

test("orchestration is off by default: delegate takes no subtasks", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
    try {
        const { runner } = await makeRunner(gateway, root, { runner: { subagents: true } });
        await runner.runTask("go");
        const schema = gateway.completions[0]!.body.tools.find((t: any) => t.function.name === "delegate").function.parameters;
        assert.deepEqual(Object.keys(schema.properties).sort(), ["kind", "tasks"]);
        assert.doesNotMatch(systemOf(gateway.completions[0]!.body), /Orchestration is on/);
    } finally {
        await gateway.stop();
    }
});

test("subtasks run in parallel up to the limit, and each comes back as one summary", async () => {
    const root = makeRepo();
    const time = clock();
    const subtasks = [1, 2, 3, 4, 5].map((n) => ({ title: `Look ${n}`, goal: `GOAL-${n}: where is sum defined?` }));
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks }, async (body) => time.around(assignmentOf(body), 70, hasTool(body) ? { text: `Report ${assignmentOf(body).slice(0, 6)}: in sum.js` } : { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] })),
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 100, orchestrate: limits(2, 90), runner: { subagents: true } });
        assert.equal(await runner.runTask("Investigate"), "success");
        assert.equal(peak(time.windows), 2, "two at once, never more");
        const result = delegateResult(gateway);
        assert.equal(result.status, "ok");
        assert.deepEqual(result.orchestration.maxSubagents, 2);
        assert.equal(result.results.length, 5);
        for (const [index, row] of result.results.entries()) {
            assert.equal(row.status, "success");
            assert.equal(row.title, `Look ${index + 1}`);
            assert.equal(row.kind, "explore");
            assert.equal(row.verification.state, "skipped", "no criteria, so not verified");
            assert.match(row.report, new RegExp(`Report GOAL-${index + 1}`));
            assert.equal(row.requests, 2);
        }
        assert.equal(result.orchestration.requestsUsed, 10);
        assert.deepEqual(journal.state.subtasks!.map((record) => record.state), Array(5).fill("success"));
        // Every request is the main agent's or a subagent's, in the one task limit.
        assert.equal(journal.state.tasks[0]!.requests, 12);
        assert.ok(journal.state.generations.every((generation) => generation.closed));
        // The main agent is told how orchestration works.
        assert.match(systemOf(gateway.completions[0]!.body), /Orchestration is on \(up to 2 subagents at once, 90 requests in all\)/);
    } finally {
        await gateway.stop();
    }
});

test("a worker cannot change a file outside its scope: the edit is refused before anyone is asked, and it has no command tool", async () => {
    const root = makeRepo();
    const before = readFileSync(join(root, "test.js"), "utf8");
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks: [{ title: "Fix sum", goal: "Fix sum()", paths: ["sum.js"] }] }, (body) => {
            const results = body.messages.filter((m: any) => m.role === "tool").length;
            if (results === 0) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "test.js", action: "update", replacements: [{ old: "PASS", new: "FAKE" }] }] } }] };
            if (results === 1) return { toolCalls: [patchSum] };
            return { text: "Fixed sum.js; test.js is not mine." };
        }),
    }).start();
    try {
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 50, orchestrate: limits(3, 60), prompter: scriptedPrompter([true], seen), runner: { subagents: true } });
        assert.equal(await runner.runTask("Fix the failing sum."), "success");
        assert.equal(readFileSync(join(root, "test.js"), "utf8"), before, "the file outside the scope is untouched");
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a \+ b/);
        // The refused edit was never put to the person; the one inside the scope was, and says whose it is.
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0]!.patch!.map((edit) => edit.path), ["sum.js"]);
        assert.match(seen[0]!.origin!.id, /^st-[0-9a-f]{6}$/);
        assert.equal(seen[0]!.origin!.title, "Fix sum");
        const worker = gateway.completions.find((c) => roleOf(c.body) === "worker")!.body;
        assert.deepEqual(toolNames(worker).sort(), ["apply_patch", "list_files", "read_file", "search_text"]);
        assert.match(systemOf(worker), /Your write scope is limited to: sum\.js/);
        const second = gateway.completions.filter((c) => roleOf(c.body) === "worker")[1]!.body;
        assert.equal(lastTool(second).status, "denied");
        assert.match(lastTool(second).error, /Outside this subtask's write scope \(sum\.js\): test\.js/);
        const row = delegateResult(gateway).results[0];
        assert.deepEqual(row.filesChanged, ["sum.js"]);
        assert.equal(row.status, "success");
        assert.deepEqual(journal.state.changes.map((change) => change.path), ["sum.js"]);
    } finally {
        await gateway.stop();
    }
});

test("workers with overlapping scopes run one after the other, in order; disjoint workers run together", async () => {
    const root = makeRepo({ "src/a.js": "a\n", "src/b.js": "b\n", "docs/x.md": "x\n" });
    const time = clock();
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks: [
            { title: "A", goal: "GOAL-A", paths: ["src"] },
            { title: "B", goal: "GOAL-B", paths: ["src/b.js"] },
            { title: "C", goal: "GOAL-C", paths: ["docs"] },
        ] }, async (body) => time.around(assignmentOf(body), 90, { text: `done ${assignmentOf(body)}` })),
    }).start();
    try {
        const { runner } = await makeRunner(gateway, root, { maxRequests: 50, orchestrate: limits(3, 60), runner: { subagents: true } });
        assert.equal(await runner.runTask("go"), "success");
        const a = time.windows.get("GOAL-A")!;
        const b = time.windows.get("GOAL-B")!;
        const c = time.windows.get("GOAL-C")!;
        assert.ok(b.start >= a.end, "B overlaps A, so it waited for it");
        assert.ok(c.start < a.end && c.end > a.start, "C is disjoint and ran with A");
        const rows = delegateResult(gateway).results;
        assert.deepEqual(rows.map((row: any) => row.status), ["success", "success", "success"]);
        assert.deepEqual(rows[1].ranAfter, [rows[0].id]);
        assert.equal(rows[0].ranAfter, undefined);
    } finally {
        await gateway.stop();
    }
});

test("a finished subtask is checked against its criteria; a failed one goes back once with the reason, and then it is reported", async () => {
    const root = makeRepo();
    const verdicts = ['no json at all', '{"met": false, "reason": "sum() still subtracts when b is negative"}', '{"met": true, "reason": "sum() adds"}'];
    const work: string[] = [];
    let verifierRuns = 0;
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks: [{ title: "Fix sum", goal: "Fix sum()", paths: ["sum.js"], done_when: "sum(2,3) is 5" }] }, (body, role) => {
            if (role === "verify") {
                // The verifier reads first, then answers with the next scripted text; an answer that is not a verdict is asked for again.
                if (!hasTool(body)) return { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
                verifierRuns += 1;
                return { text: verdicts.shift()! };
            }
            if (!hasTool(body)) work.push(assignmentOf(body));
            if (!hasTool(body) && work.length === 1) return { toolCalls: [patchSum] };
            return { text: work.length === 1 ? "Changed sum.js." : "Looked again; handled negative b." };
        }),
    }).start();
    try {
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 80, orchestrate: limits(3, 80), prompter: scriptedPrompter([true], seen), runner: { subagents: true } });
        assert.equal(await runner.runTask("Fix sum"), "success");
        const row = delegateResult(gateway).results[0];
        assert.equal(row.status, "success");
        assert.equal(row.attempts, 2);
        assert.equal(row.verification.state, "passed");
        assert.equal(work.length, 2, "worked twice");
        assert.match(work[1]!, /sum\(\) still subtracts when b is negative/, "the retry is told what was found");
        assert.match(work[1]!, /Done when: sum\(2,3\) is 5/);
        assert.equal(verifierRuns, 3, "the invalid answer was asked for again, then two verdicts");
        // The verifier only reads.
        const verifier = gateway.completions.find((c) => roleOf(c.body) === "verify")!.body;
        assert.deepEqual(toolNames(verifier).sort(), ["list_files", "read_file", "search_text"]);
        assert.match(assignmentOf(verifier), /Completion criteria:\nsum\(2,3\) is 5/);
        // Runs are told apart in the session: work, verification and the retry.
        assert.deepEqual(journal.state.subagents!.map((run) => `${run.role}${run.attempt}`), ["work1", "verify1", "verify1", "work2", "verify2"]);
        assert.equal(journal.state.subtasks![0]!.runIds.length, 5);
    } finally {
        await gateway.stop();
    }
});

test("a subtask that still fails after its one retry is reported as failed, and nothing is tried a third time", async () => {
    const root = makeRepo();
    let works = 0;
    let verifies = 0;
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks: [{ title: "Fix", goal: "Fix it", done_when: "it is fixed" }] }, (body, role) => {
            if (role === "verify") {
                verifies += 1;
                return { text: '{"met": false, "reason": "nothing was fixed"}' };
            }
            works += 1;
            return { text: "I think it is fixed." };
        }),
    }).start();
    try {
        const { runner } = await makeRunner(gateway, root, { maxRequests: 80, orchestrate: limits(3, 80), runner: { subagents: true } });
        assert.equal(await runner.runTask("go"), "success");
        const result = delegateResult(gateway);
        assert.equal(result.status, "error");
        assert.equal(result.results[0].status, "failed");
        assert.equal(result.results[0].attempts, 2);
        assert.equal(result.results[0].verification.state, "failed");
        assert.match(result.results[0].reason, /Verification failed: nothing was fixed/);
        assert.deepEqual([works, verifies], [2, 2]);
    } finally {
        await gateway.stop();
    }
});

test("a declared check command runs through the approval path, and a failing check cannot be overruled by the verifier", async () => {
    const root = makeRepo();
    let verifierCalls = 0;
    let works = 0;
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks: [{ title: "Fix sum", goal: "Fix sum()", paths: ["sum.js"], done_when: "the tests pass", check: { argv: [process.execPath, "test.js"] } }] }, (body, role) => {
            if (role === "verify") {
                verifierCalls += 1;
                return hasTool(body) ? { text: '{"met": true, "reason": "tests pass"}' } : { toolCalls: [{ name: "read_file", args: { path: "test.js" } }] };
            }
            works += 1;
            // The first attempt changes nothing and claims success; the retry fixes it.
            if (works === 1) return { text: "Done, everything passes." };
            return hasTool(body) ? { text: "Fixed." } : { toolCalls: [patchSum] };
        }),
    }).start();
    try {
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 80, orchestrate: limits(3, 80), prompter: scriptedPrompter([true, true, true], seen), runner: { subagents: true } });
        assert.equal(await runner.runTask("Fix sum"), "success");
        const row = delegateResult(gateway).results[0];
        assert.equal(row.status, "success");
        assert.equal(row.attempts, 2);
        assert.deepEqual(row.verification, { state: "passed", check: "passed", reason: "tests pass" });
        // First check failed on its own, with no verifier call; after the retry the check passed and the verifier agreed.
        assert.equal(verifierCalls, 2, "one verification, two requests: read, then verdict");
        assert.deepEqual(seen.map((view) => view.toolName), ["run_command", "apply_patch", "run_command"]);
        assert.ok(seen.every((view) => view.origin?.title === "Fix sum"));
        assert.match(seen[0]!.command!.display, /test\.js/);
        const retry = gateway.completions.filter((c) => roleOf(c.body) === "worker").map((c) => assignmentOf(c.body)).at(-1)!;
        assert.match(retry, /The check command .* failed with exit code 1/);
        assert.match(retry, /FAIL sum\(2,3\)=-1/, "the end of the output is handed back");
        assert.ok(journal.state.approvals.every((approval) => approval.decision === "approved"));
    } finally {
        await gateway.stop();
    }
});

test("a check command the person declines is not run, and the subtask is reported as unverified, not retried", async () => {
    const root = makeRepo();
    let works = 0;
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks: [{ title: "Run tests", goal: "Look at it", done_when: "tests pass", check: { argv: [process.execPath, "test.js"] } }] }, (body, role) => {
            if (role === "verify") return { text: '{"met": true, "reason": "x"}' };
            works += 1;
            return { text: "Looked." };
        }),
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 80, orchestrate: limits(3, 80), prompter: scriptedPrompter([false]), runner: { subagents: true } });
        await runner.runTask("go");
        const row = delegateResult(gateway).results[0];
        assert.equal(row.status, "failed");
        assert.equal(row.attempts, 1);
        assert.equal(row.verification.state, "unverified");
        assert.equal(row.verification.check, "denied");
        assert.equal(works, 1);
        assert.equal(gateway.completions.filter((c) => roleOf(c.body) === "verify").length, 0, "no verdict is asked for without the evidence");
        assert.equal(journal.state.tools.filter((tool) => tool.toolName === "run_command").length, 0);
    } finally {
        await gateway.stop();
    }
});

test("the subtasks share the request budget: later ones that do not fit are rejected, and the total never passes the limit", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks: [1, 2, 3, 4].map((n) => ({ title: `T${n}`, goal: `G${n}`, done_when: "reported" })) }, (body, role) => {
            if (role === "verify") return { text: '{"met": true, "reason": "ok"}' };
            return { text: "report" };
        }),
    }).start();
    try {
        // 12 requests for everything; a verified subtask needs at least 7, so one fits and the rest are turned away.
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 100, orchestrate: limits(3, 12), runner: { subagents: true } });
        await runner.runTask("go");
        const result = delegateResult(gateway);
        assert.deepEqual(result.results.map((row: any) => row.status), ["success", "rejected", "rejected", "rejected"]);
        assert.match(result.results[1].reason, /request budget/);
        assert.ok(result.orchestration.requestsUsed <= 12);
        assert.deepEqual(journal.state.subtasks!.map((record) => record.state), ["success", "rejected", "rejected", "rejected"]);
    } finally {
        await gateway.stop();
    }
});

test("a runaway subtask is held to its slice of both the orchestration budget and the task's own limit", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks: [{ title: "One", goal: "one" }, { title: "Two", goal: "two" }] }, (body) => {
            if (/no more requests/.test(JSON.stringify(body.messages.at(-1)))) return { text: "Partial report." };
            return { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] };
        }),
    }).start();
    try {
        // The task allows 9 requests: 1 for the first main step, 1 kept for the last, 7 for the two subtasks -> 3 each.
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 9, orchestrate: limits(3, 90), runner: { subagents: true } });
        assert.equal(await runner.runTask("go"), "success");
        const subs = gateway.completions.filter((c) => roleOf(c.body) !== "main");
        assert.equal(subs.length, 6);
        assert.ok(journal.state.tasks[0]!.requests <= 9);
        const rows = delegateResult(gateway).results;
        assert.deepEqual(rows.map((row: any) => [row.status, row.requests]), [["success", 3], ["success", 3]]);
    } finally {
        await gateway.stop();
    }
});

test("workers asking at the same time are asked one at a time, each saying which subtask it is", async () => {
    const root = makeRepo({ "docs/x.md": "x\n" });
    let asking = 0;
    let mostAsking = 0;
    const seen: ApprovalView[] = [];
    const prompter: Prompter = {
        async approve(view) {
            seen.push(view);
            asking += 1;
            mostAsking = Math.max(mostAsking, asking);
            await wait(80);
            asking -= 1;
            return true;
        },
        async confirm() {
            return false;
        },
    };
    const gateway = await new FakeGateway({
        script: orchestrated({ subtasks: [
            { title: "Fix sum", goal: "Fix sum", paths: ["sum.js"] },
            { title: "Write docs", goal: "Write docs", paths: ["docs"] },
        ] }, (body) => {
            if (hasTool(body)) return { text: "Done." };
            return { toolCalls: [/Fix sum/.test(assignmentOf(body)) ? patchSum : { name: "apply_patch", args: { edits: [{ path: "docs/y.md", action: "create", content: "y\n" }] } }] };
        }),
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 50, orchestrate: limits(3, 60), prompter, runner: { subagents: true } });
        assert.equal(await runner.runTask("go"), "success");
        assert.equal(mostAsking, 1, "the person is asked one question at a time");
        assert.deepEqual(seen.map((view) => view.origin!.title).sort(), ["Fix sum", "Write docs"]);
        assert.deepEqual(delegateResult(gateway).results.map((row: any) => row.status), ["success", "success"]);
        assert.equal(journal.state.changes.length, 2);
    } finally {
        await gateway.stop();
    }
});

test("where nothing can change there are no worker subtasks, and a check command is refused; read-only subtasks still run", async () => {
    const root = makeRepo();
    const worker = { title: "Change", goal: "change it", kind: "worker", paths: ["sum.js"] };
    const checked = { title: "Look", goal: "look", check: { argv: [process.execPath, "test.js"] } };
    const gateway = await new FakeGateway({ script: () => ({ text: "Report." }) }).start();
    try {
        for (const [name, options] of [["read-only", { readOnly: true }], ["plan mode", { taskPlan: "plan" as const }], ["no one to approve", { prompter: null }]] as const) {
            const { runner, journal } = await makeRunner(gateway, root, { maxRequests: 50, orchestrate: limits(3, 60), runner: { subagents: true }, ...options });
            journal.state.tasks.push({ prompt: "go", startedAt: new Date().toISOString(), requests: 0, activeMs: 0, allowance: 50, timeAllowanceMs: 900_000 });
            const schema = (runner.tools.delegate as any).inputSchema;
            assert.ok(schema, name);
            const result = await (runner.tools.delegate as any).execute({ subtasks: [worker, checked, { title: "Read", goal: "read" }] }, { toolCallId: "t1", messages: [] });
            assert.deepEqual(result.results.map((row: any) => row.status), ["rejected", "rejected", "success"], name);
            assert.match(result.results[0].reason, /not available in this session/, name);
            assert.match(result.results[1].reason, /cannot run in this session/, name);
        }
        const toolSchema = gateway.completions.length;
        assert.equal(toolSchema, 3, "only the read-only subtask of each session made a request");
        // In an agent session before a work item is active, a worker is refused the same way the plain delegate refuses it.
        const planned = await makeRunner(gateway, root, { taskPlan: "agent", maxRequests: 50, orchestrate: limits(3, 60), runner: { subagents: true } });
        planned.journal.state.tasks.push({ prompt: "go", startedAt: new Date().toISOString(), requests: 0, activeMs: 0, allowance: 50, timeAllowanceMs: 900_000 });
        const refused = await (planned.runner.tools.delegate as any).execute({ subtasks: [worker] }, { toolCallId: "t2", messages: [] });
        assert.match(refused.results[0].reason, /read-only analysis/);
    } finally {
        await gateway.stop();
    }
});

test("stopping the task stops every subtask; stopping one leaves the others, and one failing leaves the others", async () => {
    const root = makeRepo();
    // Task stop: everything hangs.
    const hanging = await new FakeGateway({ script: orchestrated({ subtasks: [{ title: "A", goal: "A" }, { title: "B", goal: "B" }, { title: "C", goal: "C" }] }, () => ({ fault: "hang" })) }).start();
    try {
        const { runner, journal } = await makeRunner(hanging, root, { maxRequests: 50, orchestrate: limits(3, 60), runner: { subagents: true } });
        const outcome = runner.runTask("go");
        const started = Date.now();
        while (hanging.completions.filter((c) => roleOf(c.body) !== "main").length < 3 && Date.now() - started < 8000) await wait(20);
        runner.cancel();
        assert.equal(await outcome, "cancelled");
        assert.deepEqual(journal.state.subtasks!.map((record) => record.state), ["cancelled", "cancelled", "cancelled"]);
        assert.deepEqual(journal.state.subagents!.map((run) => run.state), ["cancelled", "cancelled", "cancelled"]);
    } finally {
        await hanging.stop();
    }
    // One is stopped on its own while the person has not answered about it; another fails on its own; the third finishes.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let asked = false;
    const prompter: Prompter = {
        async approve(view) {
            asked = true;
            await held;
            return view.origin?.title === "Stuck";
        },
        async confirm() {
            return false;
        },
    };
    const mixed = await new FakeGateway({
        script: orchestrated({ subtasks: [
            { title: "Stuck", goal: "STUCK", paths: ["sum.js"] },
            { title: "Broken", goal: "BROKEN" },
            { title: "Fine", goal: "FINE" },
        ] }, (body) => {
            const goal = assignmentOf(body);
            if (goal === "STUCK") return hasTool(body) ? { text: "Waited." } : { toolCalls: [patchSum] };
            if (goal === "BROKEN") return { fault: "http", status: 400, code: "invalid_request" };
            return { text: "Fine report." };
        }),
    }).start();
    try {
        const { runner, journal } = await makeRunner(mixed, root, { maxRequests: 50, orchestrate: limits(3, 60), prompter, runner: { subagents: true } });
        const outcome = runner.runTask("go");
        const started = Date.now();
        while ((!asked || !journal.state.subtasks?.some((record) => record.title === "Fine" && record.state === "success")) && Date.now() - started < 8000) await wait(20);
        const stuck = journal.state.subtasks!.find((record) => record.title === "Stuck")!;
        assert.equal(stuck.state, "running");
        assert.equal(runner.stopSubagents(stuck.id), 1);
        assert.equal(runner.stopSubagents(stuck.id), 0, "already stopped");
        release();
        assert.equal(await outcome, "success", "the main task goes on");
        const rows = delegateResult(mixed).results;
        assert.deepEqual(rows.map((row: any) => [row.title, row.status]), [["Stuck", "cancelled"], ["Broken", "failed"], ["Fine", "success"]]);
        assert.match(rows[0].reason, /Stopped by the user/);
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a - b/, "an answer that came after the stop does not change the file");
    } finally {
        release();
        await mixed.stop();
    }
});

test("the plain delegate form still works under orchestration: a worker has the whole workspace and commands, explore tasks queue behind the limit", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({
        script: orchestrated({ kind: "worker", tasks: ["Fix sum() in sum.js"] }, (body) => {
            const results = body.messages.filter((m: any) => m.role === "tool").length;
            if (results === 0) return { toolCalls: [patchSum] };
            if (results === 1) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "test.js"] } }] };
            return { text: "Fixed and tested." };
        }),
    }).start();
    try {
        const seen: ApprovalView[] = [];
        const { runner } = await makeRunner(gateway, root, { maxRequests: 50, orchestrate: limits(2, 60), prompter: scriptedPrompter([true, true], seen), runner: { subagents: true } });
        assert.equal(await runner.runTask("Fix it"), "success");
        const worker = gateway.completions.find((c) => roleOf(c.body) === "worker")!.body;
        assert.ok(toolNames(worker).includes("run_command"), "no other subtask writes, so it may run commands");
        assert.deepEqual(seen.map((view) => view.toolName), ["apply_patch", "run_command"]);
        const row = delegateResult(gateway).results[0];
        assert.equal(row.status, "success");
        assert.deepEqual(row.filesChanged, ["sum.js"]);
        assert.equal(row.verification.state, "skipped");
    } finally {
        await gateway.stop();
    }
});

test("a subtask runs on the session's model unless agent models are allowed, as for any delegate", async () => {
    const root = makeRepo();
    mkdirSync(join(root, ".claude/agents"), { recursive: true });
    writeFileSync(join(root, ".claude/agents/known.md"), "---\nname: known\ndescription: Known model\nmodel: fake-alt\ntools: Read\n---\nA.\n");
    const registry = discoverExtensions(root, { home: tempDir("none"), env: {} });
    const models = [...DEFAULT_MODELS, {
        id: "fake-alt", object: "model",
        tomverse: { name: "Fake Alt", provider: "openai", reasoning_efforts: [], capabilities: { tools: true, vision: false, reasoning: false }, protocols: ["chat_completions"], context_window_tokens: 200_000, max_output_tokens: 8_000, credits_per_request: 2 },
    }];
    const run = async (agentModels: boolean) => {
        const gateway = await new FakeGateway({ models, script: orchestrated({ subtasks: [{ title: "Read", goal: "read", agent: "known" }] }, () => ({ text: "report" })) }).start();
        try {
            const { runner } = await makeRunner(gateway, root, { maxRequests: 50, orchestrate: limits(3, 60), runner: { subagents: true, extensions: registry, agentModels } });
            await runner.runTask("go");
            return { model: gateway.completions.find((c) => roleOf(c.body) !== "main")!.body.model, row: delegateResult(gateway).results[0] };
        } finally {
            await gateway.stop();
        }
    };
    const off = await run(false);
    assert.equal(off.model, "fake-coder");
    assert.match(off.row.modelNote, /may not choose a model here/);
    assert.equal(off.row.agent, "known");
    const on = await run(true);
    assert.equal(on.model, "fake-alt");
});

test("a session cut off while subtasks were under way marks them failed and says so", async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
    try {
        const { journal } = await makeRunner(gateway, root, { runner: { subagents: true } });
        journal.state.subtasks = [{ id: "st-aaaaaa", toolCallId: "c1", title: "Map the build", kind: "explore", state: "running", attempts: 1, requests: 2, runIds: [], startedAt: new Date().toISOString(), epoch: "old" }];
        assert.match(reconcile(journal).join("\n"), /Subtask st-aaaaaa \(Map the build\) was under way/);
        assert.equal(journal.state.subtasks[0]!.state, "failed");
    } finally {
        await gateway.stop();
    }
});
