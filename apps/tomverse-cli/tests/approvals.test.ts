/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, tempDir } from "./helpers.js";
import type { ApprovalView } from "../src/agent.js";
import { ApprovalMemory } from "../src/approvals.js";
import { approvalQuestion, parseApprovalAnswer, terminalPrompter } from "../src/interactive.js";
import { Journal } from "../src/session.js";
import { Runner } from "../src/agent.js";

const commandView = (over: Partial<NonNullable<ApprovalView["command"]>> = {}): ApprovalView => ({
    approvalId: "a",
    toolCallId: "t",
    toolName: "run_command",
    input: {},
    command: { mode: "argv", file: "/usr/bin/node", args: ["test.js"], display: "node test.js", shell: null, cwd: "/repo", timeoutMs: 120_000, envNames: ["PATH", "HOME"], ...over },
});
const patchView = (action: "create" | "update" | "delete", root: string | undefined = "/repo"): ApprovalView => ({
    approvalId: "a",
    toolCallId: "t",
    toolName: "apply_patch",
    input: {},
    patch: [{ path: "x.js", action } as any],
    root,
});

test("memory: an exact command is remembered; any other program, argument, folder or environment is asked", () => {
    const memory = new ApprovalMemory();
    assert.equal(memory.match(commandView()), null);
    assert.equal(memory.remember(commandView()), "same_command");
    assert.equal(memory.match(commandView()), "same_command");
    // Only the timeout may differ.
    assert.equal(memory.match(commandView({ timeoutMs: 30_000 })), "same_command");
    assert.equal(memory.match(commandView({ envNames: ["HOME", "PATH"] })), "same_command");
    assert.equal(memory.match(commandView({ args: ["test.js", "--x"] })), null);
    assert.equal(memory.match(commandView({ file: "/tmp/node" })), null);
    assert.equal(memory.match(commandView({ cwd: "/other" })), null);
    assert.equal(memory.match(commandView({ envNames: ["PATH", "HOME", "NODE_OPTIONS"] })), null);
    assert.equal(memory.match(commandView({ mode: "shell", shell: "/bin/sh" })), null);
    // File edits are a separate rule.
    assert.equal(memory.match(patchView("update")), null);
    memory.clear();
    assert.equal(memory.match(commandView()), null);
});

test("memory: file edits cover create and update in that folder, never delete; an invalid request is never remembered", () => {
    const memory = new ApprovalMemory();
    assert.equal(memory.canRemember(patchView("delete")), false);
    assert.equal(memory.remember(patchView("delete")), null);
    assert.equal(memory.match(patchView("update")), null);
    assert.equal(memory.remember(patchView("update")), "file_edits");
    assert.equal(memory.match(patchView("create")), "file_edits");
    assert.equal(memory.match(patchView("delete")), null);
    assert.equal(memory.match({ ...patchView("update"), error: "bad" }), null);
    assert.equal(memory.canRemember({ ...commandView(), error: "bad" }), false);
    // Only in the folder where it was given; an edit with no known folder is always asked.
    assert.equal(memory.match(patchView("update", "/elsewhere")), null);
    assert.equal(memory.match(patchView("update", "")), null);
    assert.equal(memory.canRemember(patchView("update", "")), false);
    assert.deepEqual(memory.describe(), ["file edits in /repo (creating and changing files; deleting is still asked)"]);
});

test("answers: y once, a always only where offered, anything else is no", () => {
    assert.equal(parseApprovalAnswer("y", true), "once");
    assert.equal(parseApprovalAnswer(" YES ", true), "once");
    assert.equal(parseApprovalAnswer("a", true), "always");
    assert.equal(parseApprovalAnswer("always", true), "always");
    assert.equal(parseApprovalAnswer("a", false), "no", "a delete offers no 'always'");
    assert.equal(parseApprovalAnswer("", true), "no");
    assert.equal(parseApprovalAnswer(null, true), "no");
    assert.equal(parseApprovalAnswer("ya", true), "no");
    assert.match(approvalQuestion(patchView("update"), true), /\[a\] yes, and allow file edits/);
    assert.doesNotMatch(approvalQuestion(patchView("delete"), false), /\[a\]/);
    assert.match(approvalQuestion(commandView(), true), /\[a\] yes, and run this exact command again/);
});

/** Two edits, the same test command twice, one other command, then a delete. */
const script = (body: any) => {
    const n = toolResultsSinceUser(body).length;
    const test = { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "test.js"] } }] };
    const steps = [
        { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "return a - b;", new: "return a + b;" }] }] } }] },
        test,
        { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "NOTES.md", action: "create", content: "notes\n" }] } }] },
        test,
        { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", "console.log(1)"] } }] },
        { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "NOTES.md", action: "delete" }] } }] },
    ];
    return steps[n] ?? { text: "done" };
};

test("an 'always' answer skips only matching questions for the rest of the process, is recorded, and is not saved for resume", async () => {
    const gateway = await new FakeGateway({ script }).start();
    try {
        const root = makeRepo();
        const home = tempDir("home");
        const questions: string[] = [];
        const shown: string[] = [];
        const answers = ["a", "a", "n", "n"];
        const prompter = terminalPrompter(
            new ApprovalMemory(),
            async (q) => (questions.push(q), answers.shift() ?? "n"),
            (text) => shown.push(text)
        );
        const { runner, journal } = await makeRunner(gateway, root, { prompter, home });
        assert.equal(await runner.runTask("Fix it."), "success");
        // Asked: first patch (a), first test run (a), the other command (n), the delete (n).
        assert.equal(questions.length, 4);
        assert.match(questions[0]!, /^Apply these changes\?/);
        assert.match(questions[1]!, /^Run it\?/);
        assert.match(questions[2]!, /^Run it\?/);
        assert.match(questions[3]!, /deleting a file is always asked/);
        // The second edit and second identical test run went ahead and were still shown.
        assert.ok(shown.some((s) => /without asking: you allowed file edits/.test(s) && /NOTES\.md/.test(s)));
        assert.ok(shown.some((s) => /running without asking .*test\.js/.test(s)));
        assert.equal(readFileSync(join(root, "NOTES.md"), "utf8"), "notes\n", "the delete was declined");
        assert.equal(journal.state.tools.filter((t) => t.toolName === "run_command" && t.state === "completed").length, 2);
        const records = journal.state.approvals.map((a) => [a.toolName, a.decision, a.by ?? null, a.rule ?? null, a.remember ?? null]);
        assert.deepEqual(records, [
            ["apply_patch", "approved", null, null, "file_edits"],
            ["run_command", "approved", null, null, "same_command"],
            ["apply_patch", "approved", "remembered_answer", "file_edits", null],
            ["run_command", "approved", "remembered_answer", "same_command", null],
            ["run_command", "denied", null, null, null],
            ["apply_patch", "denied", null, null, null],
        ]);
        const id = journal.state.id;
        journal.release();

        // The rule lives in that prompter only: the saved session carries no rule,
        // and a resumed session with a new prompter asks again.
        const saved = readFileSync(join(home, "sessions", id, "session.json"), "utf8");
        assert.doesNotMatch(saved, /"memory"|fileEdits/);
        const resumed = Journal.open(home, id);
        const asked: string[] = [];
        const again = terminalPrompter(new ApprovalMemory(), async (q) => (asked.push(q), "n"), () => {});
        const second = new Runner({ gateway: runner["options"].gateway, journal: resumed, workspace: runner["options"].workspace, output: runner["options"].output, prompter: again, catalog: runner["options"].catalog, commandEnv: [], instructions: null });
        gateway.options.script = (body: any) =>
            toolResultsSinceUser(body).length ? { text: "ok" } : { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "test.js"] } }] };
        await second.runTask("Run the test again.");
        assert.equal(asked.length >= 1 && /^Run it\?/.test(asked[0]!), true, "the same command is asked again after resume");
        resumed.release();
    } finally {
        await gateway.stop();
    }
});
