import { EMAIL_FONT_STACK } from "@/lib/emailTypography";

/**
 * The operator notification for one support submission.
 *
 * It lives here, rather than inline in the route, because it is rendered from
 * two places now: the immediate send when the report arrives, and the retry
 * queue when that send failed. Building it twice would let the retried mail
 * drift away from the original.
 *
 * Pure, and deterministic for a given record: every attempt must render byte
 * for byte the same message, because the provider's idempotency key only
 * suppresses a duplicate when the payload matches too. That is why nothing
 * here varies by attempt number or by clock.
 */

export const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export type SupportNotificationInput = {
  feedbackId: string;
  type: string;
  email: string | null;
  message: string;
  traceId?: string | null;
  modelId?: string | null;
  plan?: string | null;
  attachmentCount?: number | null;
  path?: string | null;
  /**
   * The report carried a server-verified trace and was stored already in
   * review (lib/feedbackTraceAutoReview.ts). Derived from the stored
   * verification outcome, which never changes after the write -- not from the
   * report's current status, which would make a retry render a different mail.
   */
  autoReviewed?: boolean;
};

export const buildSupportNotificationEmail = (
  input: SupportNotificationInput
) => {
  const dash = (value: unknown) => (value ? String(value) : "-");
  const attachments = input.attachmentCount || 0;

  const subject = input.autoReviewed
    ? `Tomverse support request moved to review: ${input.type} (verified trace)`
    : `Tomverse support request: ${input.type}`;
  const autoReviewSentence =
    "This report carries a server-verified trace, so it was moved to Reviewing automatically. Open the support inbox to look at the trace evidence.";

  const text = [
    ...(input.autoReviewed ? [autoReviewSentence, ""] : []),
    `Feedback ID: ${input.feedbackId}`,
    `Type: ${input.type}`,
    `Email: ${input.email || "guest"}`,
    `Trace ID: ${dash(input.traceId)}`,
    `Model: ${dash(input.modelId)}`,
    `Plan: ${dash(input.plan)}`,
    `Attachments: ${attachments}`,
    `Path: ${dash(input.path)}`,
    "",
    input.message,
  ].join("\n");

  const html = `
            <div style="font-family:${EMAIL_FONT_STACK};color:#111827;line-height:1.6">
              <h2>${input.autoReviewed ? "Tomverse support request moved to review" : "New Tomverse support request"}</h2>
              ${input.autoReviewed ? `<p><strong>${escapeHtml(autoReviewSentence)}</strong></p>` : ""}
              <p><strong>Feedback ID:</strong> ${escapeHtml(input.feedbackId)}</p>
              <p><strong>Type:</strong> ${escapeHtml(input.type)}</p>
              <p><strong>Email:</strong> ${escapeHtml(input.email || "guest")}</p>
              <p><strong>Trace ID:</strong> ${escapeHtml(dash(input.traceId))}</p>
              <p><strong>Model:</strong> ${escapeHtml(dash(input.modelId))}</p>
              <p><strong>Plan:</strong> ${escapeHtml(dash(input.plan))}</p>
              <p><strong>Attachments:</strong> ${escapeHtml(attachments)}</p>
              <p><strong>Path:</strong> ${escapeHtml(dash(input.path))}</p>
              <hr />
              <p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>
            </div>
          `;

  return { subject, text, html };
};

/**
 * The address operator notifications go to. Resolved at send time rather than
 * stored on the queue row, so fixing a mis-set recipient also fixes every
 * delivery still waiting to be retried.
 */
const firstCsvValue = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map((item) => item.trim())
    .find(Boolean);

export const supportNotificationRecipient = () =>
  process.env.SUPPORT_NOTIFICATION_EMAIL ||
  process.env.ADMIN_ALERT_EMAIL ||
  firstCsvValue(process.env.ADMIN_EMAILS);
