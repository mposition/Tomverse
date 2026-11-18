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
import { normalizeRoot, PathError } from "../src/workspace.js";
import { Journal } from "../src/session.js";
import { Runner } from "../src/agent.js";

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
            if (/Summarize this session so far/.test(lastUserText(body))) return { fault: "drop_before_headers" };
            return toolResultsSinceUser(body).length < 3 ? { toolCalls: [{ name: "read_file", args: { path: "big.txt" } }] } : { text: "done" };
        },
        async (gateway) => {
            const { runner, journal } = await makeRunner(gateway, makeRepo({ "big.txt": "가나다 const value = 1; ".repeat(200) }), { prompter: null, model: "fake-small", contextWindow: 9_000 });
            assert.equal(await runner.runTask("Read big.txt a few times"), "unknown_outcome");
            const compact = journal.state.generations.filter((g) => g.purpose === "compact");
            assert.equal(compact.length, 1);
            assert.equal(compact[0]!.lookup, "found", "looked up by its recorded key");
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
        const withEnv = (text.match(/env: commandEnv\(/g) ?? []).length;
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
