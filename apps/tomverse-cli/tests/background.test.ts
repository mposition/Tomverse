/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundCommands } from "../src/background.js";
import { ApprovalMemory } from "../src/approvals.js";
import { CommandError, planCommand } from "../src/commands.js";
import { reconcile } from "../src/runtime.js";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, scriptedPrompter, tempDir } from "./helpers.js";
import type { ApprovalView } from "../src/agent.js";

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

const until = async (check: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
    return check();
};

const plan = (script: string, cwd = tempDir("bg")) =>
    planCommand({ argv: [process.execPath, "-e", script], background: true }, cwd, 120_000);

const PRINTER = `console.log("ready"); let n = 0; setInterval(() => console.log("tick " + (++n)), 100);`;
const TREE = `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log("child " + child.pid); console.log("self " + process.pid); setInterval(() => {}, 1000);`;

test("a background plan has no time limit and refuses timeoutSeconds", () => {
    const cwd = tempDir("bg");
    const background = planCommand({ argv: [process.execPath, "-v"], background: true }, cwd, 120_000);
    assert.equal(background.background, true);
    assert.equal(background.timeoutMs, 0);
    assert.equal(planCommand({ argv: [process.execPath, "-v"] }, cwd, 120_000).background, undefined);
    assert.throws(() => planCommand({ argv: [process.execPath, "-v"], background: true, timeoutSeconds: 5 }, cwd, 120_000), CommandError);
});

test("a background command is read in pieces and stopped with its whole process tree", async () => {
    const commands = new BackgroundCommands();
    try {
        const started = await commands.start(plan(TREE), "call_1", "tree");
        assert.equal(started.info.state, "running");
        assert.match(started.output, /child \d+/);
        const child = Number(/child (\d+)/.exec(started.output)![1]);
        const self = Number(/self (\d+)/.exec(started.output)![1]);
        assert.ok(alive(child) && alive(self), "both processes run after the call returned");
        // Nothing new was written, so the next read is empty rather than a repeat.
        assert.equal(commands.read(started.info.handle).output, "");
        const stopped = await commands.stop(started.info.handle);
        assert.equal(stopped.info.state, "stopped");
        assert.ok(await until(() => !alive(child) && !alive(self)), "the child and its own child are gone");
        assert.equal(commands.running, 0);
    } finally {
        await commands.stopAll();
    }
});

test("read returns only output written since the last read, and tells what it skipped", async () => {
    const commands = new BackgroundCommands();
    try {
        const { info, output } = await commands.start(plan(PRINTER), "call_1", "printer");
        assert.match(output, /ready/);
        await new Promise((resolve) => setTimeout(resolve, 450));
        const first = commands.read(info.handle);
        assert.match(first.output, /tick [0-9]+/);
        assert.ok(!first.output.includes("ready"), "what the start call returned is not returned again");
        assert.equal(first.skippedBytes, 0);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const second = commands.read(info.handle);
        assert.ok(second.output.length > 0, "new output arrived");
        const firstTicks = new Set(first.output.match(/tick [0-9]+/g));
        assert.ok(!(second.output.match(/tick [0-9]+/g) ?? []).some((tick) => firstTicks.has(tick)), "an earlier line is not repeated");
        assert.equal(commands.status(info.handle)[0]!.state, "running");
    } finally {
        await commands.stopAll();
    }
});

test("a command that fails at once is reported as ended, with its exit code", async () => {
    const commands = new BackgroundCommands();
    try {
        const { info, output } = await commands.start(plan(`console.error("boom"); process.exit(3)`), "call_1", "fail");
        assert.equal(info.state, "exited");
        assert.equal(info.exitCode, 3);
        assert.match(output, /boom/);
        assert.equal(commands.running, 0);
    } finally {
        await commands.stopAll();
    }
});

test("at most four background commands run at once", async () => {
    const commands = new BackgroundCommands({ limit: 2 });
    try {
        await commands.start(plan(PRINTER), "call_1", "one");
        await commands.start(plan(PRINTER), "call_2", "two");
        await assert.rejects(commands.start(plan(PRINTER), "call_3", "three"), /2 background commands are already running/);
    } finally {
        await commands.stopAll();
    }
});

test("an unknown handle is an error, not another command's output", async () => {
    const commands = new BackgroundCommands();
    assert.throws(() => commands.read("bg-000000"), /no background command/);
    await assert.rejects(commands.stop("bg-000000"), /no background command/);
});

test("approving 'the same command' does not carry over between background and foreground runs", () => {
    const memory = new ApprovalMemory();
    const cwd = tempDir("bg");
    const view = (background: boolean): ApprovalView => ({
        approvalId: "a", toolCallId: "t", toolName: "run_command", input: {}, root: cwd,
        command: planCommand({ argv: [process.execPath, "-v"], ...(background ? { background } : {}) }, cwd, 120_000),
    });
    assert.equal(memory.remember(view(false)), "same_command");
    assert.equal(memory.match(view(false)), "same_command");
    assert.equal(memory.match(view(true)), null, "a background run is asked on its own");
});

const backgroundScript = (script: string) => (body: any) => {
    const results = toolResultsSinceUser(body);
    if (results.length === 0) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", script], background: true } }] };
    if (results.length === 1) {
        const handle = JSON.parse(results[0].content).handle;
        return { toolCalls: [{ name: "read_background_output", args: { handle } }] };
    }
    return { text: "The server is up." };
};

test("the agent starts a background command through an approval that says so, reads it, and the task's end stops it", async () => {
    const gateway = await new FakeGateway({ script: backgroundScript(TREE) }).start();
    try {
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([true], seen), runner: { backgroundCommands: true } });
        assert.equal(await runner.runTask("Start the dev server."), "success");
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.command!.background, true, "the approval view says it runs in the background");
        const approval = journal.state.approvals[0]!;
        assert.equal(approval.binding.background, true, "the approval is bound to the background run");
        const started = journal.state.tools.find((t) => t.toolName === "run_command")!;
        assert.equal((started.output as any).status, "started");
        const handle = (started.output as any).handle as string;
        assert.match(handle, /^bg-[0-9a-f]{6}$/);
        const pids = [...String((started.output as any).output).matchAll(/(?:child|self) (\d+)/g)].map((m) => Number(m[1]));
        assert.equal(pids.length, 2);
        // The task ended: nothing it started is left running.
        assert.ok(await until(() => pids.every((pid) => !alive(pid))), "the process tree was ended with the task");
        const record = journal.state.background!.find((b) => b.handle === handle)!;
        assert.equal(record.state, "stopped");
        assert.equal(record.endReason, "task_ended");
        // The read tool answered the model with what the command had printed.
        const second = JSON.stringify(gateway.completions[2]!.body.messages.filter((m: any) => m.role === "tool").at(-1));
        assert.match(second, /"state\\?":\\?"running\\?"/);
    } finally {
        await gateway.stop();
    }
});

test("a denied background command starts nothing", async () => {
    const gateway = await new FakeGateway({
        script: (body) => toolResultsSinceUser(body).length ? { text: "ok" } : { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", PRINTER], background: true } }] },
    }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([false]), runner: { backgroundCommands: true } });
        assert.equal(await runner.runTask("Start it."), "success");
        assert.equal(journal.state.tools.length, 0);
        assert.equal(journal.state.background, undefined);
        assert.equal(runner.background.list().length, 0);
    } finally {
        await gateway.stop();
    }
});

test("stopping the task ends a running background command", async () => {
    const gateway = await new FakeGateway({ script: backgroundScript(PRINTER) }).start();
    try {
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([true]), runner: { backgroundCommands: true } });
        const running = runner.runTask("Start the dev server and wait.");
        assert.ok(await until(() => runner.background.running === 1), "the command started");
        runner.cancel();
        await running;
        assert.equal(runner.background.running, 0);
        assert.ok(journal.state.background!.every((b) => b.state !== "running"));
    } finally {
        await gateway.stop();
    }
});

test("a resumed session tells the model its earlier background commands are not running", async () => {
    const gateway = await new FakeGateway({
        script: (body) => {
            const results = toolResultsSinceUser(body);
            if (body.messages.some((m: any) => m.role === "user" && String(m.content).includes("Second task"))) return { text: "Understood." };
            if (results.length === 0) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", PRINTER], background: true } }] };
            return { text: "Started." };
        },
    }).start();
    try {
        const root = makeRepo();
        const { runner, journal, client } = await makeRunner(gateway, root, { prompter: scriptedPrompter([true]), runner: { backgroundCommands: true } });
        assert.equal(await runner.runTask("First task."), "success");
        assert.equal(journal.state.background!.length, 1);
        // A new run of the CLI over the same session: another Runner, another epoch.
        const { Runner } = await import("../src/agent.js");
        const { Workspace } = await import("../src/workspace.js");
        const catalog = (await client.models()).filter((m) => m.tools);
        const resumed = new Runner({ gateway: client, journal, workspace: new Workspace(root), output: (await import("./helpers.js")).captureOutput().output,
            prompter: scriptedPrompter([]), catalog, commandEnv: [], instructions: null, backgroundCommands: true });
        assert.equal(await resumed.runTask("Second task."), "success");
        const system = gateway.completions.at(-1)!.body.messages.find((m: any) => m.role === "system").content as string;
        assert.match(system, /background commands of earlier runs .* were ended with their task/);
        assert.ok(journal.state.background!.every((b) => b.acknowledged === true), "the note is given once, then dropped");
        // A record left "running" by a crash is closed by reconcile and named in its notes.
        journal.state.background!.push({ handle: "bg-aaaaaa", toolCallId: "x", display: "npm run dev", cwd: root, startedAt: new Date().toISOString(), state: "running", epoch: "old" });
        assert.match(reconcile(journal).join("\n"), /bg-aaaaaa .* no longer tracked/);
        assert.equal(journal.state.background!.at(-1)!.state, "exited");
    } finally {
        await gateway.stop();
    }
});

test("a host that did not opt in has no background tools, and a background request is refused before any approval", async () => {
    const gateway = await new FakeGateway({
        script: (body) => (toolResultsSinceUser(body).length ? { text: "ok" } : { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "-e", PRINTER], background: true } }] }),
    }).start();
    try {
        const seen: ApprovalView[] = [];
        const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([true], seen) });
        assert.equal(await runner.runTask("Start the dev server."), "success");
        assert.deepEqual(seen, [], "nothing was put to the person");
        assert.equal(journal.state.tools.length, 0);
        const names = gateway.completions[0]!.body.tools.map((t: any) => t.function.name).sort();
        assert.deepEqual(names, ["apply_patch", "list_files", "read_file", "run_command", "search_text"]);
        assert.doesNotMatch(gateway.completions[0]!.body.messages[0].content, /background: true/);
        assert.match(JSON.stringify(gateway.completions[1]!.body.messages.filter((m: any) => m.role === "tool")), /not available here/);
    } finally {
        await gateway.stop();
    }
});
