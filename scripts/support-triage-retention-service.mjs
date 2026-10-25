// A selective release may not contain the unreleased retention supervisor.
// An unconfigured cron stays dormant without importing it or making a call.
// Configured deployments still require the real supervisor and its guards.
import { isUnconfiguredAgentService } from "../lib/qaReleaseServiceEnvCore.ts";

if (isUnconfiguredAgentService(process.env, ["SUPPORT_TRIAGE_RETENTION_SECRET"])) {
  console.log(JSON.stringify({ event: "support_triage_service", service: "retention",
    exitCode: 0, outcome: "unconfigured" }));
} else {
  const { runSupportTriageServiceEntry } = await import("./support-triage-service.mjs");
  await runSupportTriageServiceEntry("retention");
}
