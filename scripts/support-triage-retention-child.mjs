// The Support Triage Retention service's child (docs/policy/support-triage.md §3, §5).
// The supervisor (scripts/support-triage-retention-service.mjs) starts it and
// kills it at its deadline. It POSTs the retention route once, aborts the
// request at four minutes, prints one JSON line with the outcome code -- never
// a header, the secret or a body -- and exits with the outcome's code. All
// decisions are in lib/supportTriageRetentionServiceCore.ts.

import {
  SUPPORT_TRIAGE_RETENTION_CHILD_REQUEST_TIMEOUT_MS,
  postWithTimeout,
  runSupportTriageRetentionService,
} from "../lib/supportTriageRetentionServiceCore.ts";

const result = await runSupportTriageRetentionService(
  process.env,
  postWithTimeout(SUPPORT_TRIAGE_RETENTION_CHILD_REQUEST_TIMEOUT_MS)
);
console.log(JSON.stringify({ event: "support_triage_retention_service", ...result }));
process.exitCode = result.exitCode;
