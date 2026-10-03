// The QA-release Monitor service's entry point (docs/policy/qa-release-agent.md
// section 3). Railway runs it with `npm run agent:qa-release-monitor`; it holds
// the Monitor's secret and the operator control revision and nothing else.
// All decisions are in lib/qaReleaseMonitorServiceCore.ts; this file only
// connects the one port. The request follows no redirect and times out, and
// the output is the outcome code -- never a header, a token or a body.

import { runQaReleaseMonitorService } from "../lib/qaReleaseMonitorServiceCore.ts";

const HTTP_TIMEOUT_MS = 100_000;

const result = await runQaReleaseMonitorService(process.env, {
  postJson: async (url, headers) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  },
});

console.log(JSON.stringify(result));
process.exitCode = result.exitCode;
