import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProcess } from "../src/readprocess.js";
import { Workspace } from "../src/workspace.js";
import { makeRunner, tempDir } from "./helpers.js";
import { FakeGateway } from "./fakeGateway.js";

test("bounded read subprocess remains responsive, aborts and caps output", async () => {
    const controller = new AbortController();
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 10);
    const pending = readProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd: tempDir("abort"),
        env: {},
        signal: controller.signal,
        timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /cancelled/);
    clearInterval(heartbeat);
    assert.ok(ticks > 2);
    await assert.rejects(
        readProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000))"], {
            cwd: tempDir("output"),
            env: {},
            signal: new AbortController().signal,
            timeoutMs: 5000,
            maxBytes: 1024,
        }),
        /output limit/,
    );
});
test("without rg, literal search yields and regex is explicitly unsupported", async () => {
    const fake = await new FakeGateway({ script: () => ({ text: "unused" }) }).start();
    const root = tempDir("literal");
    writeFileSync(join(root, "text.txt"), "a".repeat(100000) + "!\nneedle\n");
    const { runner, journal } = await makeRunner(fake, root, { readOnly: true });
    const oldPath = process.env.PATH;
    const oldPathMixed = process.env.Path;
    try {
        process.env.PATH = "";
        process.env.Path = "";
        const search = runner.tools.search_text!.execute!;
        const options = { toolCallId: "test", messages: [] };
        const regex = (await search({ pattern: "(a+)+$", regex: true }, options)) as any;
        assert.equal(regex.status, "unsupported");
        const literal = (await search({ pattern: "needle" }, options)) as any;
        assert.equal(literal.engine, "builtin");
        assert.equal(literal.matches.length, 1);
    } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldPathMixed === undefined) delete process.env.Path;
        else process.env.Path = oldPathMixed;
        journal.release();
        await fake.stop();
    }
});
test("large async file listing yields to the host and observes cancellation", async () => {
    const root = tempDir("listing");
    for (let i = 0; i < 1500; i++) writeFileSync(join(root, `${i}.txt`), "x");
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 1);
    const listing = await new Workspace(root, []).listFilesAsync(".", 2000, new AbortController().signal);
    clearInterval(heartbeat);
    assert.equal(listing.files.length, 1500);
    assert.ok(ticks > 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(new Workspace(root, []).listFilesAsync(".", 2000, controller.signal));
});
