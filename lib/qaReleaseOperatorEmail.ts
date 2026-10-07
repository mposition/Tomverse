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

export type QaReleaseOperatorEmailKind =
  | "digest_stale"
  | "monitor_failed"
  | "attention"
  | "digest_recorded"
  | "merge_lane_latched";

/** `stale:YYYY-MM-DD`, the reference id the Monitor enqueues under. */
const STALE_REFERENCE = /^stale:(\d{4}-\d{2}-\d{2})$/;

export const qaReleaseStaleDateFromReference = (referenceId: string): string | null =>
  STALE_REFERENCE.exec(referenceId)?.[1] ?? null;

/** `monitor-failure:YYYY-MM-DD`, the reference id a failed Monitor round enqueues under. */
const MONITOR_FAILURE_REFERENCE = /^monitor-failure:(\d{4}-\d{2}-\d{2})$/;

export const qaReleaseMonitorFailureDateFromReference = (referenceId: string): string | null =>
  MONITOR_FAILURE_REFERENCE.exec(referenceId)?.[1] ?? null;

/** `attention:YYYY-MM-DD`, the reference id an operator control mismatch enqueues under. */
const ATTENTION_REFERENCE = /^attention:(\d{4}-\d{2}-\d{2})$/;

export const qaReleaseAttentionDateFromReference = (referenceId: string): string | null =>
  ATTENTION_REFERENCE.exec(referenceId)?.[1] ?? null;

/** `recorded:YYYY-MM-DD`, keyed by the UTC day of the recorded digest. */
const RECORDED_REFERENCE = /^recorded:(\d{4}-\d{2}-\d{2})$/;

export const qaReleaseDigestRecordedDateFromReference = (referenceId: string): string | null =>
  RECORDED_REFERENCE.exec(referenceId)?.[1] ?? null;

/** `merge-lane-latch:YYYY-MM-DD`, the database clock's UTC date of the latch. */
const MERGE_LANE_LATCH_REFERENCE = /^merge-lane-latch:(\d{4}-\d{2}-\d{2})$/;

export const qaReleaseMergeLaneLatchDateFromReference = (referenceId: string): string | null =>
  MERGE_LANE_LATCH_REFERENCE.exec(referenceId)?.[1] ?? null;

const SUBJECTS: Record<QaReleaseOperatorEmailKind, string> = {
  digest_stale: "Tomverse QA release digest has gone quiet",
  monitor_failed: "Tomverse QA release digest check could not finish",
  attention: "Tomverse QA release agent needs a check",
  digest_recorded: "Tomverse QA release digest recorded",
  merge_lane_latched: "Tomverse develop merge lane stopped",
};

const LEADS: Record<QaReleaseOperatorEmailKind, string> = {
  digest_stale:
    "The QA release digest check found no current digest while the agent is recorded as on: none has been recorded, the newest is 28 hours old or older, or the newest is dated after the database clock. Nothing was decided or changed; open the Agent digests page to see the last digest and the operator control revision.",
  monitor_failed:
    "The QA release digest check could not finish a round, so whether the digest is current is not known. Nothing was decided or changed; open the Agent digests page to see the last digest, and the audit log for the reason recorded.",
  attention:
    "The QA release digest check found the recorded operator control and the running configuration disagree: a service presented an operator control revision other than the newest, the digest secret is missing while the agent is recorded as on, or a second, different digest was submitted for a day that already has one. Nothing was decided or changed; open the Agent digests page to compare the newest operator control revision with the services' settings.",
  digest_recorded:
    "The QA release digest for this date was recorded. It is a report, not a judgement: nothing was decided or changed. Open the Agent digests page to read it.",
  merge_lane_latched:
    "The QA release merge lane stopped merging develop pull requests because a merge or staging deployment needs a person: its outcome was unknown, it did not succeed, it landed somewhere other than develop, or the report came from another operator control revision than the newest. It merges nothing until a person releases the latch. Open the Agent digests page to see the latch reason and the attempt's pull request.",
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
