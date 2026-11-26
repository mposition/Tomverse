/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures and partial approval views */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ApprovalView, Prompter } from "../src/agent.js";
import { PermissionGate, type PermissionMode } from "../src/permissions.js";
import { remoteCanUndoRecord, remoteUndoChange, remoteViewChange } from "../src/remote-changes.js";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRunner, scriptedPrompter, tempDir } from "./helpers.js";
import { HAS_SH, makeFakeRemote } from "./remote-fixture.js";

const skip = !HAS_SH && "needs a POSIX sh (Git for Windows has one)";

const gateFor = (mode: PermissionMode) => new PermissionGate({ mode, rules: () => [] });
const nobody: Prompter = { approve: async () => assert.fail("a person was asked"), confirm: async () => assert.fail("a person was asked") };
const outputs = (gateway: FakeGateway) => gateway.completions.at(-1)!.body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content as string);
const everythingTheModelSaw = (gateway: FakeGateway) => JSON.stringify(gateway.completions.at(-1)!.body.messages);

/** A remote project and a different local folder, to show that nothing of the local one is ever used. */
const setup = async () => {
    const remote = makeFakeRemote();
    writeFileSync(join(remote.root, "a.ts"), "export const needle = 1;\n");
    mkdirSync(join(remote.root, "src"));
    writeFileSync(join(remote.root, "src", "b.ts"), "const two = 2;\n");
    await remote.workspace.connect();
    const local = tempDir("local-shadow");
    writeFileSync(join(local, "local-only.txt"), "this is on the local computer\n");
    return { remote, local };
};

test("a remote task reads, searches, patches and runs on the remote machine, asks the usual approvals with the machine named, and never touches the local folder", { skip }, async () => {
    const { remote, local } = await setup();
    const gateway = await new FakeGateway({
        script: (body) => {
            const n = toolResultsSinceUser(body).length;
            if (n === 0) return { toolCalls: [{ name: "list_files", args: {} }, { name: "read_file", args: { path: "a.ts" } }, { name: "search_text", args: { pattern: "two" } }] };
            // One result message per call: the three reads of the first step are three messages.
            if (n === 3) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "a.ts", action: "update", replacements: [{ old: "needle = 1", new: "needle = 2" }] }, { path: "src/new.ts", action: "create", content: "export {};\n" }], explanation: "bump" } }] };
            if (n === 4) return { toolCalls: [{ name: "run_command", args: { argv: ["sh", "-c", "cat a.ts && pwd"] } }] };
            return { text: "done" };
        },
    }).start();
    try {
        const seen: ApprovalView[] = [];
        const launched: string[] = [];
        const { runner, journal } = await makeRunner(gateway, local, {
            prompter: scriptedPrompter([true, true], seen),
            runner: { remote: remote.workspace, sandboxed: true, launchCommand: (file) => { launched.push(file); throw new Error("a local launcher must not be used for a remote command"); } },
        });
        assert.equal(await runner.runTask("Bump the constant and show the file."), "success");

        // The files and commands were the remote machine's.
        assert.equal(readFileSync(join(remote.root, "a.ts"), "utf8"), "export const needle = 2;\n");
        assert.equal(readFileSync(join(remote.root, "src", "new.ts"), "utf8"), "export {};\n");
        assert.deepEqual(readdirSync(local), ["local-only.txt"], "the local folder was not written to");
        assert.deepEqual(launched, []);
        const saw = everythingTheModelSaw(gateway);
        assert.ok(!saw.includes("local-only.txt") && !saw.includes("on the local computer"), "nothing of the local folder reaches the model");
        assert.match(saw, /src\/b\.ts:1:const two = 2;/);
        assert.match(saw, /export const needle = 2;/);
        assert.ok(saw.includes(remote.workspace.root), "the command ran in the remote folder");
        assert.match(saw, /Workspace root: [^\n]*on the remote machine devbox/);
        assert.match(saw, /not sandboxed/);

        // The approvals say where they apply, never claim a sandbox, and are bound to the remote files.
        assert.equal(seen.length, 2);
        const [patch, command] = seen as [ApprovalView, ApprovalView];
        assert.deepEqual(patch.remote, { target: "devbox", folder: remote.workspace.root });
        assert.equal(patch.root, remote.workspace.root);
        assert.deepEqual(patch.patch!.map((p) => [p.path, p.action, p.absolute]), [["a.ts", "update", `${remote.workspace.root}/a.ts`], ["src/new.ts", "create", `${remote.workspace.root}/src/new.ts`]]);
        assert.equal(patch.patch![0]!.beforeText, "export const needle = 1;\n");
        assert.equal(patch.sandboxed, undefined);
        assert.equal(command.sandboxed, undefined, "remote commands are never presented as sandboxed");
        assert.equal(command.remote?.target, "devbox");
        assert.equal(command.command!.cwd, remote.workspace.root);
        assert.equal(command.command!.file, "sh");
        assert.equal(journal.state.approvals.length, 2);
        assert.ok(journal.state.approvals[0]!.binding.files?.every((file) => file.disk?.folder.startsWith("/")));

        // The journal holds the changes with backups, and a change can be put back on the remote machine.
        const changes = journal.state.changes;
        assert.deepEqual(changes.map((c) => [c.path, c.kind, c.state]), [["a.ts", "update", "applied"], ["src/new.ts", "create", "applied"]]);
        assert.ok(changes[0]!.preimage.backup && changes[0]!.postimage.backup);
        assert.equal((await remoteViewChange(remote.workspace, changes[0]!)).current, "as_written");
        assert.equal(remoteCanUndoRecord(journal, changes[0]!), true);
        await remoteUndoChange(journal, remote.workspace, changes[1]!.changeId, undefined, true);
        assert.equal(existsSync(join(remote.root, "src", "new.ts")), false);
        await remoteUndoChange(journal, remote.workspace, changes[0]!.changeId, undefined, true);
        assert.equal(readFileSync(join(remote.root, "a.ts"), "utf8"), "export const needle = 1;\n");
        assert.deepEqual(journal.state.changes.map((c) => c.state), ["undone", "undone"]);
        // A file someone else changed since is never put back over their work.
        const [changed] = (await remote.workspace.planPatch([{ path: "a.ts", action: "update", replacements: [{ old: "needle = 1", new: "needle = 9" }] }]));
        await remote.workspace.writeFile(changed!);
        assert.equal((await remoteViewChange(remote.workspace, { ...journal.state.changes[0]!, state: "applied" })).current, "changed_since");
    } finally {
        await gateway.stop();
    }
});

test("the permission modes decide a remote action as they decide a local one: read-only refuses, a credential file never reaches a person, allow-all writes without asking", { skip }, async () => {
    const { remote, local } = await setup();
    writeFileSync(join(remote.root, ".env"), "TOKEN=abc\n");
    const edit = (path: string, action = "create") => ({ toolCalls: [{ name: "apply_patch", args: { edits: [{ path, action, content: "x\n" }] } }] });
    const run = async (mode: PermissionMode, script: (n: number) => any, prompter: Prompter) => {
        const gateway = await new FakeGateway({ script: (body) => script(toolResultsSinceUser(body).length) }).start();
        try {
            const { runner, journal } = await makeRunner(gateway, local, { prompter, runner: { remote: remote.workspace, permissions: gateFor(mode) } });
            await runner.runTask("Do it.");
            return { journal, outputs: outputs(gateway) };
        } finally {
            await gateway.stop();
        }
    };

    const readOnly = await run("read_only", (n) => (n === 0 ? edit("one.txt") : n === 1 ? { toolCalls: [{ name: "run_command", args: { argv: ["touch", "two.txt"] } }] } : { text: "ok" }), nobody);
    assert.deepEqual(readOnly.journal.state.approvals.map((a) => [a.decision, a.policy?.source]), [["denied", "mode"], ["denied", "mode"]]);
    assert.equal(existsSync(join(remote.root, "one.txt")) || existsSync(join(remote.root, "two.txt")), false);

    // .env: refused by the boundary in every mode, and the model is told, not a person.
    const secret = await run("allow_all", (n) => (n === 0 ? edit(".env", "update") : { text: "ok" }), nobody);
    assert.equal(secret.journal.state.approvals[0]?.decision, "denied");
    assert.equal(readFileSync(join(remote.root, ".env"), "utf8"), "TOKEN=abc\n");

    // A path outside the folder is not even offered.
    const asked: ApprovalView[] = [];
    const outside = await run("ask", (n) => (n === 0 ? edit("../escape.txt") : { text: "ok" }), { approve: async (view) => (asked.push(view), true), confirm: async () => false });
    assert.equal(outside.journal.state.approvals[0]?.decision, "denied");
    assert.ok(!existsSync(join(remote.base, "..", "escape.txt")));
    assert.equal(outside.journal.state.changes.length, 0);
    assert.match(asked.length ? "asked" : outside.outputs.join(""), /outside the workspace|Not offered|not approved|denied/i);

    // allow-all writes on the remote machine without a person; the file is really there.
    const allowed = await run("allow_all", (n) => (n === 0 ? edit("auto.txt") : { text: "ok" }), nobody);
    assert.equal(allowed.journal.state.approvals[0]?.by, "permission_policy");
    assert.equal(readFileSync(join(remote.root, "auto.txt"), "utf8"), "x\n");
    assert.deepEqual(readdirSync(local), ["local-only.txt"]);
});

test("when the connection is lost the task cannot write or run anything more, says why, and goes on after a reconnect", { skip }, async () => {
    const { remote, local } = await setup();
    const gateway = await new FakeGateway({
        script: (body) => {
            const n = toolResultsSinceUser(body).length;
            if (n === 0) return { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "a.ts", action: "update", replacements: [{ old: "needle = 1", new: "needle = 2" }] }] } }] };
            if (n === 1) return { toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] };
            if (n === 2) return { toolCalls: [{ name: "run_command", args: { argv: ["sh", "-c", "echo ran"] } }] };
            return { text: "stopped" };
        },
    }).start();
    try {
        const lost: string[] = [];
        remote.workspace.onLost((reason) => lost.push(reason));
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, local, { prompter: scriptedPrompter([true, true], seen), runner: { remote: remote.workspace } });
        // The next ssh call fails: the connection drops while the approval card is being prepared.
        remote.failNext("reset");
        await runner.runTask("Bump it.");
        assert.equal(lost.length, 1);
        assert.equal(remote.workspace.state, "lost");
        assert.equal(readFileSync(join(remote.root, "a.ts"), "utf8"), "export const needle = 1;\n", "nothing was written");
        assert.equal(journal.state.changes.length, 0);
        const results = outputs(gateway).join("\n");
        assert.match(results, /connection to devbox was lost/);
        assert.match(results, /connectionLost/);
        assert.equal(seen.length, 0, "no card is shown for an action that cannot be done");
        // The next write and command are refused up front and the model is told to stop, until someone reconnects.
        assert.ok(journal.state.approvals.every((approval) => approval.decision === "denied"));
        await remote.workspace.connect();
        assert.equal(remote.workspace.blockReason, undefined);
    } finally {
        await gateway.stop();
    }
});

test("a command that runs when the connection goes is reported with an unknown outcome and is not run again on its own", { skip }, async () => {
    const { remote, local } = await setup();
    const gateway = await new FakeGateway({
        script: (body) => (toolResultsSinceUser(body).length === 0
            ? { toolCalls: [{ name: "run_command", args: { command: "echo started; exec sleep 60" } }] } : { text: "stopped" }),
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, local, { prompter: scriptedPrompter([true]), runner: { remote: remote.workspace } });
        // Drop the connection once the first ssh calls (resolving the folder, running) are under way.
        const original = remote.workspace.exec.bind(remote.workspace);
        remote.workspace.exec = (...args) => { remote.failNext("drop-mid", 1, 600); return original(...args); };
        await runner.runTask("Run it.");
        const result = JSON.parse(outputs(gateway)[0]!);
        assert.equal(result.status, "error");
        assert.equal(result.connectionLost, true);
        assert.match(result.note, /outcome is not known/);
        assert.equal(journal.state.tools.at(-1)?.state, "failed");
        assert.equal(remote.workspace.state, "lost");
    } finally {
        await gateway.stop();
    }
});
