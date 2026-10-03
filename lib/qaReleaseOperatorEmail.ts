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

export type QaReleaseOperatorEmailKind = "digest_stale";

/** `stale:YYYY-MM-DD`, the reference id the Monitor enqueues under. */
const STALE_REFERENCE = /^stale:(\d{4}-\d{2}-\d{2})$/;

export const qaReleaseStaleDateFromReference = (referenceId: string): string | null =>
  STALE_REFERENCE.exec(referenceId)?.[1] ?? null;

const SUBJECTS: Record<QaReleaseOperatorEmailKind, string> = {
  digest_stale: "Tomverse QA release digest has gone quiet",
};

const LEADS: Record<QaReleaseOperatorEmailKind, string> = {
  digest_stale:
    "No QA release digest has been recorded for 28 hours while the agent is recorded as on. Nothing was decided or changed; open the Agent digests page to see the last digest and the operator control revision.",
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
