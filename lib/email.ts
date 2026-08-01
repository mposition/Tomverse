import "server-only";

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Makes a send exactly-once at the provider for 24 hours.
   *
   * Resend records the key against the request it accepted, so a retry that
   * carries the same key *and the same payload* is answered from that record
   * instead of sending again. Only accepted sends are recorded, so a genuine
   * failure still retries normally.
   *
   * This is what lets a durable retry queue be at-least-once on our side and
   * still not deliver twice: whoever owns the retry must reuse one stable key
   * per notification, and must render an identical payload every attempt.
   */
  idempotencyKey?: string;
};

const fromAddress = () =>
  process.env.TRANSACTIONAL_EMAIL_FROM ||
  process.env.EMAIL_FROM ||
  "Tomverse Insight <hello@tomverse.app>";

export async function sendTransactionalEmail(input: SendEmailInput) {
  if (!input.to) {
    console.warn(
      JSON.stringify({
        event: "transactional_email_skipped",
        reason: "recipient missing",
        subject: input.subject,
      })
    );
    return { sent: false, skipped: true };
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.warn(
      JSON.stringify({
        event: "transactional_email_skipped",
        reason: "RESEND_API_KEY missing",
        to: input.to,
        subject: input.subject,
      })
    );
    return { sent: false, skipped: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      // Resend caps the key at 256 characters.
      ...(input.idempotencyKey
        ? { "Idempotency-Key": input.idempotencyKey.slice(0, 256) }
        : {}),
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Email send failed: ${response.status} ${body.slice(0, 300)}`);
  }

  const responseBody = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  console.info(
    JSON.stringify({
      event: "transactional_email_sent",
      provider: "resend",
      id: typeof responseBody?.id === "string" ? responseBody.id : null,
      to: input.to,
      subject: input.subject,
      from: fromAddress(),
    })
  );

  return { sent: true, skipped: false, id: responseBody?.id || null };
}
