import assert from "node:assert/strict";
import test from "node:test";
import { sessionCost } from "../src/runtime.js";
import { DEFAULT_MODELS, FakeGateway } from "./fakeGateway.js";
import { makeRepo, makeRunner } from "./helpers.js";

test("Smart Adaptive keeps its unsupported pin and records Default through tools, compaction and resume", async () => {
    const fake = await new FakeGateway({
        models: DEFAULT_MODELS.map(model => ({ ...model, tomverse: { ...model.tomverse, reasoning_efforts: model.id === "smart-adaptive" ? ["high"] : [] } })),
        routedModel: "fake-coder",
        script: (_body, index) => index === 0 ? { toolCalls: [{ name: "read_file", args: { path: "sum.js" } }] } : { text: "Done" },
    }).start();
    try {
        const { runner, journal, client } = await makeRunner(fake, makeRepo(), { model: "smart-adaptive", readOnly: true });
        assert.equal(await runner.runTask("Read the file", "high"), "success");
        assert.equal(fake.completions.length, 2);
        assert.equal(journal.state.model.pinned, "fake-coder");
        assert.deepEqual(journal.state.generations.map(record => record.appliedEffort), ["default", "default"]);
        // A long history makes forced compaction perform an actual paid-path request to the fake server.
        journal.state.messages.unshift({ role: "user", content: "old context ".repeat(3000) }, { role: "assistant", content: "old response ".repeat(3000) });
        const beforeCompact = fake.completions.length;
        await runner.maybeCompact(true);
        assert.equal(fake.completions.length, beforeCompact + 1);
        assert.equal(journal.state.generations.at(-1)!.purpose, "compact");
        assert.equal(journal.state.generations.at(-1)!.appliedEffort, "default");
        assert.equal(await runner.loop(), "success");
        assert.equal(journal.state.generations.at(-1)!.appliedEffort, "default");
        assert.ok(fake.completions.slice(1).every(request => request.body.model === "fake-coder"));
        assert.equal(journal.state.tasks.at(-1)!.effort, "high");
        assert.deepEqual(await sessionCost(client, journal), { requests: 4, charged: 12, held: 0, unknown: [] });
        assert.equal(journal.state.generations.find(record => record.purpose === "compact")?.receipt?.chargedCredits, 3);
        assert.equal(fake.completions.length, 4, "receipt reads do not repeat generation");
        journal.release();
    } finally {
        await fake.stop();
    }
});
