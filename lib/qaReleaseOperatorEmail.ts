import { EMAIL_FONT_STACK } from "@/lib/emailTypography";
import { escapeHtml } from "@/lib/supportNotificationEmail";

/**
 * Operator emails of the QA-release agent (docs/policy/qa-release-agent.md
 * section 7): a fixed subject, a fixed sentence and an Admin link -- nothing
 * this agent read or wrote, and no external text. The only variable is the
 * UTC date the alert is for, taken from the queue row's reference id.
 *
 * Pure and deterministic for a reference id, because the retry queue
 * re-renders and the provider's idempotency key needs the same payload.
 */

export type QaReleaseOperatorEmailKind = "digest_stale" | "monitor_failed";

/** `stale:YYYY-MM-DD`, the reference id the Monitor enqueues under. */
const STALE_REFERENCE = /^stale:(\d{4}-\d{2}-\d{2})$/;

export const qaReleaseStaleDateFromReference = (referenceId: string): string | null =>
  STALE_REFERENCE.exec(referenceId)?.[1] ?? null;

/** `monitor-failure:YYYY-MM-DD`, the reference id a failed Monitor round enqueues under. */
const MONITOR_FAILURE_REFERENCE = /^monitor-failure:(\d{4}-\d{2}-\d{2})$/;

export const qaReleaseMonitorFailureDateFromReference = (referenceId: string): string | null =>
  MONITOR_FAILURE_REFERENCE.exec(referenceId)?.[1] ?? null;

const SUBJECTS: Record<QaReleaseOperatorEmailKind, string> = {
  digest_stale: "Tomverse QA release digest has gone quiet",
  monitor_failed: "Tomverse QA release digest check could not finish",
};

const LEADS: Record<QaReleaseOperatorEmailKind, string> = {
  digest_stale:
    "The QA release digest check found no current digest while the agent is recorded as on: none has been recorded, the newest is 28 hours old or older, or the newest is dated after the database clock. Nothing was decided or changed; open the Agent digests page to see the last digest and the operator control revision.",
  monitor_failed:
    "The QA release digest check could not finish a round, so whether the digest is current is not known. Nothing was decided or changed; open the Agent digests page to see the last digest, and the audit log for the reason recorded.",
};

export const buildQaReleaseOperatorEmail = (
  kind: QaReleaseOperatorEmailKind,
  input: { date: string; consoleUrl: string },
) => {
  const subject = SUBJECTS[kind];
  const rows: Array<[string, string]> = [
    ["Date (UTC)", input.date],
    ["Console", input.consoleUrl],
  ];
  const text = [LEADS[kind], "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
  const html = `
            <div style="font-family:${EMAIL_FONT_STACK};color:#111827;line-height:1.6">
              <h2>${escapeHtml(subject)}</h2>
              <p>${escapeHtml(LEADS[kind])}</p>
              ${rows
                .map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`)
                .join("\n              ")}
            </div>
          `;
  return { subject, text, html };
};
