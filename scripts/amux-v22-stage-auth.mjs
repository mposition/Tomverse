#!/usr/bin/env node
// Copies the operator's CLI logins into the fixed v22 worker profiles on the
// AMUX box (run by tomverse-amux-v22-auth-stage.timer as the operator user).
// usage: amux-v22-stage-auth.mjs [--check] <provider>:<worker> ...
// provider: anthropic | openai | github-copilot | cursor | antigravity. No secret is ever printed.
import { stageAmuxV22WorkerAuth } from "../lib/amux/v22WorkerAuthStage.mjs";

const args = process.argv.slice(2);
const check = args[0] === "--check";
const targets = check ? args.slice(1) : args;
const home = process.env.HOME;
if (!home || targets.length === 0) {
  console.error("usage: amux-v22-stage-auth.mjs [--check] <provider>:<worker> ...");
  process.exit(2);
}

let failed = 0;
const now = Date.now();
for (const target of targets) {
  const [provider, worker] = target.split(":");
  try {
    const staged = await stageAmuxV22WorkerAuth({ provider, worker, home, now, check });
    const until = staged.expiresAt === null ? "n/a (no expiry)" :
      new Date(staged.expiresAt).toISOString();
    console.log(`${worker}: ${provider} ${check ? "ok" : "staged"}, access until ${until}`);
  } catch {
    console.error(`${target}: login refused (expired, too short-lived, missing, or not a subscription login); copy left unchanged`);
    failed += 1;
  }
}
process.exit(failed === 0 ? 0 : 1);
