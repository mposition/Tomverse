import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { access, chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectCliPath, releaseArchiveName, stageCliArchive, supportsCliPath, watchVerifiedCliPath } from "../src/host/provider-cli-path";

const windows = process.platform === "win32";
const codex = windows ? "codex.exe" : "codex";

test("A verified CLI installation is invalidated by a change inside its managed runtime", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "tomverse-cli-watch-"));
  const runtime = join(root, "installed", "runtime", "app");
  const target = join(root, "installed");
  const selected = join(root, "linked installation");
  let close: (() => void) | undefined;
  try {
    await mkdir(runtime, { recursive: true });
    await symlink(target, selected, windows ? "junction" : "dir");
    const entry = join(runtime, "cli.js");
    await writeFile(entry, "original");
    const events = new EventEmitter();
    close = watchVerifiedCliPath("minimax", selected, target, () => events.emit("changed"));
    assert.ok(close);
    const changed = once(events, "changed", { signal: AbortSignal.timeout(5_000) });
    await writeFile(entry, "updated");
    await changed;
  } finally {
    close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI path checks use only the selected file and leave unknown binaries unverified", async () => {
  const root = await mkdtemp(join(tmpdir(), "tomverse-cli-path-"));
  try {
    const directory = join(root, "경로 with spaces & literal characters");
    await mkdir(directory);
    const file = join(directory, codex);
    assert.deepEqual(await inspectCliPath("openai", codex), { status: "invalidPath" });
    if (!supportsCliPath("openai")) {
      assert.deepEqual(await inspectCliPath("openai", file), { status: "unsupportedPlatform" });
      return;
    }
    assert.deepEqual(await inspectCliPath("openai", file), { status: "fileMissing" });
    await writeFile(file, "This is the wrong binary.", { mode: 0o755 });
    assert.deepEqual(await inspectCliPath("openai", file), { status: "wrongFile" });
    const miniMaxSupported = supportsCliPath("minimax");
    assert.deepEqual(await inspectCliPath("minimax", file), { status: miniMaxSupported ? "wrongFile" : "unsupportedPlatform" });
    assert.deepEqual(await inspectCliPath("minimax", directory), { status: miniMaxSupported ? "versionUnverified" : "unsupportedPlatform" });
    await writeFile(join(directory, "current"), "../0.7.9\n");
    assert.deepEqual(await inspectCliPath("minimax", directory), { status: miniMaxSupported ? "versionUnverified" : "unsupportedPlatform" });
    await copyFile(process.execPath, file);
    await chmod(file, 0o755);
    assert.deepEqual(await inspectCliPath("anthropic", file), { status: "wrongFile" });
    assert.deepEqual(await inspectCliPath("openai", file), { status: "versionUnverified" });
    assert.deepEqual(await inspectCliPath("openai", `${file} --version`), { status: "wrongFile" });
    const bundle = join(directory, "zcode.cjs");
    await writeFile(bundle, "#!/usr/bin/env node\n");
    assert.deepEqual(await inspectCliPath("zhipu", bundle), { status: supportsCliPath("zhipu") ? "versionUnverified" : "unsupportedPlatform" });

    for (const [provider, version] of [["qwen", "0.28.4"], ["mistral", "3.1.4"], ["deepseek", "0.2.2-rc.2"]] as const) {
      const archiveName = releaseArchiveName(provider);
      if (!archiveName) continue;
      const archive = join(directory, archiveName);
      await writeFile(archive, "not an archive");
      assert.deepEqual(await inspectCliPath(provider, archive), { status: "wrongFile" });
      await writeFile(archive, Buffer.from(archiveName.endsWith(".tar.gz") ? "1f8b" : "504b0304", "hex"));
      assert.deepEqual(await inspectCliPath(provider, archive), { status: "versionUnverified" });
      assert.deepEqual(await inspectCliPath("openai", archive), { status: "wrongFile" });
      const staged = join(root, archiveName);
      await assert.rejects(stageCliArchive(provider, archive, staged, version, new AbortController().signal), /archive changed/);
      await assert.rejects(access(staged), { code: "ENOENT" });
    }

    if (windows) {
      const shim = join(directory, "codex.cmd");
      await writeFile(shim, '@echo off\r\necho ran>"%~dp0wrapper-ran.txt"\r\n');
      assert.deepEqual(await inspectCliPath("openai", shim), { status: "windowsShim" });
      assert.deepEqual(await inspectCliPath("openai", `${shim}" & whoami.exe`), { status: "wrongFile" });
      await assert.rejects(access(join(directory, "wrapper-ran.txt")), { code: "ENOENT" });
      assert.deepEqual(await inspectCliPath("openai", "\\\\example.invalid\\share\\codex.exe"), { status: "invalidPath" });
      assert.deepEqual(await inspectCliPath("openai", `${file}:codex.exe`), { status: "invalidPath" });
    } else {
      const alias = join(root, codex);
      await symlink(file, alias);
      assert.deepEqual(await inspectCliPath("openai", alias), { status: "versionUnverified" });
      if (process.platform === "darwin") {
        const wrongMachine = Buffer.alloc(64);
        wrongMachine.writeUInt32LE(0xfeedfacf, 0);
        wrongMachine.writeUInt32LE(process.arch === "arm64" ? 0x01000007 : 0x0100000c, 4);
        wrongMachine.writeUInt32LE(2, 12);
        await writeFile(file, wrongMachine);
        assert.deepEqual(await inspectCliPath("openai", alias), { status: "wrongFile" });
      }
      await chmod(file, 0o644);
      assert.deepEqual(await inspectCliPath("openai", alias), { status: "wrongFile" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
