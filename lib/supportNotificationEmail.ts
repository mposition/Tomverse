import { EMAIL_FONT_STACK } from "@/lib/emailTypography";

/**
 * The operator notification for one support submission.
 *
 * It lives here, rather than inline in the route, because it is rendered from
 * two places now: the immediate send when the report arrives, and the retry
 * queue when that send failed. Building it twice would let the retried mail
 * drift away from the original.
 *
 * Pure: it takes the stored fields and returns strings, so
 * tests/supportNotificationEmail.test.mjs can assert the escaping without a
 * database or a mail provider.
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
  /** Set on a retried send so the operator knows why it arrived late. */
  retryAttempt?: number;
};

export const buildSupportNotificationEmail = (
  input: SupportNotificationInput
) => {
  const dash = (value: unknown) => (value ? String(value) : "-");
  const attachments = input.attachmentCount || 0;
  const isRetry = Boolean(input.retryAttempt && input.retryAttempt > 1);
  const retryNote = isRetry
    ? `Delivery retry ${input.retryAttempt} -- the report itself was stored when it was submitted.`
    : null;

  const subject = `Tomverse support request: ${input.type}`;

  const text = [
    ...(retryNote ? [retryNote, ""] : []),
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
              <h2>New Tomverse support request</h2>
              ${
                retryNote
                  ? `<p style="color:#92400e"><strong>${escapeHtml(retryNote)}</strong></p>`
                  : ""
              }
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
