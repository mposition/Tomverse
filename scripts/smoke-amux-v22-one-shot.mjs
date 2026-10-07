import { randomUUID } from "node:crypto";

import { runAmuxV22OneShot } from "../lib/amux/v22OneShotSidecar.mjs";

if (process.env.AMUX_V22_SMOKE_LIVE !== "approved") {
  throw new Error("live smoke requires explicit approval marker");
}
const config = Object.freeze({
  worker: process.env.TOMVERSE_AMUX_V22_WORKER,
  binaryPath: process.env.TOMVERSE_AMUX_V22_CLAUDE_BINARY,
  worktreePath: process.env.TOMVERSE_AMUX_V22_WORKTREE,
  homePath: process.env.TOMVERSE_AMUX_V22_HOME,
  claudeConfigDir: process.env.TOMVERSE_AMUX_V22_CLAUDE_CONFIG_DIR,
});
const result = await runAmuxV22OneShot({ version: 1,
  attemptId: randomUUID(), worker: config.worker,
  modelId: process.env.TOMVERSE_AMUX_V22_SMOKE_MODEL,
  role: "design", budgetMicrousd: 1_000_000,
  prompt: "Return exactly S0_OK. Do not use tools or read local files.",
}, config);
console.log(JSON.stringify({ kind: result.kind,
  cliStarted: result.cliStarted, failure: result.failure ?? null,
  receiptDigest: result.usageReceiptDigest ?? null,
  actualModelId: result.usageReceipt?.actualModelId ?? null,
  completeness: result.usageReceipt?.completeness ?? null,
  observed: result.usageReceipt?.observed ?? null,
}));
if (result.kind !== "succeeded" ||
    result.usageReceipt?.completeness !== "reported_complete")
  process.exitCode = 1;
