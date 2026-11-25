/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Prompter } from "../src/agent.js";
import { forkThrough, rewindDialog, turnIndex } from "../src/history-cli.js";
import { Journal } from "../src/session.js";
import { RewindError } from "../src/runtime.js";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, tempDir } from "./helpers.js";

const approveAll: Prompter = { async approve() { return true; }, async confirm() { return false; } };
const lastUser = (body: any) => String([...body.messages].reverse().find((m: any) => m.role === "user" && typeof m.content === "string")?.content ?? "");

const script = (body: any) => {
    const said = lastUser(body);
    const done = toolResultsSinceUser(body).length;
    if (said === "make a") return done ? { text: "made a" } : { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "a.txt", action: "create", content: "A\n" }] } }] };
    if (said === "make b") return done ? { text: "made b" } : { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "b.txt", action: "create", content: "B\n" }] } }] };
    return { text: "ok" };
};

const twoTurns = async () => {
    const root = makeRepo();
    const gateway = await new FakeGateway({ script }).start();
    const made = await makeRunner(gateway, root, { prompter: approveAll });
    await made.runner.runTask("make a");
    await made.runner.runTask("make b");
    return { root, gateway, ...made };
};

const dialog = (answers: Array<string | null>) => {
    const said: string[] = [];
    const asked: string[] = [];
    return { said, asked, dialog: { ask: async (question: string) => (asked.push(question), answers.shift() ?? null), say: (line: string) => void said.push(line) } };
};

test("turn numbers are typed from 1 and anything else is not a turn", () => {
    assert.equal(turnIndex("1", 3), 0);
    assert.equal(turnIndex(" 3 ", 3), 2);
    for (const bad of ["0", "4", "x", "", "1.5", null, undefined]) assert.equal(turnIndex(bad, 3), null, String(bad));
});

test("/rewind lists the turns, shows what comes back, and rewinds files and conversation on b", async () => {
    const s = await twoTurns();
    try {
        const talk = dialog(["2", "b"]);
        let cut = 0;
        const outcome = await rewindDialog(s.journal, talk.dialog, () => { cut += 1; });
        assert.ok(outcome);
        assert.equal(cut, 1, "the runner is told the history was cut");
        const text = talk.said.join("\n");
        assert.match(text, /1\. make a/);
        assert.match(text, /2\. make b/);
        assert.match(text, /put back b\.txt \(create\)/);
        assert.match(text, /The conversation was cut back\./);
        assert.match(text, /The message that was taken out.*\nmake b/);
        assert.ok(!existsSync(join(s.root, "b.txt")));
        assert.ok(existsSync(join(s.root, "a.txt")), "the first turn's file stays");
        assert.equal(s.journal.state.tasks.length, 1);
        // Every question went to the person.
        assert.match(talk.asked[0]!, /which turn/);
        assert.match(talk.asked[1]!, /\[b\] files and conversation/);
    } finally {
        await s.gateway.stop();
    }
});

test("/rewind shows a conflict and leaves the person's file alone", async () => {
    const s = await twoTurns();
    try {
        writeFileSync(join(s.root, "a.txt"), "A\nmine\n");
        const talk = dialog(["1", "f"]);
        const outcome = await rewindDialog(s.journal, talk.dialog);
        assert.equal(outcome!.conflicts.length, 1);
        const text = talk.said.join("\n");
        assert.match(text, /CONFLICT\s+a\.txt/);
        assert.match(text, /NOT put back a\.txt/);
        assert.ok(!existsSync(join(s.root, "b.txt")), "the other file still came back");
        assert.equal(readFileSync(join(s.root, "a.txt"), "utf8"), "A\nmine\n");
        assert.equal(s.journal.state.tasks.length, 2, "files only: the conversation stays");
    } finally {
        await s.gateway.stop();
    }
});

test("/rewind does nothing on an empty answer, a wrong number, or anything but b, f and c", async () => {
    const s = await twoTurns();
    try {
        for (const answers of [[""], ["9"], [null], ["2", ""], ["2", "x"], ["2", "yes"]]) {
            const talk = dialog(answers);
            assert.equal(await rewindDialog(s.journal, talk.dialog), null, JSON.stringify(answers));
            assert.match(talk.said.at(-1)!, /Nothing was rewound/);
        }
        assert.ok(existsSync(join(s.root, "b.txt")));
        assert.equal(s.journal.state.tasks.length, 2);
        assert.equal(s.journal.state.rewinds, undefined);
    } finally {
        await s.gateway.stop();
    }
});

test("/rewind offers only files where the conversation was folded into a summary", async () => {
    const s = await twoTurns();
    try {
        s.journal.state.checkpoints![0]!.messageIndex = null;
        const talk = dialog(["1", "b"]);
        assert.equal(await rewindDialog(s.journal, talk.dialog), null, "b is not offered, so it is not taken");
        assert.match(talk.asked[1]!, /^\[f\] files only/);
        assert.match(talk.said.join("\n"), /conversation folded into a summary/);
        const files = dialog(["1", "f"]);
        assert.equal((await rewindDialog(s.journal, files.dialog))!.undone.length, 2);
    } finally {
        await s.gateway.stop();
    }
});

test("/rewind says so on a session without turns", async () => {
    const s = await twoTurns();
    try {
        delete s.journal.state.checkpoints;
        const talk = dialog([]);
        assert.equal(await rewindDialog(s.journal, talk.dialog), null);
        assert.match(talk.said[0]!, /no turn to rewind to/);
    } finally {
        await s.gateway.stop();
    }
});

test("/fork copies through the chosen turn, or the whole conversation, into a session that can be opened", async () => {
    const s = await twoTurns();
    const home = tempDir("fork-home");
    try {
        const whole = forkThrough(home, s.journal, undefined);
        assert.equal(whole.turns, 2);
        const first = forkThrough(home, s.journal, "1");
        assert.equal(first.turns, 1);
        assert.throws(() => forkThrough(home, s.journal, "3"), (error: unknown) => error instanceof RewindError && /from 1 to 2/.test((error as Error).message));
        const opened = Journal.open(home, first.id);
        try {
            assert.deepEqual(opened.state.tasks.map((t) => t.prompt), ["make a"]);
            assert.equal(opened.state.changes.length, 0, "the copy has no change of the original to undo");
        } finally {
            opened.release();
        }
        assert.ok(existsSync(join(s.root, "b.txt")), "no file was touched");
        assert.equal(s.journal.state.tasks.length, 2);
    } finally {
        await s.gateway.stop();
    }
});
