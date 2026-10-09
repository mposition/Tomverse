/**
 * One run of the QA-release Digest service (docs/policy/qa-release-agent.md
 * sections 1 and 3): decide whether to start, run the repository's report
 * scripts and static checks, build the closed digest, and submit it to the
 * one destination fixed in code.
 *
 * Every effect is a port the caller supplies, so this module runs the same
 * under test and on Railway. It never retries: an unknown submission outcome
 * ends the run with a failure for a person to look at (policy section 6 and
 * the foundation's "unknown outcome means stop"). A replay of the same day's
 * digest is harmless -- the intake answers it as a replay -- but the next
 * scheduled run is what tries again, not this one.
 */

import { buildQaReleaseDigest, type QaReleaseDigestBuildInput } from "./qaReleaseDigestBuildCore.ts";
import { assertQaReleaseDigestEndpoint, qaReleaseDigestEndpoint } from "./qaReleaseDigestEndpointCore.ts";
import { QA_RELEASE_CHECK_NAMES, type QaReleaseDigest } from "./qaReleaseDigestSchemaCore.ts";
import { QA_RELEASE_CONTROL_REVISION_HEADER } from "./qaReleaseRouteAuthCore.ts";
import { decideQaReleaseServiceStart } from "./qaReleaseServiceEnvCore.ts";

/** The service's hard timeout (policy section 10: 15 minutes). */
export const QA_RELEASE_DIGEST_HARD_TIMEOUT_MS = 15 * 60 * 1000;

export type QaReleaseScriptResult = { exitCode: number; stdout: string };

export type QaReleaseDigestServicePorts = {
  /** Runs `npm run <name> -- <args>` with `extraEnv` added to the child's environment only. */
  runScript: (name: string, args: readonly string[], extraEnv?: Readonly<Record<string, string>>) => Promise<QaReleaseScriptResult>;
  /**
   * The CI and release-lane rows, or null when GitHub could not be read. Kept
   * a port so the collector is its own reviewed slice.
   */
  collectCi: (
    readToken: string,
  ) => Promise<(Pick<QaReleaseDigest, "ci" | "releaseLane"> & { unrecognizedJobs: number; truncated: boolean }) | null>;
  postJson: (url: string, headers: Readonly<Record<string, string>>, body: string) => Promise<{ status: number }>;
  now: () => Date;
};

export type QaReleaseDigestRunOutcome =
  | { exitCode: 0; outcome: "disabled" | "created" | "replayed" }
  | {
      exitCode: 1;
      outcome:
        | "refused_to_start"
        | "base_sha_unknown"
        | "destination_unknown"
        | "gate_report_failed"
        | "digest_build_failed"
        | "submission_refused"
        | "submission_outcome_unknown";
      status?: number;
    };

type GateReport = QaReleaseDigestBuildInput["gateReport"];

const parseJson = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

const isGateReport = (value: unknown): value is GateReport =>
  typeof value === "object" && value !== null && Array.isArray((value as GateReport).classified);

async function gateReport(ports: QaReleaseDigestServicePorts, condition?: boolean): Promise<GateReport | null> {
  const args = ["--json", ...(condition === undefined ? [] : ["--condition", `memory-release-b-enabled=${condition}`])];
  const result = await ports.runScript("report:release-gate-evidence", args);
  const parsed = result.exitCode === 0 ? parseJson(result.stdout) : null;
  return isGateReport(parsed) ? parsed : null;
}

export async function runQaReleaseDigestService(
  env: Readonly<Record<string, string | undefined>>,
  ports: QaReleaseDigestServicePorts,
): Promise<QaReleaseDigestRunOutcome> {
  const start = decideQaReleaseServiceStart("digest", env);
  if (start === "disabled") return { exitCode: 0, outcome: "disabled" };
  if (start === "refuse") return { exitCode: 1, outcome: "refused_to_start" };

  // The commit Railway built: the digest describes exactly that tree.
  const baseSha = (env.RAILWAY_GIT_COMMIT_SHA ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(baseSha)) return { exitCode: 1, outcome: "base_sha_unknown" };

  // The destination is decided before any work: an environment that cannot
  // name one stops here rather than after every report has run.
  let url: string;
  try {
    url = qaReleaseDigestEndpoint(env);
    assertQaReleaseDigestEndpoint(url);
  } catch {
    return { exitCode: 1, outcome: "destination_unknown" };
  }

  const startedAt = ports.now();
  const readToken = env.QA_RELEASE_GITHUB_READ_TOKEN ?? "";

  // The unconditioned gate report is the digest's spine; without it there is
  // nothing to say, so the run fails rather than submitting an empty digest.
  const gates = await gateReport(ports);
  if (gates === null) return { exitCode: 1, outcome: "gate_report_failed" };
  const hypotheticalReports: QaReleaseDigestBuildInput["hypotheticalReports"] = [];
  for (const assumed of [true, false]) {
    const report = await gateReport(ports, assumed);
    if (report !== null) hypotheticalReports.push({ assumed, report });
  }

  // The issue report reads GitHub with the read-only token, handed to that
  // child alone under the name the script expects.
  const issues = await ports.runScript("report:issue-backlog", ["--json"], { GITHUB_TOKEN: readToken });
  const issueParsed = issues.exitCode === 0 ? parseJson(issues.stdout) : null;
  const issueReport =
    typeof issueParsed === "object" && issueParsed !== null && Array.isArray((issueParsed as { classified?: unknown }).classified)
      ? (issueParsed as QaReleaseDigestBuildInput["issueReport"])
      : null;

  const checks: QaReleaseDigest["checks"] = [];
  for (const name of QA_RELEASE_CHECK_NAMES) {
    const result = await ports.runScript(name, []);
    checks.push({ name, result: result.exitCode === 0 ? "pass" : "fail" });
  }

  const ci = await ports.collectCi(readToken);
  const notChecked: QaReleaseDigestBuildInput["notChecked"] = [];
  if (ci === null) notChecked.push("github_read_unavailable");
  // Rows from a partial read are kept, and the digest says they are partial:
  // a renamed job or a window past the page cap must not read as "no failures".
  else if (ci.unrecognizedJobs > 0 || ci.truncated) notChecked.push("ci_collection_incomplete");

  let digest: QaReleaseDigest;
  try {
    digest = buildQaReleaseDigest({
      digestDate: startedAt.toISOString().slice(0, 10),
      baseSha,
      generatedAt: ports.now().toISOString(),
      runDeadline: new Date(startedAt.getTime() + QA_RELEASE_DIGEST_HARD_TIMEOUT_MS).toISOString(),
      gateReport: gates,
      hypotheticalReports,
      issueReport,
      checks,
      ci: ci?.ci ?? [],
      releaseLane: ci?.releaseLane ?? [],
      notChecked,
    });
  } catch {
    // An unknown verdict or a document that cannot fit: a report changed
    // under the digest, which a person has to look at.
    return { exitCode: 1, outcome: "digest_build_failed" };
  }

  let status: number;
  try {
    ({ status } = await ports.postJson(
      url,
      {
        "content-type": "application/json",
        authorization: `Bearer ${env.QA_RELEASE_DIGEST_SECRET ?? ""}`,
        [QA_RELEASE_CONTROL_REVISION_HEADER]: (env.QA_RELEASE_CONTROL_REVISION ?? "").trim(),
      },
      JSON.stringify(digest),
    ));
  } catch {
    return { exitCode: 1, outcome: "submission_outcome_unknown" };
  }
  if (status === 201) return { exitCode: 0, outcome: "created" };
  if (status === 200) return { exitCode: 0, outcome: "replayed" };
  return status >= 500
    ? { exitCode: 1, outcome: "submission_outcome_unknown", status }
    : { exitCode: 1, outcome: "submission_refused", status };
}
