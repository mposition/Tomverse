/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Runner, type Prompter } from "../src/agent.js";
import { Gateway } from "../src/gateway.js";
import { Journal } from "../src/session.js";
import { Workspace } from "../src/workspace.js";
import { forkSession, listTurns, planRewind, rewindSession, RewindError } from "../src/runtime.js";
import { FakeGateway, TEST_KEY, toolResultsSinceUser } from "./fakeGateway.js";
import { captureOutput, makeRepo, makeRunner, tempDir } from "./helpers.js";

const approveAll: Prompter = { async approve() { return true; }, async confirm() { return false; } };
const lastUser = (body: any) => {
    const user = [...body.messages].reverse().find((m: any) => m.role === "user" && typeof m.content === "string");
    return String(user?.content ?? "");
};
const userTexts = (body: any) => body.messages.filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : ""));

const PROGRAM = process.execPath;

/**
 * Three turns: fix sum.js; create notes.txt; run a command, then change notes.txt. Each turn ends with a short answer.
 */
const threeTurns = (body: any) => {
    const said = lastUser(body);
    const done = toolResultsSinceUser(body).length;
    if (said.startsWith("fix sum")) {
        return done ? { text: "Fixed sum." } : { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "a - b", new: "a + b" }] }] } }] };
    }
    if (said.startsWith("add notes")) {
        return done ? { text: "Added notes." } : { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "notes.txt", action: "create", content: "v1\n" }] } }] };
    }
    if (said.startsWith("run check")) {
        if (done === 0) return { toolCalls: [{ name: "run_command", args: { argv: [PROGRAM, "-e", "console.log('checked')"] } }] };
        if (done === 1) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "notes.txt", action: "update", replacements: [{ old: "v1", new: "v2" }] }] } }] };
        return { text: "Checked." };
    }
    return { text: "ok" };
};

const session = async (script: (body: any, index: number) => any = threeTurns, options: Parameters<typeof makeRunner>[2] = {}) => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script }).start();
    const made = await makeRunner(gateway, root, { prompter: approveAll, ...options });
    return { root, gateway, ...made };
};

const runThree = async (made: { runner: Runner }) => {
    assert.equal(await made.runner.runTask("fix sum"), "success");
    assert.equal(await made.runner.runTask("add notes"), "success");
    assert.equal(await made.runner.runTask("run check"), "success");
};

test("every user message gets a checkpoint of where the conversation and the changes stood", async () => {
    const s = await session();
    try {
        await runThree(s);
        const marks = s.journal.state.checkpoints!;
        assert.deepEqual(marks.map((m) => [m.kind, m.task, m.changeStart, m.toolStart]), [["prompt", 0, 0, 0], ["prompt", 1, 1, 1], ["prompt", 2, 2, 2]]);
        assert.deepEqual(marks.map((m) => m.text), ["fix sum", "add notes", "run check"]);
        // Each checkpoint points at its own user message.
        for (const mark of marks) assert.equal((s.journal.state.messages[mark.messageIndex!] as any).content, mark.text);
        assert.deepEqual(listTurns(s.journal).map((t) => [t.index, t.changes, t.commands]), [[0, 3, 1], [1, 2, 1], [2, 1, 1]]);
    } finally {
        await s.gateway.stop();
    }
});

test("a rewind plan lists the files newest first, and the commands that cannot be undone", async () => {
    const s = await session();
    try {
        await runThree(s);
        const plan = planRewind(s.journal, 1);
        assert.equal(plan.blocked, undefined);
        assert.deepEqual(plan.files.map((f) => [f.path, f.kind, f.outcome]), [["notes.txt", "update", "will_undo"], ["notes.txt", "create", "will_undo"]]);
        assert.equal(plan.commands.length, 1);
        assert.match(plan.commands[0]!.display, /console\.log\('checked'\)/);
        assert.equal(plan.commands[0]!.exitCode, 0);
        assert.equal(plan.conversationAvailable, true);
        // Nothing was done by planning.
        assert.equal(readFileSync(join(s.root, "notes.txt"), "utf8"), "v2\n");
        assert.equal(s.journal.state.tasks.length, 3);
    } finally {
        await s.gateway.stop();
    }
});

test("rewinding files and conversation puts the files back newest first and cuts the history to before the turn", async () => {
    const s = await session();
    try {
        await runThree(s);
        const sumAfterFix = readFileSync(join(s.root, "sum.js"), "utf8");
        const cutAt = s.journal.state.checkpoints![1]!.messageIndex!;
        const outcome = rewindSession(s.journal, 1, "both");
        s.runner.historyChanged();
        assert.deepEqual(outcome.undone.map((u) => u.path), ["notes.txt", "notes.txt"]);
        assert.deepEqual(outcome.undone.map((u) => s.journal.state.changes.find((c) => c.changeId === u.changeId)!.kind), ["update", "create"], "newest change first");
        assert.deepEqual(outcome.conflicts, []);
        assert.equal(outcome.text, "add notes");
        assert.ok(!existsSync(join(s.root, "notes.txt")), "the file the removed turns created is gone");
        assert.equal(readFileSync(join(s.root, "sum.js"), "utf8"), sumAfterFix, "turn 1's change stays");
        // The conversation, the tasks and the checkpoints are cut back to the first turn.
        assert.equal(s.journal.state.tasks.length, 1);
        assert.equal(s.journal.state.checkpoints!.length, 1);
        assert.equal(s.journal.state.status, "completed");
        // The one thing left of the removed part is a note about what cannot be taken back.
        const messages = s.journal.state.messages as any[];
        assert.equal(messages.length, cutAt + 1);
        assert.match(messages.at(-1).content, /Commands that ran in the removed part cannot be taken back.*console\.log\('checked'\)/);
        assert.deepEqual(s.journal.state.changes.map((c) => c.state), ["applied", "undone", "undone"]);
        assert.equal(s.journal.state.rewinds!.length, 1);
        assert.equal(s.journal.state.rewinds![0]!.commands.length, 1);
        // The session goes on from there: the removed message is not in the next request, the note is.
        assert.equal(await s.runner.runTask("add notes again"), "success");
        const texts = userTexts(s.gateway.completions.at(-1)!.body);
        assert.ok(!texts.includes("add notes") && !texts.includes("run check"));
        assert.ok(texts.some((t: string) => t.startsWith("[Tomverse CLI] The user rewound")) || texts.some((t: string) => /Commands that ran/.test(t)));
        assert.deepEqual(s.journal.state.checkpoints!.map((m) => m.text), ["fix sum", "add notes again"]);
    } finally {
        await s.gateway.stop();
    }
});

test("a file the person edited since is not put back, and a rewind says so", async () => {
    const s = await session();
    try {
        await runThree(s);
        writeFileSync(join(s.root, "notes.txt"), "v2\nmy own line\n");
        const plan = planRewind(s.journal, 1);
        assert.deepEqual(plan.files.map((f) => f.outcome), ["conflict", "conflict"], "the earlier change to the same file waits for the later one");
        const outcome = rewindSession(s.journal, 1, "both");
        assert.deepEqual(outcome.undone, []);
        assert.equal(outcome.conflicts.length, 2);
        assert.match(outcome.conflicts[0]!.reason, /changed after the Code edit/);
        assert.match(outcome.conflicts[1]!.reason, /undo that first/);
        assert.equal(readFileSync(join(s.root, "notes.txt"), "utf8"), "v2\nmy own line\n", "the person's edit is untouched");
        // The conversation is still cut, and the model is told which files were not put back.
        assert.equal(s.journal.state.tasks.length, 1);
        assert.match((s.journal.state.messages.at(-1) as any).content, /NOT put back.*notes\.txt/);
        assert.deepEqual(s.journal.state.changes.map((c) => c.state), ["applied", "applied", "applied"]);
    } finally {
        await s.gateway.stop();
    }
});

test("files only and conversation only each leave the other as it was, and tell the model", async () => {
    const files = await session();
    try {
        await runThree(files);
        const before = files.journal.state.messages.length;
        const outcome = rewindSession(files.journal, 2, "files");
        assert.deepEqual(outcome.undone.map((u) => u.path), ["notes.txt"]);
        assert.equal(readFileSync(join(files.root, "notes.txt"), "utf8"), "v1\n");
        assert.equal(files.journal.state.tasks.length, 3, "the conversation stays");
        assert.equal(files.journal.state.messages.length, before + 1);
        assert.match((files.journal.state.messages.at(-1) as any).content, /rewound the files.*put back: notes\.txt.*not in the folder any more/);
    } finally {
        await files.gateway.stop();
    }
    const talk = await session();
    try {
        await runThree(talk);
        const outcome = rewindSession(talk.journal, 1, "conversation");
        assert.deepEqual(outcome.undone, []);
        assert.equal(readFileSync(join(talk.root, "notes.txt"), "utf8"), "v2\n", "the files stay");
        assert.equal(talk.journal.state.tasks.length, 1);
        assert.match((talk.journal.state.messages.at(-1) as any).content, /files were NOT put back.*notes\.txt/);
        assert.deepEqual(talk.journal.state.changes.map((c) => c.state), ["applied", "applied", "applied"]);
    } finally {
        await talk.gateway.stop();
    }
});

test("nothing is rewound while a task runs, waits for an approval, or has an unknown outcome", async () => {
    const s = await session();
    try {
        await runThree(s);
        for (const [change, pattern] of [
            [() => { s.journal.state.status = "running"; }, /running/],
            [() => { s.journal.state.status = "completed"; s.journal.state.pendingApprovals = [{ approvalId: "a", toolCallId: "t", toolName: "run_command", input: {} }]; }, /waiting for an approval/],
            [() => { s.journal.state.pendingApprovals = []; s.journal.state.generations.at(-1)!.closed = false; }, /unknown outcome/],
        ] as const) {
            change();
            assert.match(planRewind(s.journal, 1).blocked ?? "", pattern);
            assert.throws(() => rewindSession(s.journal, 1), (error: unknown) => error instanceof RewindError && pattern.test((error as Error).message));
            assert.throws(() => forkSession(s.journal.dir!.replace(/[\\/]sessions[\\/][^\\/]+$/, ""), s.journal, 1), RewindError);
        }
        assert.ok(existsSync(join(s.root, "notes.txt")), "nothing was changed");
        assert.equal(s.journal.state.tasks.length, 3);
        assert.match(planRewind(s.journal, 9).blocked ?? "", /There is no turn 10/);
    } finally {
        await s.gateway.stop();
    }
});

test("a turn folded into a compaction summary cannot be cut back to, but its files can be put back", async () => {
    const s = await session((body) => (/You compress a coding session/.test(String(body.messages[0]?.content)) ? { text: "Summary: three turns." } : threeTurns(body)));
    try {
        await runThree(s);
        assert.equal(await s.runner.maybeCompact(true), "compacted");
        assert.equal(await s.runner.runTask("a later turn"), "success");
        const marks = s.journal.state.checkpoints!;
        assert.deepEqual(marks.map((m) => m.messageIndex === null), [true, true, true, false]);
        assert.equal(listTurns(s.journal)[0]!.conversation, false);
        assert.throws(() => rewindSession(s.journal, 0, "both"), /folded into a summary/);
        assert.equal(readFileSync(join(s.root, "notes.txt"), "utf8"), "v2\n", "a refused rewind changes nothing");
        const outcome = rewindSession(s.journal, 0, "files");
        assert.equal(outcome.undone.length, 3);
        assert.match(readFileSync(join(s.root, "sum.js"), "utf8"), /a - b/);
        assert.ok(!existsSync(join(s.root, "notes.txt")));
        // The turn after the compaction still cuts.
        assert.equal(rewindSession(s.journal, 3, "conversation").conversationCut, true);
    } finally {
        await s.gateway.stop();
    }
});

test("a follow-up sent while a task ran is a turn of its own, and goal-mode continuations are not", async () => {
    let runner: Runner | undefined;
    const s = await session((body, index) => {
        if (index === 0) {
            assert.ok(runner!.steer("and also list the folder"));
            return { toolCalls: [{ name: "list_files", args: { path: "." } }] };
        }
        return { text: "ok" };
    });
    try {
        runner = s.runner;
        assert.equal(await runner.runTask("look around"), "success");
        const marks = s.journal.state.checkpoints!;
        assert.deepEqual(marks.map((m) => [m.kind, m.text]), [["prompt", "look around"], ["follow_up", "and also list the folder"]]);
        assert.ok(marks[1]!.messageIndex! > marks[0]!.messageIndex!);
        const outcome = rewindSession(s.journal, 1, "conversation");
        assert.equal(outcome.text, "and also list the folder");
        assert.equal(s.journal.state.tasks.length, 1);
        assert.equal(s.journal.state.tasks[0]!.followUps!.length, 0, "the follow-up is taken out of the task too");
        const roles = (s.journal.state.messages as any[]).map((m) => m.role);
        assert.deepEqual(roles.slice(0, 4), ["user", "assistant", "tool", "user"], "cut right after the tool result it followed, with the note after it");
    } finally {
        await s.gateway.stop();
    }
});

test("a fork copies the conversation through a turn into a new session, and touches no file", async () => {
    const s = await session();
    const home = tempDir("fork-home");
    try {
        await runThree(s);
        const filesBefore = readFileSync(join(s.root, "notes.txt"), "utf8");
        const sourceBefore = JSON.stringify(s.journal.state);
        const { journal: copy, turns } = forkSession(home, s.journal, 1);
        try {
            assert.equal(turns, 2);
            assert.notEqual(copy.state.id, s.journal.state.id);
            assert.deepEqual(copy.state.forkedFrom && [copy.state.forkedFrom.sessionId, copy.state.forkedFrom.turns], [s.journal.state.id, 2]);
            assert.equal(copy.state.tasks.length, 2);
            assert.deepEqual(copy.state.tasks.map((t) => t.prompt), ["fix sum", "add notes"]);
            assert.equal(copy.state.messages.length, s.journal.state.checkpoints![2]!.messageIndex);
            assert.deepEqual(copy.state.messages, s.journal.state.messages.slice(0, copy.state.messages.length));
            assert.deepEqual(copy.state.checkpoints!.map((m) => m.text), ["fix sum", "add notes"]);
            // None of the original's records of work: nothing to undo, no requests, no approvals.
            assert.deepEqual([copy.state.changes.length, copy.state.tools.length, copy.state.approvals.length, copy.state.generations.length, copy.state.usage.requests], [0, 0, 0, 0, 0]);
            assert.equal(copy.state.status, "completed");
            assert.equal(copy.state.model.pinned, s.journal.state.model.pinned);
            assert.deepEqual(copy.state.workspace, s.journal.state.workspace);
            // Independent: changing the copy never changes the original; the original and the files are exactly as they were.
            (copy.state.messages[0] as any).content = "changed in the copy";
            copy.state.tasks[0]!.prompt = "changed";
            assert.equal(JSON.stringify(s.journal.state), sourceBefore);
            assert.equal(readFileSync(join(s.root, "notes.txt"), "utf8"), filesBefore);
            // The fork is a saved session of its own: it can be opened again, and it goes on with a new task.
            copy.commit();
        } finally {
            copy.release();
        }
        const reopened = Journal.open(home, copy.state.id);
        try {
            assert.equal(reopened.state.forkedFrom!.sessionId, s.journal.state.id);
            assert.equal(reopened.state.changes.length, 0);
        } finally {
            reopened.release();
        }
    } finally {
        await s.gateway.stop();
    }
});

test("a fork continues on its own, and rewinding it never reaches the original's files", async () => {
    const s = await session();
    const home = tempDir("fork-home");
    try {
        await runThree(s);
        const { journal: copy } = forkSession(home, s.journal, 2);
        copy.release();
        const reopened = Journal.open(home, copy.state.id);
        try {
            const client = new Gateway({ base: s.gateway.base, origin: new URL(s.gateway.base).origin, basePath: "/api/code/v1" }, TEST_KEY);
            const catalog = (await client.models()).filter((m) => m.tools);
            const runner = new Runner({ gateway: client, journal: reopened, workspace: new Workspace(s.root), output: captureOutput().output, prompter: approveAll, catalog, commandEnv: [], instructions: null });
            assert.equal(await runner.runTask("one more thing"), "success");
            assert.equal(reopened.state.tasks.length, 4);
            assert.equal(s.journal.state.tasks.length, 3, "the original did not grow");
            // The fork's rewind has no changes of the original to undo.
            const outcome = rewindSession(reopened, 3, "both");
            assert.deepEqual(outcome.undone, []);
            assert.equal(readFileSync(join(s.root, "notes.txt"), "utf8"), "v2\n");
        } finally {
            reopened.release();
        }
    } finally {
        await s.gateway.stop();
    }
});

test("a session that cannot be cut at a turn is refused for a fork, and an in-memory session cannot be forked", async () => {
    const s = await session();
    try {
        await runThree(s);
        const home = tempDir("fork-home");
        assert.throws(() => forkSession(home, s.journal, 7), /There is no turn 8/);
        // A turn whose end is inside a compaction summary cannot be cut.
        s.journal.state.checkpoints![2]!.messageIndex = null;
        assert.throws(() => forkSession(home, s.journal, 1), /folded into a summary/);
    } finally {
        await s.gateway.stop();
    }
    const memory = await session(threeTurns, { home: null });
    try {
        await runThree(memory);
        assert.throws(() => forkSession(tempDir("fork-home"), memory.journal, 0), /kept in memory only/);
    } finally {
        await memory.gateway.stop();
    }
});
