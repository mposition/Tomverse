import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync,
  rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { chatReleaseSourceFingerprint, chatReleaseSourcePaths } from
  "../lib/chatReleaseSourceFingerprint.ts";

const repository = resolve(import.meta.dirname, "..");

test("unrelated deployment source is stable; execution drift and missing source close", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-release-fingerprint-"));
  const copy = (path) => {
    const destination = join(root, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repository, ...path.split("/")), destination,
      { recursive: true });
  };
  try {
    const paths = chatReleaseSourcePaths(repository);
    for (const path of [
      "lib/anthropicPromptCaching.ts",
      "lib/servedProcessingTier.ts",
      "lib/webSearchNativeCostReservation.ts",
      "lib/webSearchCredits.ts",
      "lib/perplexityUsageCapture.ts",
      "lib/pinnedDeploymentExecution.ts",
      "lib/conversationKindGuard.ts",
    ]) assert.ok(paths.includes(path), `execution closure omits ${path}`);
    for (const path of paths) copy(path);
    copy("lib/amux/workerRegistryCore.ts");
    copy("prisma/schema.prisma");
    copy("package-lock.json");
    let original;
    try { original = chatReleaseSourceFingerprint(root); }
    catch (error) { throw error.cause ?? error; }
    const lockPath = join(root, "package-lock.json");
    const originalLock = readFileSync(lockPath);
    const lock = JSON.parse(originalLock.toString("utf8"));
    assert.ok(lock.packages["node_modules/eslint"]);
    assert.ok(lock.packages["node_modules/ai"]);
    lock.packages["node_modules/eslint"].version = "0.0.0-unrelated";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.equal(chatReleaseSourceFingerprint(root), original);
    lock.packages["node_modules/ai"].version = "0.0.0-provider-drift";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.notEqual(chatReleaseSourceFingerprint(root), original);
    writeFileSync(lockPath, originalLock);
    appendFileSync(join(root, "lib", "amux", "workerRegistryCore.ts"),
      "\n// Unrelated AMUX change.\n");
    assert.equal(chatReleaseSourceFingerprint(root), original);
    appendFileSync(join(root, "lib", "chatRefinerInitialAutoRelease.ts"),
      "\n// Execution boundary changed.\n");
    const changedExecution = chatReleaseSourceFingerprint(root);
    assert.notEqual(changedExecution, original);
    appendFileSync(join(root, "lib", "anthropicPromptCaching.ts"),
      "\n// Provider execution drift.\n");
    const changedProvider = chatReleaseSourceFingerprint(root);
    assert.notEqual(changedProvider, changedExecution);
    appendFileSync(join(root, "packages", "chat-core", "src",
      "completionStatus.ts"), "\n// Shared execution drift.\n");
    assert.notEqual(chatReleaseSourceFingerprint(root), changedProvider);
    rmSync(join(root, "app", "api", "chat", "route.ts"));
    assert.throws(() => chatReleaseSourceFingerprint(root),
      /chat_release_source_unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
