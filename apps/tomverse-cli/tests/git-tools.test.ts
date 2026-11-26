/* eslint-disable @typescript-eslint/no-explicit-any -- wire-format fixtures: request bodies are arbitrary JSON */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeGateway, toolResultsSinceUser } from "./fakeGateway.js";
import { makeRepo, makeRunner, scriptedPrompter } from "./helpers.js";
import type { GitToolAction, GitToolReply } from "../src/git-tools.js";

const names = (gateway: FakeGateway) => gateway.completions.flatMap((c) => c.body.tools.map((t: any) => t.function.name as string));
const callOnce = (name: string, args: unknown) => (body: any) =>
    toolResultsSinceUser(body).length === 0 ? { toolCalls: [{ name, args }] } : { text: "Done." };

test("commit_changes and publish_changes exist only for a host that gave the Runner a git host, and never in a read-only session", async () => {
    for (const [label, options] of [["no host", {}], ["read-only", { readOnly: true, runner: { git: async () => null } }]] as const) {
        const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
        try {
            const { runner } = await makeRunner(gateway, makeRepo(), options);
            await runner.runTask("hi");
            assert.ok(!names(gateway).some((n) => n === "commit_changes" || n === "publish_changes"), label);
        } finally { await gateway.stop(); }
    }
    const gateway = await new FakeGateway({ script: () => ({ text: "ok" }) }).start();
    try {
        const { runner } = await makeRunner(gateway, makeRepo(), { runner: { git: async () => null } });
        await runner.runTask("hi");
        assert.ok(names(gateway).includes("commit_changes") && names(gateway).includes("publish_changes"));
    } finally { await gateway.stop(); }
});

test("A publish request reaches the host as asked, and the model's answer is the host's reply, never an approval of its own", async () => {
    const seen: GitToolAction[] = [];
    const host = async (action: GitToolAction): Promise<GitToolReply> => { seen.push(action); return { status: "denied" }; };
    const gateway = await new FakeGateway({ script: callOnce("publish_changes", { remoteBranch: "feature/x", pullRequest: { title: "T", body: "B", base: "main", draft: true } }) }).start();
    try {
        const { runner } = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([]), runner: { git: host } });
        assert.equal(await runner.runTask("Publish it."), "success");
        assert.deepEqual(seen, [{ kind: "publish", remoteBranch: "feature/x", pullRequest: { title: "T", body: "B", base: "main", draft: true } }]);
        assert.match(JSON.stringify(toolResultsSinceUser(gateway.completions[1]!.body)), /denied/);
    } finally { await gateway.stop(); }
});

test("There is no input that approves, forces or deletes: such a call never reaches the host", async () => {
    let calls = 0;
    const host = async (): Promise<GitToolReply> => { calls += 1; return { status: "published", remote: "origin", branch: "x", sha: "a".repeat(40) }; };
    for (const [name, args] of [["publish_changes", { approved: true }], ["publish_changes", { force: true }], ["commit_changes", { message: "m", paths: ["a"], approved: true }], ["publish_changes", { delete: "main" }]] as const) {
        const gateway = await new FakeGateway({ script: callOnce(name, args) }).start();
        try {
            const { runner } = await makeRunner(gateway, makeRepo(), { prompter: scriptedPrompter([]), runner: { git: host } });
            await runner.runTask("Try.");
        } finally { await gateway.stop(); }
    }
    assert.equal(calls, 0);
});
