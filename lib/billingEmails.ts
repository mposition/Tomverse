import "server-only";

import { sendTransactionalEmail } from "@/lib/email";

type RefundEmailInput = {
  to: string | null | undefined;
  plan: string | null | undefined;
  requestId: string;
  adminNote?: string | null;
};

type BillingWelcomeEmailInput = {
  to: string | null | undefined;
  plan: string | null | undefined;
  billingInterval?: string | null;
  periodEnd?: Date | string | null;
};

const appUrl = () =>
  process.env.PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://tomverse.app";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatDate = (value: Date | string | null | undefined) => {
  if (!value) return "Not available";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
};

const formatBillingInterval = (value: string | null | undefined) => {
  if (value === "annual") return "Annual";
  if (value === "monthly") return "Monthly";
  return "Subscription";
};

const shell = (title: string, body: string) => `
  <div style="margin:0;padding:0;background:#f4f6fb;font-family:Inter,Arial,sans-serif;color:#111827;">
    <div style="max-width:640px;margin:0 auto;padding:32px 18px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;overflow:hidden;">
        <div style="padding:28px 30px;background:#0b1020;color:#ffffff;">
          <div style="font-size:12px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#93c5fd;">Tomverse AI Billing</div>
          <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;">${title}</h1>
        </div>
        <div style="padding:30px;color:#374151;font-size:15px;line-height:1.7;">
          ${body}
          <p style="margin-top:28px;">
            <a href="${appUrl()}/chat" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;border-radius:12px;padding:12px 18px;">Open Tomverse</a>
          </p>
        </div>
      </div>
      <p style="margin:18px 4px 0;color:#6b7280;font-size:12px;line-height:1.6;">
        This message was sent about your Tomverse AI billing account. If you did not request this, contact support.
      </p>
    </div>
  </div>
`;

export async function sendBillingWelcomeEmail(input: BillingWelcomeEmailInput) {
  if (!input.to) return;
  const plan = escapeHtml(input.plan || "Tomverse AI");
  const billingInterval = formatBillingInterval(input.billingInterval);
  const periodEnd = formatDate(input.periodEnd);
  const subject = `Welcome to Tomverse AI ${plan}`;
  const text = [
    "Your Tomverse AI payment was successful.",
    "Welcome to the Tomverse AI family.",
    `Plan: ${plan}`,
    `Billing: ${billingInterval}`,
    `Plan valid until: ${periodEnd}`,
    "Checkout is charged in USD. You can manage your plan in Settings > Plan.",
  ].join("\n");
  const html = shell(
    "Welcome to Tomverse AI",
    `
      <p>Your payment was successful. Welcome to the Tomverse AI family.</p>
      <div style="margin:20px 0;padding:18px;border:1px solid #dbeafe;border-radius:16px;background:#eff6ff;color:#1e3a8a;">
        <div style="margin-bottom:8px;"><strong>Plan:</strong> ${plan}</div>
        <div style="margin-bottom:8px;"><strong>Billing:</strong> ${billingInterval}</div>
        <div><strong>Plan valid until:</strong> ${periodEnd}</div>
      </div>
      <p>You can now use the paid Tomverse AI workspace features included with your plan. Manage billing and plan details anytime from <strong>Settings &gt; Plan</strong>.</p>
      <p style="color:#6b7280;">Displayed local prices are converted for convenience. Checkout and billing are charged in USD.</p>
    `
  );
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendRefundRequestReceivedEmail(input: RefundEmailInput) {
  if (!input.to) return;
  const plan = escapeHtml(input.plan || "paid");
  const requestId = escapeHtml(input.requestId);
  const subject = "We received your Tomverse AI refund request";
  const text = [
    "We received your refund and plan cancellation request.",
    `Plan: ${plan}`,
    `Request ID: ${requestId}`,
    "Our team will review the request and notify you when a decision is made.",
  ].join("\n");
  const html = shell(
    "Refund request received",
    `
      <p>We received your refund and plan cancellation request.</p>
      <div style="margin:20px 0;padding:16px;border:1px solid #e5e7eb;border-radius:14px;background:#f9fafb;">
        <div><strong>Plan:</strong> ${plan}</div>
        <div><strong>Request ID:</strong> ${requestId}</div>
      </div>
      <p>Our billing team will review the request and notify you when a decision is made. Your current plan remains active until the request is approved or your subscription changes.</p>
    `
  );
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendRefundRequestApprovedEmail(input: RefundEmailInput) {
  if (!input.to) return;
  const requestId = escapeHtml(input.requestId);
  const adminNote = input.adminNote ? escapeHtml(input.adminNote) : "";
  const subject = "Your Tomverse AI refund request was approved";
  const text = [
    "Your refund and plan cancellation request has been approved.",
    "Your Tomverse AI membership has been moved back to Free.",
    input.adminNote ? `Admin note: ${input.adminNote}` : "",
    `Request ID: ${input.requestId}`,
  ]
    .filter(Boolean)
    .join("\n");
  const html = shell(
    "Refund request approved",
    `
      <p>Your refund and plan cancellation request has been approved.</p>
      <div style="margin:20px 0;padding:16px;border:1px solid #d1fae5;border-radius:14px;background:#ecfdf5;color:#065f46;">
        <strong>Your Tomverse AI membership has been moved back to Free.</strong>
      </div>
      ${adminNote ? `<p><strong>Note from Tomverse:</strong> ${adminNote}</p>` : ""}
      <p>If a payment refund is applicable, processing time may depend on Stripe, your card issuer, PayPal, Apple Pay, or Google Pay.</p>
      <p style="color:#6b7280;">Request ID: ${requestId}</p>
    `
  );
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}

export async function sendRefundRequestRejectedEmail(input: RefundEmailInput) {
  if (!input.to) return;
  const requestId = escapeHtml(input.requestId);
  const adminNote = input.adminNote ? escapeHtml(input.adminNote) : "";
  const subject = "Update on your Tomverse AI refund request";
  const text = [
    "Your refund request has been reviewed.",
    input.adminNote ? `Decision note: ${input.adminNote}` : "Please contact support if you need more information.",
    `Request ID: ${input.requestId}`,
  ].join("\n");
  const html = shell(
    "Refund request reviewed",
    `
      <p>Your refund request has been reviewed.</p>
      <p>${adminNote || "Please contact support if you need more information about this decision."}</p>
      <p style="color:#6b7280;">Request ID: ${requestId}</p>
    `
  );
  await sendTransactionalEmail({ to: input.to, subject, text, html });
}
