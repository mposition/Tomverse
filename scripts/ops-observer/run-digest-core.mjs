// One run of the ops-observer digest service (docs/policy/sre-ops.md §1 item
// 3, §3 rules 1, 2 and 7, §4, §7, §9 T-1). The supervisor starts it once a day
// with only its own variables and kills it at 180 s.
//
//   1. The run's deadline (start + 180 s) and the owner date it reports:
//      yesterday in Australia/Brisbane, which is closed by the time the cron
//      runs (07:00 Brisbane) -- a date that is not is refused before any request.
//   2. The digest submission, naming only that date. The app builds and keeps
//      the digest; `created` or `replayed` carries the kept item's id, and
//      anything else (an untrusted chain included) ends the run with nothing
//      sent and no heartbeat (§3 rule 7).
//   3. Only for a digest this run created: the fixed digest sentence and its
//      Admin link, held to the content guard, posted once to the owner's
//      Slack incoming webhook. A webhook that is not Slack's is refused, and a
//      failed post is not retried -- the run then withholds its heartbeat, so
//      the dead-man monitor says the notice did not arrive.
//   4. The heartbeat.
//
// No request is retried. One JSON log line per run: enums, the owner date and
// whether a notice went out -- no URL, secret, id or response body.

import { checkNotification, isCanonicalItemId, renderDigestNotice } from "./content-guard-core.mjs";
import { ownerDateIsFinal, ownerDateOf } from "./owner-date-core.mjs";
import { RUN_DEADLINE_MS } from "./transaction-bounds-core.mjs";

/** Each request's own limit; the supervisor's 180 s bounds the run. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** No request starts with less than this left before the run deadline. */
const DEADLINE_MARGIN_MS = 5_000;

/** The only destination a digest notice may be posted to: a Slack incoming webhook. */
export const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The digest submission's answers; anything else is logged as unknown. */
const DIGEST_RESULTS = Object.freeze(["created", "replayed", "refused", "untrusted"]);

/** The owner date a run started at `startMs` reports: the day before, in Brisbane. */
export function digestOwnerDateOf(startMs) {
  return ownerDateOf(startMs - DAY_MS);
}

/** The Slack incoming-webhook body for one notice; links are not unfurled. */
export function slackNoticeBody(text) {
  return { text, unfurl_links: false, unfurl_media: false };
}

/**
 * Runs once. `env` holds the child's variables; `fetchImpl` and `now` are
 * injected so tests drive every branch. Resolves to { exitCode, outcome } and
 * logs one line.
 */
export async function runDigest({ env, fetchImpl = globalThis.fetch, now = Date.now, log = console.log }) {
  const startedAt = now();
  const deadline = startedAt + RUN_DEADLINE_MS;
  const runDeadline = new Date(deadline).toISOString();
  const ownerDate = digestOwnerDateOf(startedAt);
  const record = { event: "ops_observer_digest_run", ownerDate, notified: false };
  const finish = (exitCode, outcome, extra = {}) => {
    log(JSON.stringify({ ...record, ...extra, outcome, exitCode }));
    return { exitCode, outcome };
  };

  const request = async (url, { method = "POST", body, bearer = false } = {}) => {
    if (now() > deadline - DEADLINE_MARGIN_MS) return { late: true };
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${env.OPS_OBSERVER_DIGEST_SECRET}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json };
    } catch {
      return { failed: true };
    }
  };

  // 1. A date that is not closed is not asked for.
  if (!ownerDateIsFinal(ownerDate, startedAt)) return finish(1, "date_not_final");

  // 2. The submission.
  const submitted = await request(`${env.OPS_OBSERVER_APP_URL}/api/internal/ops-observer/digest`, {
    bearer: true,
    body: { runDeadline, ownerDate },
  });
  if (submitted.late) return finish(1, "late");
  if (submitted.status === 409) return finish(1, "late");
  const result = submitted.json?.result;
  if (submitted.status !== 200 || (result !== "created" && result !== "replayed")) {
    return finish(1, "digest_refused", {
      result: DIGEST_RESULTS.includes(result) ? result : "unknown",
    });
  }
  const itemId = submitted.json.itemId;
  if (!isCanonicalItemId(itemId)) return finish(1, "item_unusable");
  record.result = result;

  // 3. The notice, once, for a digest this run created.
  if (result === "created") {
    const webhook = env.OPS_OBSERVER_DIGEST_WEBHOOK_URL;
    if (typeof webhook !== "string" || !webhook.startsWith(SLACK_WEBHOOK_PREFIX)) return finish(1, "webhook_not_slack");
    const text = renderDigestNotice({ itemId });
    const guard = checkNotification("digest", text);
    if (!guard.ok) return finish(1, "content_refused", { reason: guard.reason });
    const posted = await request(webhook, { body: slackNoticeBody(text) });
    if (posted.late) return finish(1, "late");
    if (posted.status !== 200) return finish(1, "notice_failed");
    record.notified = true;
  }

  // 4. The heartbeat.
  const beat = await request(env.OPS_OBSERVER_DIGEST_HEARTBEAT_URL, { method: "GET" });
  if (beat.late) return finish(1, "late");
  if (!(beat.status >= 200 && beat.status < 300)) return finish(1, "heartbeat_failed");
  return finish(0, result);
}
