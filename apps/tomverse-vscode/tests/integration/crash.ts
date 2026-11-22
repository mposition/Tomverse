import * as vscode from "vscode";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { TEST_KEY } from "../../../tomverse-cli/tests/fakeGateway.js";
import { t } from "../../src/i18n.js";
import { digest } from "../../src/security.js";
import type { SessionController } from "../../src/sessionController.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (condition: () => boolean) => {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > 20_000) throw new Error("Crash fixture timed out");
        await sleep(20);
    }
};
export async function run() {
    const base = process.env.TOMVERSE_CRASH_BASE!;
    const artifact = process.env.TOMVERSE_CRASH_ARTIFACT!;
    await vscode.workspace.getConfiguration("tomverse").update("endpoint", base, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("tomverse").update("allowInsecureLocalhost", true, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension("tomverse.tomverse-vscode")!;
    const { controller, context } = (await extension.activate()) as { controller: SessionController; context: vscode.ExtensionContext };
    await context.secrets.store(`key:${digest(base)}`, TEST_KEY);
    await controller.refresh();
    if (process.env.TOMVERSE_CRASH_PHASE === "seed") {
        controller.dialogs.pick = async (items) => items.find((item) => item.label === t("effort_high"));
        const initial = controller.snapshot();
        await controller.receive({ channel: initial.channel, run: initial.run, type: "chooseEffort", model: "fake-coder" });
        const snapshot = controller.snapshot();
        void controller.receive({
            channel: snapshot.channel,
            run: snapshot.run,
            epoch: snapshot.epoch,
            type: "send",
            prompt: "Run the local crash fixture",
            mode: "agent",
            model: "fake-coder",
        });
        await until(() => Boolean(controller.snapshot().approval));
        const pending = controller.snapshot();
        await controller.receive({ channel: pending.channel, run: pending.run, type: "approve", id: pending.approval!.id, decision: "once" });
        await until(() => controller.snapshot().notice.trim() === "crash-command-started");
        writeFileSync(
            join(artifact, "ready.json"),
            JSON.stringify({ session: controller.snapshot().session, hostPid: process.pid, state: controller.snapshot().state }),
        );
        // Parent kills this isolated test window and its process tree without deactivate.
        await new Promise(() => undefined);
    } else {
        const prior = JSON.parse(readFileSync(join(artifact, "ready.json"), "utf8"));
        await controller.chooseSession(prior.session);
        const snapshot = controller.snapshot();
        assert.equal(snapshot.state, "unknown_outcome");
        assert.ok(snapshot.notice.includes("outcome is unknown"));
        assert.equal(snapshot.permissions.length, 0);
        assert.equal(snapshot.approval, null);
        assert.equal(snapshot.effort.level, "high");
        assert.equal(snapshot.effort.locked, true);
        await assert.rejects(
            controller.receive({ channel: snapshot.channel, run: snapshot.run, type: "chooseEffort", model: "fake-coder" }),
            /Fixed for this task/,
        );
        controller.dialogs.choose = async () => t("cancel");
        await controller.action("recover");
        assert.equal(controller.snapshot().state, "unknown_outcome", "declining resume preserves started-tool uncertainty");
        assert.equal(controller.snapshot().busy, false);
        writeFileSync(
            join(artifact, "recovered.json"),
            JSON.stringify({
                session: snapshot.session,
                state: snapshot.state,
                notice: snapshot.notice,
                recoveryDeclinedState: controller.snapshot().state,
                effort: controller.snapshot().effort,
                vscode: vscode.version,
                node: process.versions.node,
                platform: process.platform,
                extensionPath: extension.extensionPath,
            }),
        );
        console.log("PASS actual forced Extension Host termination: stale lock reclaimed, command unknown, no replay");
        await controller.dispose();
    }
}
