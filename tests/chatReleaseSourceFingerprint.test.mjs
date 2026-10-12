import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { chatReleaseSourceFingerprint } from
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
    copy("lib");
    copy("app/api/chat/route.ts");
    copy("app/api/products/chat/capabilities/route.ts");
    copy("app/api/admin/prompt-refiner");
    copy("packages/chat-core/src");
    copy("docs/policy/chat-refiner-stable-release-authority-v2.md");
    copy("prisma/schema.prisma");
    const original = chatReleaseSourceFingerprint(root);
    appendFileSync(join(root, "lib", "amux", "workerRegistryCore.ts"),
      "\n// Unrelated AMUX change.\n");
    assert.equal(chatReleaseSourceFingerprint(root), original);
    appendFileSync(join(root, "lib", "chatRefinerInitialAutoRelease.ts"),
      "\n// Execution boundary changed.\n");
    const changedExecution = chatReleaseSourceFingerprint(root);
    assert.notEqual(changedExecution, original);
    appendFileSync(join(root, "packages", "chat-core", "src",
      "completionStatus.ts"), "\n// Shared execution drift.\n");
    assert.notEqual(chatReleaseSourceFingerprint(root), changedExecution);
    rmSync(join(root, "app", "api", "chat", "route.ts"));
    assert.throws(() => chatReleaseSourceFingerprint(root),
      /chat_release_source_unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
