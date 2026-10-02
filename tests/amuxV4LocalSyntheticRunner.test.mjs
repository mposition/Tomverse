import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import test from "node:test";

import { runAmuxV4SyntheticAnalysis } from "../lib/amux/ideaLocalSyntheticRunner.mjs";

const input = Buffer.from("SYNTHETIC_ONLY", "utf8");

test("AMUX local analysis refuses model CLI and oversized input before spawning", async () => {
  assert.deepEqual(await runAmuxV4SyntheticAnalysis(["/usr/bin/claude"], input),
    { status: "refused" });
  assert.deepEqual(await runAmuxV4SyntheticAnalysis(["/usr/bin/node"],
    Buffer.alloc(65_537)), { status: "refused" });
});

test("AMUX local synthetic runner bounds output and cleans its socket", {
  skip: process.platform !== "linux" || !existsSync("/usr/bin/bwrap"),
}, async () => {
  const directories = async () => (await readdir("/tmp"))
    .filter((name) => name.startsWith("amux-v4-synthetic-")).sort();
  const before = await directories();
  const success = await runAmuxV4SyntheticAnalysis(["/usr/bin/node", "-e",
    "process.stdin.pipe(process.stdout)"], input);
  assert.equal(success.status, "completed");
  if (success.status === "completed") {
    assert.equal(success.output.toString("utf8"), "SYNTHETIC_ONLY");
    success.output.fill(0);
  }
  const failure = await runAmuxV4SyntheticAnalysis(["/usr/bin/node", "-e",
    "process.stdout.write('X'.repeat(70000))"], input);
  assert.deepEqual(failure, { status: "output_limit" });
  const exitFailure = await runAmuxV4SyntheticAnalysis(["/usr/bin/node", "-e",
    "process.exit(2)"], input);
  assert.deepEqual(exitFailure, { status: "failed" });
  assert.deepEqual(await directories(), before);
});
