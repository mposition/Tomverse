// A Support Triage cron service's child (docs/policy/support-triage.md §3, §5).
// The supervisor (scripts/support-triage-service.mjs) starts it with the
// service kind as its one argument and kills it at its deadline. It POSTs the
// service's route once, aborts the request at the service's child timeout,
// prints one JSON line with the outcome code -- never a header, the secret or
// a body -- and exits with the outcome's code. All decisions are in
// lib/supportTriageServiceCore.ts.

import {
  SUPPORT_TRIAGE_SERVICES,
  SUPPORT_TRIAGE_SERVICE_KINDS,
  postWithTimeout,
  runSupportTriageService,
} from "../lib/supportTriageServiceCore.ts";

const kind = process.argv[2];
if (!SUPPORT_TRIAGE_SERVICE_KINDS.includes(kind)) {
  console.log(JSON.stringify({ event: "support_triage_service", exitCode: 1, outcome: "service_argument" }));
  process.exit(1);
}
const result = await runSupportTriageService(
  kind,
  process.env,
  postWithTimeout(SUPPORT_TRIAGE_SERVICES[kind].childRequestTimeoutMs)
);
console.log(JSON.stringify({ event: "support_triage_service", service: kind, ...result }));
process.exitCode = result.exitCode;
