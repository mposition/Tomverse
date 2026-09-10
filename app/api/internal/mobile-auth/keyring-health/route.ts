export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { createHash, timingSafeEqual } from "node:crypto";

import { MobileAuthKeyringError } from "@/lib/mobileAuthKeyring";
import {
  mobileAuthKeyringHealthReport,
  type MobileKeyringFinding,
} from "@/lib/mobileAuthKeyringHealth";
import {
  MOBILE_AUTH_KEYRING_HEALTH_JOB_KEY,
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";

/**
 * The standing keyring check, run where the live rings are.
 *
 * S1 of `.github/audits/2026-09-10-mobile-auth-keyring-standing-check-approval.md`
 * (approved 2026-09-10) put the check here rather than in CI for one reason:
 * what it must read is the ring this deployment is actually serving, and every
 * other place to run it either audits a copy or needs the material copied to
 * it. The cron service that will call this holds a URL and a bearer secret --
 * no key material leaves the deployment.
 *
 * **Read-only.** It reads environment variables, judges them with the module
 * the pre-deploy check uses, and writes a run row and a log line. It deletes,
 * rotates, re-declares and re-issues nothing, and it is not a gate: a finding
 * here never blocks a deploy.
 *
 * Procedure: `docs/ops/mobile-auth-key-rotation.md`.
 */

const authorized = (request: Request) => {
  // A job-specific secret if one exists, else the maintenance secret every
  // other internal job already uses -- the same fallback as the provider
  // probe. Nothing here creates a credential.
  const secret =
    process.env.MOBILE_AUTH_KEYRING_HEALTH_SECRET || process.env.MAINTENANCE_SECRET;
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided) return false;

  const expected = createHash("sha256").update(secret).digest();
  const actual = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expected, actual);
};

/**
 * What leaves this process, per S1's first condition.
 *
 * Key **ids** and the codes, never material. The findings the shared module
 * produces already carry only ids, and this restates the allowlist rather than
 * spreading the finding object: a field added upstream would otherwise start
 * appearing in a response and a log by doing nothing.
 */
const publicFinding = (finding: MobileKeyringFinding) => ({
  code: finding.code,
  ...(finding.keyId === undefined ? {} : { keyId: finding.keyId }),
  ...(finding.otherKeyId === undefined ? {} : { otherKeyId: finding.otherKeyId }),
  ...(finding.retiredAtMs === undefined
    ? {}
    : { retiredAt: new Date(finding.retiredAtMs).toISOString() }),
});

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const run = await startScheduledJob(MOBILE_AUTH_KEYRING_HEALTH_JOB_KEY);
  try {
    const report = mobileAuthKeyringHealthReport();
    const findings = report.rings.flatMap((ring) =>
      ring.findings.map((finding) => ({ variable: ring.variable, ...publicFinding(finding) }))
    );
    const body = {
      observedAt: report.observedAt,
      configuration: report.configuration.state,
      missing: report.configuration.missing,
      findings,
      attention: report.attention,
    };

    // S8: the findings go to the structured log, the run state to
    // `ScheduledJobRun`. A run with nothing to say still logs, because an
    // absent line and a line saying nothing was found are the same absence
    // otherwise.
    console.info(
      JSON.stringify({
        event: "mobile_auth_keyring_health",
        ...body,
        findingCount: findings.length,
        at: new Date().toISOString(),
      })
    );

    // S5: a run that finished is `succeeded` **even when it found something**.
    // Recording findings as a failure would fold "the ring wants attention"
    // into "the check itself is broken", and a job whose failures pile up is a
    // job somebody switches off.
    await completeScheduledJob({
      runId: run?.id,
      processedCount: findings.length,
      result: body,
    });

    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // S5's fourth branch: the rings do not parse, so every line the report
    // could produce would describe something other than what is configured.
    // None of it is shown, and this one *is* a failed run.
    // The keyring's own errors name variables and key ids and never quote
    // material (`parseRing`, `parseRetirements`), so they are safe to keep.
    // Anything else is recorded by name only: an error this route has never
    // seen is not the place to find out what it puts in its message.
    const recorded =
      error instanceof MobileAuthKeyringError
        ? error
        : Object.assign(new Error("the keyring could not be read"), {
            name: error instanceof Error ? error.name : "UnknownError",
          });
    await failScheduledJob({ runId: run?.id, error: recorded });
    console.error(
      JSON.stringify({
        event: "mobile_auth_keyring_health_unreadable",
        reason: error instanceof Error ? error.name : "unknown",
        at: new Date().toISOString(),
      })
    );
    return Response.json(
      { error: "KeyringUnreadable" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
