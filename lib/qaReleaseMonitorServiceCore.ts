/**
 * One run of the QA-release Monitor service (docs/policy/qa-release-agent.md
 * section 3): it holds the Monitor's own secret and the operator control
 * revision, calls the app's silence check once, and reports the answer. All
 * judgement is the app's (lib/qaReleaseMonitor.ts); this side decides only
 * whether it may start and where it may call.
 *
 * It never retries: the next scheduled round is the retry, and the app's
 * alert key keeps a repeated stale verdict to one alert per day.
 */

import { assertQaReleaseMonitorEndpoint, qaReleaseMonitorEndpoint } from "./qaReleaseDigestEndpointCore.ts";
import { QA_RELEASE_CONTROL_REVISION_HEADER } from "./qaReleaseRouteAuthCore.ts";
import { decideQaReleaseServiceStart } from "./qaReleaseServiceEnvCore.ts";

export type QaReleaseMonitorRunOutcome =
  | { exitCode: 0; outcome: "checked"; verdict: string }
  | {
      exitCode: 1;
      outcome: "refused_to_start" | "destination_unknown" | "check_refused" | "check_outcome_unknown";
      status?: number;
    };

export type QaReleaseMonitorServicePorts = {
  postJson: (url: string, headers: Readonly<Record<string, string>>) => Promise<{ status: number; body: unknown }>;
};

const VERDICTS = new Set(["dark_not_configured", "operator_disabled", "control_mismatch", "stale", "fresh"]);

export async function runQaReleaseMonitorService(
  env: Readonly<Record<string, string | undefined>>,
  ports: QaReleaseMonitorServicePorts,
): Promise<QaReleaseMonitorRunOutcome> {
  // The Monitor has no enable flag of its own: it is off when its cron is
  // not declared, so the start decision is only "refuse" or "run".
  if (decideQaReleaseServiceStart("monitor", env) !== "run") return { exitCode: 1, outcome: "refused_to_start" };

  let url: string;
  try {
    url = qaReleaseMonitorEndpoint(env);
    assertQaReleaseMonitorEndpoint(url);
  } catch {
    return { exitCode: 1, outcome: "destination_unknown" };
  }

  let answer: { status: number; body: unknown };
  try {
    answer = await ports.postJson(url, {
      authorization: `Bearer ${env.QA_RELEASE_MONITOR_SECRET ?? ""}`,
      [QA_RELEASE_CONTROL_REVISION_HEADER]: (env.QA_RELEASE_CONTROL_REVISION ?? "").trim(),
    });
  } catch {
    return { exitCode: 1, outcome: "check_outcome_unknown" };
  }
  const verdict = (answer.body as { verdict?: unknown } | null)?.verdict;
  if (answer.status === 200 && typeof verdict === "string" && VERDICTS.has(verdict)) {
    return { exitCode: 0, outcome: "checked", verdict };
  }
  return answer.status >= 500 || answer.status === 200
    ? { exitCode: 1, outcome: "check_outcome_unknown", status: answer.status }
    : { exitCode: 1, outcome: "check_refused", status: answer.status };
}
