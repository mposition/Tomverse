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
