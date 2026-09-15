import { EMAIL_FONT_STACK } from "@/lib/emailTypography";
import { escapeHtml } from "@/lib/supportNotificationEmail";

/**
 * Operator emails about an auto-fix case: a fix waiting for review, a fix
 * observed live in production, and a promotion that stopped.
 *
 * Operator-only, so technical identifiers are fine here, but the report body
 * never is: nothing in the input type can carry it, and the fix report was
 * produced from the diagnostic summary alone.
 *
 * Pure and deterministic for a given case row -- the retry queue re-renders
 * and the provider's idempotency key needs the same payload -- which is why
 * each email renders only fields that stop changing once its stage is
 * reached, never the case's current state.
 */

export type AutoFixOperatorEmailKind =
  | "review_requested"
  | "production_verified"
  | "promotion_failed";

export type AutoFixOperatorEmailInput = {
  caseId: string;
  feedbackId: string;
  errorCode: string | null;
  fixPrUrl: string | null;
  rootCause: string | null;
  fixSummary: string | null;
  testSummary: string | null;
  changedPaths: string[];
  productionPrUrl: string | null;
  productionMergeSha: string | null;
  terminalReason: string | null;
  consoleUrl: string;
};

const SUBJECTS: Record<AutoFixOperatorEmailKind, (input: AutoFixOperatorEmailInput) => string> = {
  review_requested: (input) =>
    `Tomverse fix ready for your review: ${input.errorCode || "server error"}`,
  production_verified: (input) =>
    `Tomverse fix is live in production: ${input.errorCode || "server error"} (reply draft ready)`,
  promotion_failed: (input) =>
    `Tomverse fix promotion stopped: ${input.errorCode || "server error"}`,
};

const LEADS: Record<AutoFixOperatorEmailKind, string> = {
  review_requested:
    "A fix was produced for a report with a verified trace, its Red→Green proof passed, and a develop PR is open. Review the cause and the fix in the console, then approve it there and merge the PR in GitHub.",
  production_verified:
    "The approved fix was observed live in production across the stabilisation window. A reply draft for the reporter is ready on the report; nothing has been sent to them.",
  promotion_failed:
    "Promotion of an approved fix stopped on an observed fact. Nothing further will happen automatically.",
};

export const buildAutoFixOperatorEmail = (
  kind: AutoFixOperatorEmailKind,
  input: AutoFixOperatorEmailInput
) => {
  const dash = (value: string | null | undefined) => (value ? value : "-");
  const rows: Array<[string, string]> = [
    ["Case", input.caseId],
    ["Feedback ID", input.feedbackId],
    ["Error code", dash(input.errorCode)],
    ["Develop PR", dash(input.fixPrUrl)],
  ];
  if (kind === "review_requested") {
    rows.push(
      ["Root cause", dash(input.rootCause)],
      ["Fix", dash(input.fixSummary)],
      ["Test", dash(input.testSummary)],
      ["Changed files", input.changedPaths.length ? input.changedPaths.join(", ") : "-"]
    );
  }
  if (kind === "production_verified") {
    rows.push(
      ["Main PR", dash(input.productionPrUrl)],
      ["Production commit", dash(input.productionMergeSha)]
    );
  }
  if (kind === "promotion_failed") {
    rows.push(["Reason", dash(input.terminalReason)]);
  }
  rows.push(["Console", input.consoleUrl]);

  const subject = SUBJECTS[kind](input);
  const text = [LEADS[kind], "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
  const html = `
            <div style="font-family:${EMAIL_FONT_STACK};color:#111827;line-height:1.6">
              <h2>${escapeHtml(subject)}</h2>
              <p>${escapeHtml(LEADS[kind])}</p>
              ${rows
                .map(
                  ([label, value]) =>
                    `<p><strong>${escapeHtml(label)}:</strong> <span style="white-space:pre-wrap">${escapeHtml(value)}</span></p>`
                )
                .join("\n              ")}
            </div>
          `;
  return { subject, text, html };
};
