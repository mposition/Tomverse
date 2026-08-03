import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Runtime boundary for the error report token (Node-only by policy).
 *
 * lib/errorReportToken.ts depends on node:crypto and must never be pulled
 * into proxy.ts or any Edge-capable bundle. The shared vocabulary lives in
 * lib/errorReportContract.ts precisely so client and Edge code can import
 * the constants without dragging the crypto module along.
 */

const ROOT = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");

test("proxy.ts never imports the Node token or evidence modules", () => {
  const proxy = read("proxy.ts");
  assert.ok(!proxy.includes("errorReportToken"), "proxy imports the token module");
  assert.ok(!proxy.includes("traceErrorEvidence"), "proxy imports the evidence module");
});

test("the token module is the only place that signs, and it is Node-only", () => {
  const token = read("lib/errorReportToken.ts");
  assert.match(token, /from "node:crypto"/);
  // The shared contract stays dependency-free so client bundles can use it.
  const contract = read("lib/errorReportContract.ts");
  assert.ok(!contract.includes("node:"), "the contract module gained a Node dependency");
  assert.ok(!contract.includes('from "@'), "the contract module gained an internal dependency");
});

test("client chat code imports the contract, never the token signer", () => {
  for (const path of [
    "components/chat/ChatApp.tsx",
    "components/chat/FeedbackButton.tsx",
    "components/chat/types.tsx",
    "lib/chatMessageSerialization.ts",
  ]) {
    const source = read(path);
    assert.ok(
      !source.includes("lib/errorReportToken"),
      `${path} imports the Node-only token module`
    );
  }
});
