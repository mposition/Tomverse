/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ModelMessage } from "ai";
import { FakeGateway, lastUserText, toolResultsSinceUser, type ScriptedReply } from "./fakeGateway.js";
import { makeRepo, makeRunner, scriptedPrompter, tempDir } from "./helpers.js";
import { Journal, writeFileAtomic } from "../src/session.js";
import { Runner, findCompactionCut } from "../src/agent.js";
import { Gateway } from "../src/gateway.js";
import { Workspace } from "../src/workspace.js";
import { undoChange, UndoError, viewChanges } from "../src/changes.js";
import { canonicalDigest } from "../src/session.js";

const withGateway = async (script: (body: any, index: number) => ScriptedReply, run: (g: FakeGateway) => Promise<void>, extra: { routedModel?: string } = {}) => {
    const gateway = await new FakeGateway({ script, ...extra }).start();
    try {
        await run(gateway);
    } finally {
        await gateway.stop();
    }
};

test("connection lost before any answer: looked up by its key, reported, never sent again", () =>
    withGateway(
        () => ({ fault: "drop_before_headers" }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
            assert.equal(await runner.runTask("Hi"), "unknown_outcome");
            assert.equal(gateway.completions.length, 1, "no automatic resend");
            const [record] = journal.state.generations;
            assert.equal(record!.state, "failed");
            assert.equal(record!.lookup, "found", "the server knows it by the Idempotency-Key recorded before sending");
            assert.equal(record!.receipt!.status, "settled");
            assert.ok(record!.requestId?.startsWith("req_"));
            const lookups = gateway.requests.filter((r) => r.url === "/api/code/v1/requests/status");
            assert.equal(lookups[0]!.headers["idempotency-key"], record!.idempotencyKey);
        }
    ));

test("an answer cut off mid-stream is unknown, its receipt known; a 'not found' is not called free", () =>
    withGateway(
        (_body, i) => (i === 0 ? { fault: "drop_mid_stream", text: "half an ans" } : { text: "x" }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
            assert.equal(await runner.runTask("Hi"), "unknown_outcome");
            const [record] = journal.state.generations;
            assert.equal(record!.state, "interrupted");
            assert.ok(record!.requestId);
            assert.match(runner.unknownReport(record!), /not stored, so it cannot be shown again/);
            // Simulate a server that has no record (not yet admitted): still unknown, not "free".
            record!.lookup = "not_found";
            record!.receipt = null;
            assert.match(runner.unknownReport(record!), /does not prove it was not received or charged/);
        }
    ));

test("the user may choose to send a step again after an unknown outcome; it is recorded as a resend", () =>
    withGateway(
        (_body, i) => (i === 0 ? { fault: "drop_before_headers" } : { text: "done" }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([true]) });
            assert.equal(await runner.runTask("Hi"), "success");
            assert.equal(gateway.completions.length, 2);
            assert.equal(journal.state.generations[1]!.resendOf, 1);
            assert.notEqual(journal.state.generations[1]!.idempotencyKey, journal.state.generations[0]!.idempotencyKey);
        }
    ));

test("an API refusal (key cap) stops the task without a retry", () =>
    withGateway(
        () => ({ fault: "http", status: 429, code: "key_credit_cap_reached", message: "This API key has reached the credit limit set for it." }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([true, true]) });
            assert.equal(await runner.runTask("Hi"), "error");
            assert.equal(gateway.completions.length, 1);
            assert.equal(journal.state.generations[0]!.httpStatus, 429);
            assert.equal(journal.state.generations[0]!.error?.code, "key_credit_cap_reached");
            assert.match(journal.state.lastError ?? "", /credit limit/);
        }
    ));

test("cancel stops a streaming answer; the request is looked up and left as it is", () =>
    withGateway(
        () => ({ fault: "hang" }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
            const running = runner.runTask("Hi");
            setTimeout(() => runner.cancel(), 300);
            assert.equal(await running, "cancelled");
            assert.equal(journal.state.status, "cancelled");
            assert.equal(journal.state.generations[0]!.receipt?.status, "held", "held is shown as held, not as free or final");
        }
    ));

test("the per-task request limit stops the loop, survives approvals, and grows only when the user agrees", () =>
    withGateway(
        () => ({ toolCalls: [{ name: "list_files", args: {} }] }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null, maxRequests: 3 });
            assert.equal(await runner.runTask("Loop"), "limit_reached");
            assert.equal(gateway.completions.length, 3);
            assert.equal(journal.state.tasks[0]!.requests, 3);
            // Continuing the same task without agreement does not reset the count.
            assert.equal(await runner.loop(), "limit_reached");
            assert.equal(gateway.completions.length, 3);
            const agreeing = new Runner({ ...(runner as any).options, prompter: scriptedPrompter([true, false]) });
            assert.equal(await agreeing.loop(), "limit_reached");
            assert.equal(gateway.completions.length, 6, "one more round of the same size, then stop");
            assert.equal(journal.state.tasks[0]!.allowance, 6);
        }
    ));

test("a long history is compacted with one request of the same model, keeping tool pairs; failure keeps history", async () => {
    const big = "가나다 const value = 1; ".repeat(200);
    const script = (body: any): ScriptedReply => {
        if (/Summarize this session so far/.test(lastUserText(body))) return { text: "SUMMARY: read big.txt three times." };
        const results = toolResultsSinceUser(body);
        if (results.length < 3) return { toolCalls: [{ name: "read_file", args: { path: "big.txt" } }] };
        return { text: "done" };
    };
    await withGateway(script, async (gateway) => {
        const { runner, journal } = await makeRunner(gateway, makeRepo({ "big.txt": big }), { prompter: null, model: "fake-small", contextWindow: 9_000 });
        assert.equal(await runner.runTask("Read big.txt a few times"), "success");
        const compacts = journal.state.generations.filter((g) => g.purpose === "compact");
        assert.ok(compacts.length >= 1, "a compaction request was made");
        assert.equal(journal.state.tasks[0]!.requests, journal.state.generations.length, "compaction counts against the task limit");
        const compactBody = gateway.completions.find((c) => /Summarize this session so far/.test(lastUserText(c.body)))!.body;
        assert.equal(compactBody.model, "fake-small", "same model");
        assert.equal(compactBody.tools, undefined, "the summary request offers no tools");
        const first = journal.state.messages[0] as { content: string };
        assert.match(first.content, /SUMMARY: read big\.txt/, `lastError=${journal.state.lastError} compacts=${JSON.stringify(compacts)}`);
        assert.match(first.content, /Facts recorded by the CLI/);
        // Every tool result left in history still has its call.
        const calls = new Set(journal.state.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "tool-call").map((p: any) => p.toolCallId)));
        for (const m of journal.state.messages as any[]) for (const p of Array.isArray(m.content) ? m.content : []) if (p.type === "tool-result") assert.ok(calls.has(p.toolCallId));
    });
    await withGateway(
        (body) => (/Summarize this session so far/.test(lastUserText(body)) ? { fault: "http", status: 500, code: "upstream_error" } : script(body)),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo({ "big.txt": big }), { prompter: null, model: "fake-small", contextWindow: 9_000 });
            await runner.runTask("Read big.txt a few times");
            const compacts = journal.state.generations.filter((g) => g.purpose === "compact");
            assert.equal(compacts.length, 1, "a failed compaction is not retried automatically");
            assert.equal((journal.state.messages[0] as { content: string }).content, "Read big.txt a few times", "the original history is kept");
        }
    );
});

test("compaction retains archived, current and queued follow-ups in the same task", () =>
    withGateway((body) => ({ text: /Summarize this session/.test(lastUserText(body)) ? "Summary of the old work." : "Original answer." }), async (gateway) => {
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
        assert.equal(await runner.runTask("Original task"), "success");
        journal.state.messages.push(
            { role: "user", content: "Earlier instruction" }, { role: "assistant", content: "Earlier reply" },
            { role: "user", content: "Current instruction" }, { role: "assistant", content: "Current reply" },
            { role: "assistant", content: "Additional context" },
        );
        const task = journal.state.tasks[0]!;
        task.followUps = [
            { text: "Earlier instruction", messageIndex: 2 },
            { text: "Current instruction", messageIndex: 4 },
            { text: "Queued instruction" },
        ];
        assert.equal(await runner.maybeCompact(true), "compacted");
        const saved = Journal.read(journal.dir!);
        assert.deepEqual(saved.tasks[0]?.followUps, [
            { text: "Earlier instruction", messageIndex: null },
            { text: "Current instruction", messageIndex: 2 },
            { text: "Queued instruction" },
        ]);
        assert.equal(saved.messages[2]?.content, "Current instruction");
    }));

test("compaction never cuts between a tool call and its result or approval", () => {
    const messages = [
        { role: "user", content: "a" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "read_file", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "read_file", output: { type: "text", value: "x" } }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "t2", toolName: "apply_patch", input: {} }, { type: "tool-approval-request", approvalId: "a2", toolCallId: "t2" }] },
        { role: "tool", content: [{ type: "tool-approval-response", approvalId: "a2", approved: true }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "t2", toolName: "apply_patch", output: { type: "text", value: "ok" } }] },
        { role: "assistant", content: "done" },
    ] as ModelMessage[];
    const cut = findCompactionCut(messages, 3);
    assert.ok(cut === 3 || cut === 1, `cut ${cut}`);
    assert.notEqual(messages[cut]!.role, "tool");
    assert.equal(findCompactionCut(messages.slice(0, 2), 1), 1);
});

test("Smart Adaptive: the first answer's model is pinned before its tools run and kept for every later request", () =>
    withGateway(
        (body) => (toolResultsSinceUser(body).length ? { text: "done" } : { toolCalls: [{ name: "list_files", args: {} }] }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { model: "smart-adaptive", prompter: null });
            assert.equal(await runner.runTask("Look around"), "success");
            assert.equal(gateway.completions[0]!.body.model, "smart-adaptive");
            assert.equal(gateway.completions[1]!.body.model, "fake-coder", "the next request names the pinned model");
            assert.equal(journal.state.model.pinned, "fake-coder");
            assert.equal(journal.state.model.pinnedFrom, "smart_adaptive_first_response");
        },
        { routedModel: "fake-coder" }
    ));

test("the execute gate: a changed file after approval, a different input, and a call that already started are never run", async () => {
    const root = makeRepo();
    const patchArgs = { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "return a - b;", new: "return a + b;" }] }] };
    // 1. The file changes between the approval and the write.
    await withGateway(
        (body) => (toolResultsSinceUser(body).length ? { text: `r ${JSON.stringify(toolResultsSinceUser(body))}` } : { toolCalls: [{ name: "apply_patch", args: patchArgs }] }),
        async (gateway) => {
            const prompter = {
                approve: async () => {
                    writeFileSync(join(root, "sum.js"), "export function sum(a, b) {\n  return a - b; // user edit\n}\n");
                    return true;
                },
                confirm: async () => false,
            };
            const { runner, journal } = await makeRunner(gateway, root, { prompter });
            await runner.runTask("Fix");
            assert.match(readFileSync(join(root, "sum.js"), "utf8"), /user edit/, "the user's concurrent edit is kept");
            assert.equal(journal.state.changes.length, 0);
            assert.match(JSON.stringify(gateway.completions[1]!.body.messages), /Changed since it was approved/);
        }
    );
    // 2 and 3: drive the gate directly through the SDK tool.
    const home = tempDir("home");
    await withGateway(() => ({ text: "x" }), async (gateway) => {
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { home });
        const exec = (runner.tools.run_command as any).execute;
        const marker = join(journal.state.workspace.root, "ran.txt");
        const input = { argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] };
        journal.state.approvals.push({ approvalId: "a1", toolCallId: "t1", toolName: "run_command", inputDigest: canonicalDigest({ ...input, argv: [...input.argv, "--extra"] }), binding: { cwd: journal.state.workspace.root }, decision: "approved", decidedAt: "" });
        const refused = await exec(input, { toolCallId: "t1", messages: [] });
        assert.equal(refused.status, "denied", "approved for another input");
        assert.equal(existsSync(marker), false);
        journal.state.approvals.push({ approvalId: "a2", toolCallId: "t2", toolName: "run_command", inputDigest: canonicalDigest(input), binding: { cwd: journal.state.workspace.root }, decision: "approved", decidedAt: "" });
        journal.state.tools.push({ toolCallId: "t2", toolName: "run_command", inputDigest: canonicalDigest(input), state: "started", startedAt: "" });
        const again = await exec(input, { toolCallId: "t2", messages: [] });
        assert.equal(again.status, "unknown", "a call that started before a crash is not run again");
        assert.equal(existsSync(marker), false);
    });
});

test("a journal that cannot be written stops the session before the next paid request", () =>
    withGateway(
        () => ({ toolCalls: [{ name: "list_files", args: {} }] }),
        async (gateway) => {
            let writes = 0;
            const home = tempDir("home");
            const endpoint = { base: gateway.base, origin: new URL(gateway.base).origin, basePath: "/api/code/v1" };
            const client = new Gateway(endpoint, (await import("./fakeGateway.js")).TEST_KEY);
            const catalog = await client.models();
            const root = makeRepo();
            const journal = Journal.create(
                home,
                { workspace: { root }, endpointOrigin: endpoint.origin, keyPrefix: "tvk_abcdefgh", readOnly: false, model: { requested: "fake-coder", pinned: "fake-coder", pinnedFrom: "user", contextWindowTokens: 200000, maxOutputTokens: 8000 }, limits: { maxRequests: 20, timeoutMs: 900000, commandTimeoutMs: 120000 } },
                {
                    writeFileAtomic: (path, data) => {
                        writes += 1;
                        if (writes > 8) throw new Error("EACCES: permission denied");
                        writeFileAtomic(path, data);
                    },
                }
            );
            const { captureOutput } = await import("./helpers.js");
            const runner = new Runner({ gateway: client, journal, workspace: new Workspace(root), output: captureOutput().output, prompter: null, catalog, commandEnv: [], instructions: null });
            assert.equal(await runner.runTask("Loop"), "error");
            const sent = gateway.completions.length;
            assert.ok(sent >= 1 && sent <= 3, `stopped after ${sent}`);
            assert.ok(journal.broken);
            assert.equal(gateway.completions.length, sent);
        }
    ));

test("needs_approval -> resume in a terminal: the request count carries on and the fix lands", async () => {
    const script = (body: any): ScriptedReply => {
        const results = toolResultsSinceUser(body);
        if (results.length === 0) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "return a - b;", new: "return a + b;" }] }] } }] };
        if (results.length === 1) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "test.js"] } }] };
        return { text: "fixed" };
    };
    await withGateway(script, async (gateway) => {
        const home = tempDir("home");
        const root = makeRepo({ "notes.txt": "my uncommitted notes\n" });
        const first = await makeRunner(gateway, root, { home, prompter: null });
        assert.equal(await first.runner.runTask("Fix it"), "needs_approval");
        first.journal.release();
        const journal = Journal.open(home, first.journal.state.id);
        assert.equal(journal.state.tasks[0]!.requests, 1);
        const runner = new Runner({ ...(first.runner as any).options, journal, prompter: scriptedPrompter([true, true]) });
        assert.equal(await runner.answerApprovals(journal.state.pendingApprovals), "answered");
        assert.equal(await runner.loop(), "success");
        assert.equal(journal.state.tasks[0]!.requests, 3, "not reset by the resume");
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a \+ b/);
        assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "my uncommitted notes\n", "pre-existing changes untouched");

        // diff/undo: only the CLI's change, and only while it is as written.
        const [view] = viewChanges(journal);
        assert.equal(view!.current, "as_written");
        assert.equal(viewChanges(journal).length, 1);
        writeFileSync(join(root, "sum.js"), readFileSync(join(root, "sum.js"), "utf8") + "// later user edit\n");
        assert.throws(() => undoChange(journal, view!.changeId), UndoError);
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /later user edit/, "a refused undo changes nothing");
        writeFileSync(join(root, "sum.js"), "export function sum(a, b) {\n  return a + b;\n}\n");
        undoChange(journal, view!.changeId);
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a - b/);
        assert.throws(() => undoChange(journal, view!.changeId), /already undone/);
        journal.release();
    });
});

test("undo of a created file removes only that file, and refuses after it was edited", async () => {
    await withGateway(
        (body) => (toolResultsSinceUser(body).length ? { text: "ok" } : { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "src/new.txt", action: "create", content: "new\n" }] } }] }),
        async (gateway) => {
            const root = makeRepo();
            const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([true]) });
            await runner.runTask("create");
            const change = journal.state.changes[0]!;
            assert.equal(change.kind, "create");
            undoChange(journal, change.changeId);
            assert.equal(existsSync(join(root, "src", "new.txt")), false);
            assert.ok(existsSync(join(root, "sum.js")));
        }
    );
});
