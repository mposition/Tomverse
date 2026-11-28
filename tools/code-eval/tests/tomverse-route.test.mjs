// End to end check of the tomverse route against the CLI's own wire-level fake
// of the Tomverse API on 127.0.0.1. No real model request and no credits are
// involved; the "model" only answers what this file scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
import { runJob } from "../run.mjs";
import { loadTask } from "../lib/tasks.mjs";
import { route } from "../routes/tomverse.mjs";

const { FakeGateway, TEST_KEY } = await tsImport("../../../apps/tomverse-cli/tests/fakeGateway.ts", import.meta.url);

const patch = (path, replacements) => ({ path, action: "update", replacements });

const fixPagination = {
    name: "apply_patch",
    args: {
        explanation: "fix the page count, the size cap and the clamp",
        edits: [
            patch("src/paginate.js", [{ old: "return Math.floor(total / size);", new: "return Math.ceil(total / size);" }]),
            patch("src/query.js", [{ old: "Math.max(size, defaults.maxSize)", new: "Math.min(size, defaults.maxSize)" }]),
            patch("src/list.js", [
                {
                    old: "    const { page, size } = parsePagination(query);\n    const pages = pageCount(items.length, size);",
                    new: "    const parsed = parsePagination(query);\n    const size = parsed.size;\n    const pages = pageCount(items.length, size);\n    const page = Math.min(parsed.page, pages);",
                },
            ]),
        ],
    },
};

const environment = (fake) => ({
    ...process.env,
    TOMVERSE_API_KEY: TEST_KEY,
    TOMVERSE_ENDPOINT: fake.base,
    TOMVERSE_ALLOW_INSECURE_LOCALHOST: "1",
});

test("the tomverse route fixes a task through the runtime API with automatic, folder-bound approvals", async () => {
    const task = loadTask("bf-pagination");
    const fake = await new FakeGateway({
        script: (_body, index) => {
            if (index === 0) return { toolCalls: [fixPagination] };
            // A command that reaches the network: the harness must refuse it.
            if (index === 1) return { toolCalls: [{ name: "run_command", args: { argv: ["curl", "https://example.com/"] } }] };
            if (index === 2) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "--test"] } }] };
            return { text: "Fixed the three causes and the tests pass." };
        },
    }).start();
    try {
        const record = await runJob({ route, task, options: {}, env: environment(fake) });
        assert.equal(record.adapterStatus, "ok", record.adapterError);
        assert.equal(record.passed, true, record.checkOutputTail);
        assert.equal(record.changedFiles, 3);
        assert.equal(record.approvals.approved, 2);
        assert.equal(record.approvals.denied, 1);
        assert.match(record.approvals.deniedReasons[0], /network/);
        assert.equal(fake.completions.length, 4);
        assert.equal(record.metrics.turns, 4);
        assert.equal(record.metrics.credits, 3 * fake.completions.length);
        assert.equal(record.metrics.inputTokens, 400);
        assert.equal(record.metrics.outputTokens, 80);
        // Smart Adaptive picks a model on the first answer; the session keeps it.
        assert.equal(fake.completions[0].body.model, "smart-adaptive");
        assert.ok(!JSON.stringify(record).includes(TEST_KEY), "the key must not be recorded");
        // The engine conditions of the run are recorded: the extended profile and every engine feature, but no web and no memory.
        assert.deepEqual(record.engine, {
            limits: { profile: "extended", maxRequests: 200, timeoutMs: task.timeoutSeconds * 1000 },
            features: ["backgroundCommands", "images", "nestedInstructions", "subagents"],
        });
        const names = fake.completions[0].body.tools.map((t) => t.function.name);
        assert.ok(names.includes("delegate"), "subagents are on");
        assert.ok(names.includes("read_background_output"), "background commands are on");
        assert.ok(!names.includes("web_fetch"), "web_fetch is never on in a measurement");
        assert.ok(!names.includes("web_search"), "web_search is never on in a measurement");
        assert.ok(!names.includes("remember_fact"), "the Code memory is never on in a measurement");
    } finally {
        await fake.stop();
    }
});

const isSubagent = (body) => /subagent of Tomverse CLI/.test(String(body.messages?.[0]?.content));

test("a task can use subagents: their requests count in the turns and the credits, and are recorded apart", async () => {
    const task = loadTask("bf-pagination");
    let main = 0;
    const fake = await new FakeGateway({
        script: (body) => {
            if (isSubagent(body)) {
                return body.messages.some((m) => m.role === "tool")
                    ? { text: "paginate.js divides with Math.floor; it should round up." }
                    : { toolCalls: [{ name: "read_file", args: { path: "src/paginate.js" } }] };
            }
            const step = main++;
            if (step === 0) return { toolCalls: [{ name: "delegate", args: { kind: "explore", tasks: ["Find where the page count is computed"] } }] };
            if (step === 1) return { toolCalls: [fixPagination] };
            if (step === 2) return { toolCalls: [{ name: "run_command", args: { argv: [process.execPath, "--test"] } }] };
            return { text: "Fixed it after the subagent found the page count." };
        },
    }).start();
    try {
        const record = await runJob({ route, task, options: {}, env: environment(fake) });
        assert.equal(record.adapterStatus, "ok", record.adapterError);
        assert.equal(record.passed, true, record.checkOutputTail);
        assert.equal(fake.completions.length, 6, "four requests of the main agent and two of the subagent");
        assert.equal(record.metrics.subagentRuns, 1);
        assert.equal(record.metrics.subagentRequests, 2);
        assert.equal(record.metrics.turns, 6);
        assert.equal(record.metrics.credits, 3 * 6);
        assert.equal(record.approvals.approved, 2, "the subagent needed no approval; the main agent's patch and command did");
        const sub = fake.completions.filter((c) => isSubagent(c.body));
        assert.ok(sub.every((c) => !c.body.tools.some((t) => ["delegate", "apply_patch", "run_command"].includes(t.function.name))), "an explore subagent can only read");
        assert.ok(record.engine.features.includes("subagents"));
    } finally {
        await fake.stop();
    }
});

test("--limits and --engine decide what the run records and what the agent is given", async () => {
    const task = loadTask("bf-pagination");
    const fake = await new FakeGateway({ script: () => ({ text: "Nothing to change." }) }).start();
    try {
        const standard = await runJob({ route, task, options: { limits: "standard", engine: [] }, env: environment(fake) });
        assert.equal(standard.adapterStatus, "ok", standard.adapterError);
        assert.deepEqual(standard.engine, { limits: { profile: "standard", maxRequests: 20, timeoutMs: task.timeoutSeconds * 1000 }, features: [] });
        const names = fake.completions[0].body.tools.map((t) => t.function.name);
        assert.deepEqual(names.sort(), ["apply_patch", "list_files", "read_file", "run_command", "search_text"], "no engine feature, no extra tool");
        // A request count given on the command line wins over the profile; unlimited records no number.
        const capped = await runJob({ route, task, options: { limits: "extended", maxRequests: 7, engine: ["images"] }, env: environment(fake) });
        assert.equal(capped.engine.limits.maxRequests, 7);
        assert.deepEqual(capped.engine.features, ["images"]);
        const unlimited = await runJob({ route, task, options: { limits: "unlimited" }, env: environment(fake) });
        assert.deepEqual([unlimited.engine.limits.profile, unlimited.engine.limits.maxRequests], ["unlimited", null]);
    } finally {
        await fake.stop();
    }
});

test("without any change the same task fails its check even though the agent finished", async () => {
    const task = loadTask("bf-pagination");
    const fake = await new FakeGateway({ script: () => ({ text: "I looked at it and changed nothing." }) }).start();
    try {
        const record = await runJob({ route, task, options: {}, env: environment(fake) });
        assert.equal(record.adapterStatus, "ok");
        assert.equal(record.passed, false);
        assert.equal(record.changedFiles, 0);
        assert.equal(record.approvals.approved, 0);
    } finally {
        await fake.stop();
    }
});

test("an unknown model is an adapter error that lists what the key can use", async () => {
    const task = loadTask("bf-pagination");
    const fake = await new FakeGateway({ script: () => ({ text: "unused" }) }).start();
    try {
        const record = await runJob({ route, task, options: { model: "no-such-model" }, env: environment(fake) });
        assert.equal(record.adapterStatus, "error");
        assert.match(record.adapterError, /"no-such-model" is not offered.*smart-adaptive/);
        assert.equal(record.passed, false);
        assert.equal(fake.completions.length, 0);
    } finally {
        await fake.stop();
    }
});

test("a missing key is reported without any request", async () => {
    const task = loadTask("bf-pagination");
    const fake = await new FakeGateway({ script: () => ({ text: "unused" }) }).start();
    try {
        const withoutKey = environment(fake);
        delete withoutKey.TOMVERSE_API_KEY;
        const record = await runJob({ route, task, options: {}, env: withoutKey });
        assert.equal(record.adapterStatus, "error");
        assert.match(record.adapterError, /TOMVERSE_API_KEY is not set/);
        assert.equal(fake.requests.length, 0);
    } finally {
        await fake.stop();
    }
});
