/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FakeGateway, lastUserText, toolResultsSinceUser, type ScriptedReply } from "./fakeGateway.js";
import { makeRepo, makeRunner, scriptedPrompter, tempDir } from "./helpers.js";
import { readKey } from "../src/auth.js";
import { costLine } from "../src/main.js";
import { normalizeRoot, PathError, Workspace } from "../src/workspace.js";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { TEST_KEY } from "./fakeGateway.js";
import { Journal } from "../src/session.js";
import { Runner } from "../src/agent.js";
import { undoChange, UndoError, viewChanges } from "../src/changes.js";
import { chmodSync, renameSync, statSync, symlinkSync } from "node:fs";
import { planCommand, runCommand } from "../src/commands.js";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const withGateway = async (script: (body: any, index: number) => ScriptedReply, run: (g: FakeGateway) => Promise<void>) => {
    const gateway = await new FakeGateway({ script }).start();
    try {
        await run(gateway);
    } finally {
        await gateway.stop();
    }
};

test("an answer received but not saved before a crash is unresolved: resume never sends the step again on its own", () =>
    withGateway(
        () => ({ text: "fine" }),
        async (gateway) => {
            const home = tempDir("home");
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { home, prompter: null });
            await runner.runTask("first");
            // Simulate the crash window: the request completed on the wire, the
            // process died before its answer reached the saved history.
            const lost = journal.newGeneration("agent");
            lost.state = "complete";
            lost.httpStatus = 200;
            lost.requestId = `req_${"a".repeat(32)}`;
            journal.state.status = "running";
            journal.commit();
            journal.release();
            const reopened = Journal.open(home, journal.state.id);
            assert.deepEqual(reopened.unresolvedGenerations().map((g) => g.seq), [lost.seq]);
            const before = gateway.completions.length;
            const again = new Runner({ ...(runner as any).options, journal: reopened, prompter: null });
            assert.match(again.unknownReport(reopened.unresolvedGenerations()[0]!), /answered, but the CLI stopped before the answer was saved/);
            assert.equal(await again.loop(), "unknown_outcome");
            assert.equal(gateway.completions.length, before, "no new request without the user's say");
            const agreeing = new Runner({ ...(runner as any).options, journal: reopened, prompter: scriptedPrompter([true]) });
            assert.equal(await agreeing.loop(), "success");
            assert.equal(gateway.completions.length, before + 1);
            assert.deepEqual(reopened.unresolvedGenerations(), []);
            reopened.release();
        }
    ));

test("a compaction cut off by the network stops before any further paid request", () =>
    withGateway(
        (body) => {
            if (/Summarize this session so far/.test(lastUserText(body))) return { fault: "drop_unrecorded" };
            return toolResultsSinceUser(body).length < 3 ? { toolCalls: [{ name: "read_file", args: { path: "big.txt" } }] } : { text: "done" };
        },
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo({ "big.txt": "가나다 const value = 1; ".repeat(200) }), { prompter: null, model: "fake-small", contextWindow: 9_000 });
            assert.equal(await runner.runTask("Read big.txt a few times"), "unknown_outcome");
            const compact = journal.state.generations.filter((g) => g.purpose === "compact");
            assert.equal(compact.length, 1);
            assert.equal(compact[0]!.lookup, "not_found", "looked up by its recorded key; not found is not taken as free");
            assert.equal(gateway.completions.at(-1)!.body.messages.at(-1).content.includes("Summarize this session"), true, "the compaction was the last request sent");
        }
    ));

test("the key leaves the process environment as soon as it is read, so no helper process can inherit it", async () => {
    const env: NodeJS.ProcessEnv = { TOMVERSE_API_KEY: `tvk_abcdefgh_${"B".repeat(43)}`, PATH: "/bin" };
    assert.equal(await readKey(env), `tvk_abcdefgh_${"B".repeat(43)}`);
    assert.equal(env.TOMVERSE_API_KEY, undefined);
    // Every process the CLI starts is given the minimal environment explicitly.
    for (const file of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
        const text = readFileSync(join(src, file), "utf8");
        const calls = (text.match(/\bspawn(?:Sync)?\(/g) ?? []).length;
        const withEnv = (text.match(/env: (?:commandEnv|gitEnv)\(/g) ?? []).length;
        assert.ok(withEnv >= calls, `${file}: ${calls} process start(s), ${withEnv} with the minimal environment`);
    }
});

test("a session total is never shown as a bare number while part of it is unknown", () => {
    assert.equal(costLine({ requests: 2, charged: 6, held: 0, unknown: [] }), "2 model request(s): 6 credits settled.");
    const open = costLine({ requests: 2, charged: 0, held: 3, unknown: [2] });
    assert.match(open, /0 credits settled, 3 held \(not final\), 1 not found or unknown \(#2\) -- the total is not final/);
});

test("a workspace inside a credential folder is refused", () => {
    const base = tempDir("ws");
    for (const name of [".git", ".ssh", ".aws", ".tomverse"]) {
        const inner = join(base, name, "inner");
        mkdirSync(inner, { recursive: true });
        assert.throws(() => normalizeRoot(inner), PathError, name);
        assert.throws(() => normalizeRoot(join(base, name)), PathError, name);
    }
    assert.ok(normalizeRoot(base));
});

test("no compaction (a paid request) while an earlier outcome is unknown; a later success does not close it", () =>
    withGateway(
        () => ({ text: "summary" }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
            journal.state.messages.push({ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }, { role: "assistant", content: "d" }, { role: "user", content: "e" }, { role: "assistant", content: "f" });
            journal.state.tasks.push({ prompt: "a", startedAt: "", requests: 0, activeMs: 0, allowance: 20, timeAllowanceMs: 900_000 });
            const lost = journal.newGeneration("compact");
            lost.state = "failed";
            assert.equal(await runner.maybeCompact(true), "skipped");
            assert.equal(gateway.completions.length, 0);
            assert.deepEqual(journal.unresolvedGenerations().map((g) => g.seq), [lost.seq]);
        }
    ));

test("resume with a new task does not go past an unknown outcome without a yes at a terminal", { skip: !existsSync(join(src, "..", "dist", "cli.js")) && "build first" }, () =>
    withGateway(
        () => ({ text: "should not be asked" }),
        async (gateway) => {
            const home = tempDir("home");
            const root = makeRepo();
            const { journal } = await makeRunner(gateway, root, { home, prompter: null });
            journal.state.tasks.push({ prompt: "x", startedAt: "", requests: 1, activeMs: 0, allowance: 20, timeAllowanceMs: 900_000 });
            const lost = journal.newGeneration("agent");
            lost.state = "complete";
            lost.httpStatus = 200;
            journal.state.status = "running";
            journal.commit();
            journal.release();
            writeFileSync(join(home, "config.json"), JSON.stringify({ endpoint: gateway.base, allowInsecureLocalhost: true, model: "fake-coder", trustedRoots: [root] }));
            const child = spawn(process.execPath, [join(src, "..", "dist", "cli.js"), "resume", journal.state.id, "--json", "do something else"], {
                cwd: root,
                env: { ...process.env, TOMVERSE_HOME: home, TOMVERSE_API_KEY: TEST_KEY, TOMVERSE_ENDPOINT: "" },
                stdio: ["ignore", "pipe", "pipe"],
            });
            const code = await new Promise((r) => child.on("close", r));
            assert.equal(code, 6);
            assert.equal(gateway.completions.length, 0, "no new paid request");
        }
    ));

test("listing runs git without global config, and repository aliases or fsmonitor never start a program", { skip: spawnSync("git", ["--version"]).status !== 0 && "no git" }, () => {
    const root = tempDir("ws");
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "x");
    const marker = join(root, "ran.txt").replaceAll("\\", "/");
    const program = `${process.execPath.replaceAll("\\", "/")} -e "require('fs').writeFileSync('${marker}','x')"`;
    spawnSync("git", ["config", "alias.ls-files", `!${program}`], { cwd: root });
    spawnSync("git", ["config", "core.fsmonitor", program], { cwd: root });
    const listed = new Workspace(normalizeRoot(root)).listFiles(".", 100);
    assert.equal(listed.source, "git");
    assert.ok(listed.files.includes("a.txt"));
    assert.equal(existsSync(marker), false, "no repository-configured program ran");
});

test("search results are attributed by the whole path, even one containing ':'", { skip: process.platform === "win32" && "':' is not allowed in Windows file names" }, () =>
    withGateway(
        () => ({ text: "x" }),
        async (gateway) => {
            const root = makeRepo();
            mkdirSync(join(root, "project:archive"), { recursive: true });
            writeFileSync(join(root, "project:archive", ".env"), "TOKEN=leak-me\n");
            writeFileSync(join(root, "project:archive", "notes.txt"), "TOKEN=fine\n");
            const { runner } = await makeRunner(gateway, root);
            const result = await (runner.tools.search_text as any).execute({ pattern: "TOKEN" }, { toolCallId: "s1", messages: [] });
            assert.ok(!JSON.stringify(result).includes("leak-me"), JSON.stringify(result));
        }
    ));
test("a cancelled request whose receipt is still held stays unresolved", () =>
    withGateway(
        () => ({ fault: "hang" }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
            const running = runner.runTask("Hi");
            setTimeout(() => runner.cancel(), 300);
            assert.equal(await running, "cancelled");
            assert.equal(journal.state.generations[0]!.receipt?.status, "held");
            assert.equal(journal.unresolvedGenerations().length, 1, "the next request needs the user's say");
        }
    ));

test("undo re-checks the real path: a parent swapped for a link out of the workspace is refused", () =>
    withGateway(
        (body) => (toolResultsSinceUser(body).length ? { text: "ok" } : { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "sub/f.txt", action: "create", content: "new\n" }] } }] }),
        async (gateway) => {
            const root = makeRepo();
            const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([true]) });
            await runner.runTask("create");
            const change = journal.state.changes[0]!;
            // Move the folder out and put a link to it in its place; the file
            // outside now holds exactly what the CLI wrote.
            const outside = tempDir("outside");
            renameSync(join(root, "sub"), join(outside, "sub"));
            symlinkSync(join(outside, "sub"), join(root, "sub"), process.platform === "win32" ? "junction" : "dir");
            assert.equal(viewChanges(journal)[0]!.current, "outside");
            assert.throws(() => undoChange(journal, change.changeId), UndoError);
            assert.equal(readFileSync(join(outside, "sub", "f.txt"), "utf8"), "new\n", "the file outside is untouched");
        }
    ));
test("search attributes each match by its whole path and never returns a credential file's lines", () =>
    withGateway(
        () => ({ text: "x" }),
        async (gateway) => {
            const root = makeRepo({ "src/a.ts": "const TOKEN_NAME = 'ok';\n", "config/credentials.json": '{ "TOKEN_NAME": "leak-me" }\n' });
            const { runner } = await makeRunner(gateway, root);
            const result = await (runner.tools.search_text as any).execute({ pattern: "TOKEN_NAME" }, { toolCallId: "s1", messages: [] });
            assert.equal(result.status, "ok");
            assert.ok(result.matches.includes("src/a.ts:1:const TOKEN_NAME = 'ok';"), JSON.stringify(result));
            assert.ok(!JSON.stringify(result).includes("leak-me"));
        }
    ));

test("a file name with a newline cannot pass as another path", { skip: process.platform === "win32" && "newlines are not allowed in Windows file names" }, () =>
    withGateway(
        () => ({ text: "x" }),
        async (gateway) => {
            const root = makeRepo();
            writeFileSync(join(root, "id_rsa\nnotes.txt"), "TOKEN=leak-me\n");
            const { runner } = await makeRunner(gateway, root);
            const result = await (runner.tools.search_text as any).execute({ pattern: "TOKEN" }, { toolCallId: "s1", messages: [] });
            assert.ok(!JSON.stringify(result).includes("leak-me"), JSON.stringify(result));
        }
    ));
test("a 5xx after dispatch is not taken as final: looked up, left unresolved, no further paid request", () =>
    withGateway(
        () => ({ fault: "http", status: 502, code: "upstream_error" }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
            assert.equal(await runner.runTask("Hi"), "unknown_outcome");
            const [record] = journal.state.generations;
            assert.equal(record!.httpStatus, 502);
            assert.equal(record!.lookup, "not_found");
            assert.equal(journal.unresolvedGenerations().length, 1);
            assert.equal(await runner.runTask("Something else"), "unknown_outcome");
            assert.equal(gateway.completions.length, 1);
        }
    ));

test("cancel also ends a descendant that moved to its own session (setsid)", { skip: process.platform === "win32" && "POSIX sessions" }, async () => {
    const dir = tempDir("tree");
    const marker = join(dir, "survived.txt");
    const grandchild = join(dir, "gc.cjs");
    writeFileSync(grandchild, `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 3000); setInterval(() => {}, 1000);\n`);
    const parent = join(dir, "p.cjs");
    writeFileSync(parent, `require("child_process").spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: "ignore" }).unref(); setInterval(() => {}, 1000);\n`);
    const controller = new AbortController();
    const running = runCommand(planCommand({ argv: [process.execPath, parent] }, dir, 60_000), controller.signal);
    setTimeout(() => controller.abort(), 800);
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.residualProcesses, []);
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(existsSync(marker), false);
});

test("undo of a deleted file restores its permission bits", { skip: process.platform === "win32" && "POSIX modes" }, () =>
    withGateway(
        (body) => (toolResultsSinceUser(body).length ? { text: "ok" } : { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "run.sh", action: "delete" }] } }] }),
        async (gateway) => {
            const root = makeRepo({ "run.sh": "#!/bin/sh\necho hi\n" });
            chmodSync(join(root, "run.sh"), 0o755);
            const { runner, journal } = await makeRunner(gateway, root, { prompter: scriptedPrompter([true]) });
            await runner.runTask("delete it");
            assert.equal(existsSync(join(root, "run.sh")), false);
            undoChange(journal, journal.state.changes[0]!.changeId);
            assert.equal(statSync(join(root, "run.sh")).mode & 0o777, 0o755);
        }
    ));
test("a 4xx whose receipt is still held stays unresolved; a plain 4xx refusal is closed", async () => {
    await withGateway(
        () => ({ fault: "http", status: 400, code: "invalid_request", heldReceipt: true }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
            assert.equal(await runner.runTask("Hi"), "unknown_outcome");
            assert.equal(journal.unresolvedGenerations().length, 1);
        }
    );
    await withGateway(
        () => ({ fault: "http", status: 400, code: "invalid_request" }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
            assert.equal(await runner.runTask("Hi"), "error");
            assert.deepEqual(journal.unresolvedGenerations(), []);
        }
    );
});
test("a compaction refused with a 4xx whose receipt is still held stays unresolved", () =>
    withGateway(
        (body) => {
            if (/Summarize this session so far/.test(lastUserText(body))) return { fault: "http", status: 400, code: "invalid_request", heldReceipt: true };
            return toolResultsSinceUser(body).length < 3 ? { toolCalls: [{ name: "read_file", args: { path: "big.txt" } }] } : { text: "done" };
        },
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo({ "big.txt": "가나다 const value = 1; ".repeat(200) }), { prompter: null, model: "fake-small", contextWindow: 9_000 });
            assert.equal(await runner.runTask("Read big.txt a few times"), "unknown_outcome");
            assert.equal(journal.unresolvedGenerations().filter((g) => g.purpose === "compact").length, 1);
            assert.match(lastUserText(gateway.completions.at(-1)!.body), /Summarize this session so far/, "nothing was sent after it");
        }
    ));

test("a model Smart Adaptive pinned that is no longer offered is never replaced by another", () =>
    withGateway(
        () => ({ text: "should not be asked" }),
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { model: "smart-adaptive", prompter: null });
            journal.state.model.pinned = "retired-model";
            journal.state.model.pinnedFrom = "smart_adaptive_first_response";
            assert.equal(await runner.runTask("Hi"), "error");
            assert.equal(gateway.completions.length, 0);
            assert.match(journal.state.lastError ?? "", /does not switch models/);
        }
    ));
test("when the lookup itself fails after a 4xx, the request stays unresolved", () =>
    withGateway(
        () => ({ fault: "http", status: 400, code: "invalid_request" }),
        async (gateway) => {
            gateway.statusFails = true;
            const { runner, journal } = await makeRunner(gateway, makeRepo(), { prompter: null });
            assert.equal(await runner.runTask("Hi"), "unknown_outcome");
            assert.equal(journal.unresolvedGenerations().length, 1);
        }
    ));

test("without ps the command result says the process tree could not be checked", { skip: process.platform === "win32" && "POSIX ps" }, async () => {
    const savedPath = process.env.PATH;
    const empty = tempDir("nops");
    const plan = planCommand({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }, empty, 60_000);
    process.env.PATH = empty;
    try {
        const controller = new AbortController();
        const running = runCommand(plan, controller.signal);
        setTimeout(() => controller.abort(), 500);
        const result = await running;
        assert.equal(result.cancelled, true);
        assert.equal(result.processTreeChecked, false);
    } finally {
        process.env.PATH = savedPath;
    }
});