// The Support Triage cron service's entry point (docs/policy/support-triage.md §3).
// Railway runs `node --experimental-strip-types scripts/support-triage-worker-service.mjs`.
// Everything is in scripts/support-triage-service.mjs and
// lib/supportTriageServiceCore.ts.

import { runSupportTriageServiceEntry } from "./support-triage-service.mjs";

await runSupportTriageServiceEntry("worker");
