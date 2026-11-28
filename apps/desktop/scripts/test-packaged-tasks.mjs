import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { stat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { inspectAppArchive, inspectWindowsIntegrity, sha256File } from "./package-payload.mjs";

const target = `${process.platform}-${process.arch}`;
const name = "Tomverse Desktop Task QA";
for (const vendor of ["CODEX", "CLAUDE"]) {
  const binary = process.env[`TOMVERSE_DESKTOP_${vendor}_TASK_BINARY`];
  if (!binary || !isAbsolute(binary) || !(await stat(binary).catch(() => null))?.isFile()) {
    throw new Error(`Set TOMVERSE_DESKTOP_${vendor}_TASK_BINARY to the pinned official CLI file.`);
  }
}

// On Windows a package inherits its parent's ACL. Keep binaries out of the
// special Temp ACL while the fixture's workspace and profile remain temporary.
const packageParent = process.platform === "win32" ? process.env.LOCALAPPDATA ?? tmpdir() : tmpdir();
const out = await mkdtemp(join(await realpath(packageParent), "tomverse-packaged-task-qa-"));
try {
  execFileSync(process.execPath, ["scripts/package.mjs", "--task-qa", "--out", out], { stdio: "inherit", windowsHide: true });
  const bundle = join(out, `${name}-${target}`);
  const macApplication = join(bundle, `${name}.app`, "Contents");
  const executable = process.platform === "darwin" ? join(macApplication, "MacOS", name)
    : join(bundle, process.platform === "win32" ? `${name}.exe` : name);
  const archive = process.platform === "darwin" ? join(macApplication, "Resources", "app.asar") : join(bundle, "resources", "app.asar");
  assert.throws(() => inspectAppArchive(archive), /tomverse-desktop-task-qa/);
  if (process.platform === "win32") await inspectWindowsIntegrity(executable, archive);
  const missingFixture = spawnSync(executable, [`--user-data-dir=${join(out, "admission-profile")}`],
    { timeout: 15_000, windowsHide: true, stdio: "ignore" });
  assert.ifError(missingFixture.error);
  assert.equal(missingFixture.status, 64, "Packaged task QA must require a local native fixture.");
  console.log(JSON.stringify({ packagedTaskQa: true, target, releaseArchiveRejected: true,
    missingFixtureRejected: true, executableSha256: await sha256File(executable), archiveSha256: await sha256File(archive) }));

  execFileSync(process.execPath, ["scripts/run-on-test-desktop.mjs", "--import", "tsx", "--test", "--test-concurrency=1",
    "tests/apiCliAgentContinuation.e2e.ts", "tests/claudeDesktop.e2e.ts", "tests/codexDesktop.e2e.ts", "tests/codexEdits.e2e.ts",
    "tests/continuationRecovery.e2e.ts", "tests/taskList.e2e.ts",
    ...(process.env.TOMVERSE_DESKTOP_GROK_TASK_BINARY || process.env.TOMVERSE_DESKTOP_KIMI_TASK_BINARY ||
      process.env.TOMVERSE_DESKTOP_MINIMAX_TASK_DIR || process.env.TOMVERSE_DESKTOP_VIBE_TASK_ARCHIVE ? ["tests/structuredQuota.e2e.ts"] : []),
    ...(process.env.TOMVERSE_DESKTOP_QWEN_TASK_BINARY || process.env.TOMVERSE_DESKTOP_KIMI_TASK_BINARY ? ["tests/acpDesktop.e2e.ts"] : []),
    ...(process.env.TOMVERSE_DESKTOP_QWEN_TASK_BINARY ? ["tests/qwenSubscriptionQuota.e2e.ts"] : []),
    ...(process.env.TOMVERSE_DESKTOP_VIBE_TASK_ARCHIVE || process.env.TOMVERSE_DESKTOP_MINIMAX_TASK_DIR ||
      process.env.TOMVERSE_DESKTOP_GROK_TASK_BINARY || process.env.TOMVERSE_DESKTOP_ANTIGRAVITY_TASK_BINARY ?
      ["tests/mcpDesktop.e2e.ts"] : [])], {
    stdio: "inherit", windowsHide: true, env: { ...process.env, TOMVERSE_DESKTOP_TASK_QA_EXECUTABLE: executable },
  });
} finally {
  await rm(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
