import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_DELAYS_MS,
  classifyNotificationError,
  isPermanentDeliveryStatus,
  nextNotificationAttemptAt,
  nextNotificationDeliveryState,
} from "../lib/notificationRetryCore.ts";
import { buildSupportNotificationEmail } from "../lib/supportNotificationEmail.ts";

/**
 * The retry policy for operator notifications.
 *
 * The behaviour these pin down: a stored report never loses its notification
 * silently, a notification that cannot possibly succeed is not retried six
 * times to find that out, and nothing the provider says about the request is
 * ever written down.
 */

const NOW = new Date("2026-08-01T12:00:00.000Z");
const at = (outcome, attempts, now = NOW) =>
  nextNotificationDeliveryState({ outcome, attempts, now });

// --- delivered ---------------------------------------------------------------

test("a delivered notification is terminal and carries no error", () => {
  const state = at({ kind: "delivered" }, 1);
  assert.equal(state.status, "delivered");
  assert.equal(state.nextAttemptAt, null);
  assert.equal(state.lastErrorKind, null);
});

// --- transient failures ------------------------------------------------------

test("a transient failure schedules the next attempt with growing backoff", () => {
  const delays = [];
  for (let attempts = 1; attempts < NOTIFICATION_MAX_ATTEMPTS; attempts += 1) {
    const state = at({ kind: "failed", errorKind: "http_502", permanent: false }, attempts);
    assert.equal(state.status, "pending", `attempt ${attempts}`);
    assert.ok(state.nextAttemptAt, `attempt ${attempts} has no next attempt`);
    delays.push(state.nextAttemptAt.getTime() - NOW.getTime());
  }
  // Strictly increasing, and never shorter than a minute.
  assert.deepEqual(delays, [...NOTIFICATION_RETRY_DELAYS_MS]);
  assert.ok(delays.every((delay, index) => index === 0 || delay > delays[index - 1]));
  assert.ok(delays[0] >= 60_000);
});

test("the retry window is long enough to ride out an outage", () => {
  const total = NOTIFICATION_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  assert.ok(total >= 4 * 60 * 60_000, "retries give up in under four hours");
  assert.ok(total <= 24 * 60 * 60_000, "retries run for more than a day");
});

test("the final attempt abandons rather than scheduling a seventh", () => {
  const state = at(
    { kind: "failed", errorKind: "http_502", permanent: false },
    NOTIFICATION_MAX_ATTEMPTS
  );
  assert.equal(state.status, "abandoned");
  assert.equal(state.nextAttemptAt, null);
  assert.equal(state.lastErrorKind, "http_502");
});

test("backoff is clamped once the delay table runs out", () => {
  const last = NOTIFICATION_RETRY_DELAYS_MS[NOTIFICATION_RETRY_DELAYS_MS.length - 1];
  const beyond = nextNotificationAttemptAt(99, NOW);
  assert.equal(beyond.getTime() - NOW.getTime(), last);
});

// --- permanent failures ------------------------------------------------------

test("a request the provider rejected is not retried at all", () => {
  const state = at({ kind: "failed", errorKind: "http_422", permanent: true }, 1);
  assert.equal(state.status, "abandoned");
  assert.equal(state.nextAttemptAt, null);
});

test("statuses are split into permanent and worth-retrying", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isPermanentDeliveryStatus(status), true, String(status));
  }
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isPermanentDeliveryStatus(status), false, String(status));
  }
});

// --- nothing to send ---------------------------------------------------------

test("a notification with nothing to send is abandoned immediately", () => {
  for (const reason of ["recipient_not_configured", "source_missing"]) {
    const state = at({ kind: "unsendable", reason }, 1);
    assert.equal(state.status, "abandoned", reason);
    assert.equal(state.lastErrorKind, reason);
  }
});

test("unconfigured mail is retried, then abandoned so it cannot fail quietly", () => {
  const retrying = at({ kind: "not_configured" }, 1);
  assert.equal(retrying.status, "pending");
  assert.equal(retrying.lastErrorKind, "not_configured");

  const exhausted = at({ kind: "not_configured" }, NOTIFICATION_MAX_ATTEMPTS);
  assert.equal(exhausted.status, "abandoned");
  assert.equal(exhausted.lastErrorKind, "not_configured");
});

// --- error classification ----------------------------------------------------

test("an error is reduced to a transport classification, never a body", () => {
  const error = new Error(
    'Email send failed: 422 {"message":"CONFIDENTIAL-REPORT-TEXT","name":"validation_error"}'
  );
  const classified = classifyNotificationError(error);
  assert.equal(classified.errorKind, "http_422");
  assert.equal(classified.permanent, true);
  assert.ok(!classified.errorKind.includes("CONFIDENTIAL-REPORT-TEXT"));
});

test("a 5xx is classified as worth retrying", () => {
  const classified = classifyNotificationError(
    new Error("Email send failed: 503 upstream unavailable")
  );
  assert.equal(classified.errorKind, "http_503");
  assert.equal(classified.permanent, false);
});

test("a network error keeps its class and stays retryable", () => {
  const error = new TypeError("fetch failed");
  const classified = classifyNotificationError(error);
  assert.equal(classified.errorKind, "TypeError");
  assert.equal(classified.permanent, false);
});

test("an unrecognisable throw does not leak its text", () => {
  const classified = classifyNotificationError("SECRET-PROVIDER-TRACE-9999");
  assert.equal(classified.errorKind, "unknown");
  assert.equal(classified.permanent, false);
});

test("a stored error classification is always short and opaque", () => {
  for (const error of [
    new Error("Email send failed: 500 " + "x".repeat(5_000)),
    new Error("x".repeat(5_000)),
    new TypeError("y".repeat(5_000)),
  ]) {
    const { errorKind } = classifyNotificationError(error);
    assert.ok(errorKind.length <= 40, errorKind.slice(0, 60));
  }
});

// --- the rendered notification ----------------------------------------------

test("the operator email carries the report and escapes it", () => {
  const email = buildSupportNotificationEmail({
    feedbackId: "clzfeedback0001abcd",
    type: "bug",
    email: "member@tomverse.app",
    message: '<img src=x onerror="alert(1)">',
    traceId: "0d1f6b1e",
    modelId: "gemini-2-5-flash",
    plan: "Pro",
    attachmentCount: 2,
    path: "/chat",
  });

  assert.equal(email.subject, "Tomverse support request: bug");
  assert.ok(email.text.includes("clzfeedback0001abcd"));
  assert.ok(email.text.includes('<img src=x onerror="alert(1)">'));
  // The HTML part is escaped, so a report cannot inject markup into the inbox.
  assert.ok(!email.html.includes("<img src=x"));
  assert.ok(email.html.includes("&lt;img src=x"));
  assert.ok(!email.html.includes('onerror="alert(1)"'));
});

/*
 * This used to assert a "Delivery retry N" banner on a retried send. The
 * banner had to go: the provider's idempotency key only suppresses a duplicate
 * when the payload matches too, so a body that changes by attempt would defeat
 * the very thing that makes delivery exactly-once. Determinism is asserted
 * directly further down.
 */
test("the rendered notification carries no attempt-varying content", () => {
  const email = buildSupportNotificationEmail({
    feedbackId: "id",
    type: "bug",
    email: null,
    message: "hello there",
  });
  assert.ok(!/retry/i.test(email.text));
  assert.ok(!/retry/i.test(email.html));
});

test("a guest report is labelled rather than left blank", () => {
  const email = buildSupportNotificationEmail({
    feedbackId: "id",
    type: "other",
    email: null,
    message: "guest report",
  });
  assert.ok(email.text.includes("Email: guest"));
  assert.ok(email.text.includes("Trace ID: -"));
});

// --- source-level guards -----------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(ROOT, path), "utf8");

test("the queue never stores the report body, only a pointer to it", () => {
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(
    schema.indexOf("model NotificationDelivery"),
    schema.indexOf("model RefundRequest")
  );
  assert.ok(model.length > 0, "NotificationDelivery model is missing");
  for (const column of ["message", "html", "body", "subject", "recipient"]) {
    assert.ok(
      !new RegExp(`^\\s*${column}\\s`, "m").test(model),
      `NotificationDelivery must not store ${column}`
    );
  }
  // What it does store: where to find the source and how the retry is going.
  for (const column of ["kind", "referenceId", "status", "attempts", "nextAttemptAt"]) {
    assert.ok(new RegExp(`^\\s*${column}\\s`, "m").test(model), `missing ${column}`);
  }
});

test("one queue row per source record", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /@@unique\(\[kind, referenceId\]\)/);
});

test("the report and its queue row are written in one transaction", () => {
  const route = read("app/api/feedback/route.ts");
  assert.match(route, /prisma\.\$transaction\(async \(tx\) => \{/);
  assert.match(route, /tx\.feedback\.create/);
  assert.match(route, /enqueueNotificationDelivery\(tx/);
});

test("a failed notification never fails the submission", () => {
  const route = read("app/api/feedback/route.ts");
  const afterWrite = route.slice(route.indexOf("attemptNotificationDelivery"));
  // No throw, no non-200 path between the stored report and the response.
  assert.ok(!/throw /.test(afterWrite.slice(0, afterWrite.indexOf("} catch (error) {\n    const securityResponse"))));
  assert.match(route, /success: true/);
});

test("the drain cannot fail the job it rides along with", () => {
  const job = read("lib/notificationDeliveryJob.ts");
  assert.match(job, /export async function drainNotificationDeliveriesQuietly/);
  assert.match(job, /catch \(error\)/);
  const cron = read("app/api/internal/maintenance/credit-reservations/route.ts");
  assert.match(cron, /drainNotificationDeliveriesQuietly\(\)/);
});

test("settled deliveries are swept but pending ones are never dropped", () => {
  const maintenance = read("lib/maintenance.ts");
  const block = maintenance.slice(
    maintenance.indexOf("notificationDelivery.deleteMany"),
    maintenance.indexOf("notificationDelivery.deleteMany") + 400
  );
  assert.match(block, /status: \{ in: \["delivered", "abandoned"\] \}/);
  assert.ok(!/status: "pending"/.test(block));
});

test("the drain endpoint is secret-gated like every other maintenance route", () => {
  const route = read("app/api/internal/maintenance/notification-deliveries/route.ts");
  assert.match(route, /MAINTENANCE_SECRET/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /status: 401/);
});

test("nothing in the delivery path logs the report or the recipient's mail body", () => {
  for (const path of [
    "lib/notificationDeliveries.ts",
    "lib/notificationDeliveryJob.ts",
    "app/api/feedback/route.ts",
  ]) {
    // Comments explaining *why* something is not logged are not themselves a
    // leak, so they are stripped before the check.
    const source = read(path)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const logged = source.match(/console\.(log|info|warn|error)\([\s\S]*?\n\s*\);/g) || [];
    for (const call of logged) {
      assert.ok(
        !/\bmessage\b|\bhtml\b|\btext\b|body\.message/.test(call),
        `${path} logs notification content: ${call.slice(0, 140)}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Exactly-once delivery, and the payload determinism it depends on
// ---------------------------------------------------------------------------

test("every attempt at one notification presents the same idempotency key", () => {
  const queue = read("lib/notificationDeliveries.ts");
  // Derived from the queue row, not from the attempt: a retry must present
  // the key the first attempt used, or the provider cannot suppress it.
  assert.match(queue, /idempotencyKey: `notification-delivery:\$\{deliveryId\}`/);
  assert.ok(
    !/idempotencyKey:[^\n]*attempt/.test(queue),
    "the idempotency key varies by attempt, which defeats it"
  );
});

test("the mailer forwards the key as the provider's header, within its limit", () => {
  // The wire call moved into the provider port (docs/policy/email-notifications.md
  // §8.2) when `lib/email.ts` stopped holding two copies of it. The invariant is
  // unchanged: whatever the queue hands down reaches the provider as its
  // idempotency header, cut to the length the provider accepts.
  const core = read("lib/emailProviderPortCore.ts");
  assert.match(core, /"Idempotency-Key": config\.idempotencyKey\.slice\(0, 256\)/);
});

test("a notification renders identically however many times it is attempted", () => {
  const input = {
    feedbackId: "clzfeedback0001abcd",
    type: "bug",
    email: "member@tomverse.app",
    message: "the same report every time",
    traceId: "0d1f6b1e",
    modelId: "gemini-2-5-flash",
    plan: "Pro",
    attachmentCount: 1,
    path: "/chat",
  };
  const first = buildSupportNotificationEmail(input);
  const later = buildSupportNotificationEmail(input);
  assert.deepEqual(first, later);
  // Nothing attempt-shaped may creep back into the body: the provider matches
  // on the payload as well as the key.
  for (const rendered of [first.text, first.html, first.subject]) {
    assert.ok(!/retry/i.test(rendered), "the rendered mail mentions a retry");
  }
});

// ---------------------------------------------------------------------------
// Which notifications the queue owns
// ---------------------------------------------------------------------------

test("the queue covers the emails that were being dropped silently", () => {
  const queue = read("lib/notificationDeliveries.ts");
  for (const kind of [
    "support_feedback",
    "refund_request_received",
    "refund_request_approved",
    "refund_request_rejected",
  ]) {
    assert.ok(queue.includes(`"${kind}"`), `${kind} is not a queued notification`);
  }
});

test("the refund emails no longer swallow their own failures", () => {
  for (const path of [
    "app/api/billing/refund-request/route.ts",
    "app/api/admin/refund-requests/[requestId]/route.ts",
  ]) {
    const source = read(path);
    assert.ok(
      !/console\.error\("Refund [^"]*email failed/.test(source),
      `${path} still drops a refund email on the floor`
    );
    assert.match(source, /enqueueNotificationDelivery/, `${path} does not queue`);
    assert.match(source, /deliverNotificationNow/, `${path} makes no inline attempt`);
  }
});

test("a refund receipt and its queue row are written together", () => {
  const source = read("app/api/billing/refund-request/route.ts");
  assert.match(source, /prisma\.\$transaction\(async \(tx\) => \{/);
  assert.match(source, /tx\.refundRequest\.create/);
  assert.match(source, /enqueueNotificationDelivery\(tx/);
});

/**
 * Every place that sends mail is accounted for. A sender is acceptable when it
 * goes through the retry queue, retries by its own mechanism, or is
 * deliberately fire-and-forget for a stated reason. What is not acceptable is
 * a new one quietly joining the "logged and forgotten" category, which is how
 * the refund emails went unnoticed.
 */
test("every transactional email sender has a reviewed failure policy", () => {
  const CLASSIFIED = {
    "lib/notificationDeliveries.ts": "is the retry queue itself",
    "lib/supportNotificationEmail.ts": "renders for the queue, does not send",
    // Claims its row before sending and resets the claim on failure, so the
    // next maintenance pass retries it.
    "lib/maintenance.ts": "retries via its own claim/reset",
    "lib/billingEmails.ts": "renders and sends; callers own the policy",
    "lib/accountEmails.ts": "renders and sends; callers own the policy",
    // Time-sensitive by design: a login code delivered late is worse than
    // one not delivered, and the user can simply request another.
    "lib/emailLoginEmails.ts": "deliberately fire-and-forget (time-sensitive)",
    // Records every send, skip and failure in its own report table, which the
    // admin console surfaces.
    "lib/providerModelCatalogReport.ts": "records outcomes in its report table",
    "app/api/admin/test-email/route.ts": "an admin's own manual probe",
    // Raises an operational incident on failure.
    "app/api/user/account/route.ts": "alerts via reportOperationalIncident",
    "app/api/billing/refund-request/route.ts": "queued",
    "app/api/admin/refund-requests/[requestId]/route.ts": "queued",
  };

  const senders = execFileSync(
    "git",
    ["grep", "-l", "sendTransactionalEmail", "--", "lib", "app"],
    { cwd: ROOT, encoding: "utf8" }
  )
    .split("\n")
    .filter(Boolean)
    .filter((path) => path !== "lib/email.ts");

  const unclassified = senders.filter((path) => !(path in CLASSIFIED));
  assert.deepEqual(
    unclassified,
    [],
    `These files send email with no reviewed failure policy. Route them through\n` +
      `lib/notificationDeliveries.ts, give them their own retry, or add them to\n` +
      `CLASSIFIED here with the reason they may be fire-and-forget:\n` +
      unclassified.join("\n")
  );
});

// ---------------------------------------------------------------------------
// Backlog
// ---------------------------------------------------------------------------

test("a drain keeps going while there is due work, within a bounded budget", () => {
  const queue = read("lib/notificationDeliveries.ts");
  // The old shape stopped after one batch, capping throughput at 25 rows per
  // cron tick however deep the queue was.
  assert.match(queue, /while \(result\.batches < maxBatches\)/);
  assert.match(queue, /if \(Date\.now\(\) >= deadline\) break;/);
  assert.match(queue, /result\.exhausted = true;/);
});

test("a queue that is not keeping up says so before anything abandons", () => {
  const job = read("lib/notificationDeliveryJob.ts");
  assert.match(job, /NOTIFICATION_DELIVERY_BACKLOG/);
  assert.match(
    job,
    /result\.pending >= NOTIFICATION_QUEUE_DEPTH_ALERT \|\| !result\.exhausted/
  );
});
