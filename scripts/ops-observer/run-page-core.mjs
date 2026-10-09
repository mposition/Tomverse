// One run of the ops-observer page service (docs/policy/sre-ops.md §1 item 1,
// §3, §5, §6, §9 decision T-1). The supervisor starts it every ten minutes with
// only its own variables and kills it at 180 s.
//
// In order, and every step that cannot be trusted ends the run with nothing
// sent and no heartbeat -- the silence is what P8 reports (§3 rule 7):
//
//   1. The run's deadline (start + 180 s), id and owner date (the calendar
//      date in Australia/Brisbane, decision T-1).
//   2. /api/health and the closed ops snapshot; a failure only makes keys
//      unknown, it never invents a bad value.
//   3. The state for that owner date. Anything but trusted stops here.
//   4. Every key moved by evaluateKey(); what the move owes by owedMessages();
//      what the day's budget admits by admitOwedItems() over the reserved rows
//      the state carried -- the store re-runs the same functions, so a
//      reservation this run makes is one the advance accepts.
//   5. One advance: the next keys and, at most, one reservation of the
//      admitted items. Only an `advanced` answer with sendPermitted carries a
//      reservation to act on.
//   6. In shadow mode the message is rendered and held to the content guard,
//      never sent, and the reservation is closed with confirm (shadowed). Live
//      sending is the S2 page channel and is not built: a live chain stops
//      before anything is sent, and the next run abandons the reservation.
//   7. The heartbeat, unless the advance withheld it (§3 rule 9) or anything
//      above did not finish.
//
// No request is retried. Logs are one JSON line per run with enums and counts
// only: no URL, no secret, no key state, no response body.

import { incidentOrigin, owedMessages } from "./advance-request-core.mjs";
import { S2_PAGE_SIGNALS, evaluateKey } from "./classify-core.mjs";
import { checkNotification, isCanonicalItemId, renderChannelCheckMessage, renderPageMessage } from "./content-guard-core.mjs";
import { observationsFromSnapshot, parseSnapshot } from "./envelope-schema-core.mjs";
import { admitOwedItems, planRunMessage } from "./notification-budget-core.mjs";
import { RUN_DEADLINE_MS } from "./transaction-bounds-core.mjs";
import { OWNER_TIME_ZONE, ownerDateOf } from "./owner-date-core.mjs";

// Re-exported for the run's callers and tests; the rule lives in owner-date-core.
export { OWNER_TIME_ZONE, ownerDateOf };
import { TRUST_REASONS } from "./trust-check-core.mjs";

/** The store's advance and confirm answers; anything else is logged as unknown. */
const ADVANCE_RESULTS = Object.freeze(["advanced", "noop", "conflict", "replayed", "rejected", "reservation_not_owed",
  "channel_check_taken", "untrusted"]);
const CONFIRM_RESULTS = Object.freeze(["confirmed", "shadowed", "replayed", "abandoned", "not_found", "untrusted"]);

/** A response string as a closed enum: a 409 is the deadline, an unlisted value is unknown. */
const asEnum = (answer, field, allowed) =>
  answer.status === 409 ? "late" : allowed.includes(answer.json?.[field]) ? answer.json[field] : "unknown";


/** Each request's own limit; the supervisor's 180 s bounds the run. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** No request starts with less than this left before the run deadline. */
const DEADLINE_MARGIN_MS = 5_000;


/** A run id in the shape OpsObserverDelivery_runId_check accepts. */
export function runIdOf(ms, random) {
  return `page-${ms.toString(36)}-${random.replace(/[^0-9a-f]/g, "").slice(0, 12)}`;
}

/**
 * The next keys and what the run may reserve, from the trusted state and the
 * observations. Pure. Returns { keys, reservation, deferred } where
 * `reservation` is null or the advance request's reservation.
 */
export function planAdvance({ state, observations, nowMs, ownerDate, channelCheckDue = false }) {
  const keys = {};
  for (const signal of S2_PAGE_SIGNALS) {
    for (const scope of signal.scopes) {
      const key = `${signal.id}#${scope}`;
      keys[key] = evaluateKey(signal, state.keys[key], observations[key] ?? "unknown", { now: nowMs, ownerDate }).state;
    }
  }
  const owed = owedMessages(state.keys, keys, ownerDate);
  const { admitted, deferred } = admitOwedItems({
    reservedToday: state.budget.reservedToday,
    owed: owed.map((item) => ({ ...item, key: `${item.signal}#${item.scope}` })),
  });
  const plan = planRunMessage({ admitted, channelCheckDue: channelCheckDue && !state.budget.channelCheckTaken });
  const reservation = plan
    ? {
        ownerDate,
        channelCheck: plan.withChannelCheck,
        items: plan.items.map((item) => ({
          signal: item.signal,
          scope: item.scope,
          kind: item.kind,
          // How the incident began, from its open state: the key now for an
          // opening or a worsening, the key before the move for a recovery.
          origin: incidentOrigin(item.kind === "recovery" ? state.keys[item.key] : keys[item.key]),
          openedAt: item.openedAt,
        })),
      }
    : null;
  return { keys, reservation, deferred: deferred.length };
}

const isTrustedState = (body) =>
  body !== null &&
  typeof body === "object" &&
  body.trust === "trusted" &&
  typeof body.genesisId === "string" &&
  Number.isSafeInteger(body.generation) &&
  (body.mode === "shadow" || body.mode === "live") &&
  body.keys !== null &&
  typeof body.keys === "object" &&
  body.budget !== null &&
  typeof body.budget === "object" &&
  Array.isArray(body.budget.reservedToday) &&
  typeof body.budget.channelCheckTaken === "boolean";

/**
 * Runs once. `env` holds the child's variables; `fetchImpl`, `now` and
 * `random` are injected so tests drive every branch. Resolves to
 * { exitCode, outcome } and logs one line.
 */
export async function runPage({ env, fetchImpl = globalThis.fetch, now = Date.now, random = () => crypto.randomUUID(), log = console.log }) {
  const startedAt = now();
  const deadline = startedAt + RUN_DEADLINE_MS;
  const runDeadline = new Date(deadline).toISOString();
  const runId = runIdOf(startedAt, random());
  const ownerDate = ownerDateOf(startedAt);
  const app = env.OPS_OBSERVER_APP_URL;
  const record = { event: "ops_observer_page_run", ownerDate };
  const finish = (exitCode, outcome, extra = {}) => {
    log(JSON.stringify({ ...record, ...extra, outcome, exitCode }));
    return { exitCode, outcome };
  };

  const request = async (path, { method = "POST", body, bearer = true, url } = {}) => {
    if (now() > deadline - DEADLINE_MARGIN_MS) return { late: true };
    try {
      const response = await fetchImpl(url ?? `${app}${path}`, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${env.OPS_OBSERVER_SECRET}` } : {}),
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

  // 2. Health and the snapshot. Health itself is unauthenticated.
  const health = await request("/api/health", { method: "GET", bearer: false });
  const healthOk = health.status === 200;
  let snapshot = null;
  if (healthOk) {
    const answer = await request("/api/internal/ops-snapshot");
    if (answer.status === 200) {
      const parsed = parseSnapshot(answer.json);
      snapshot = parsed.ok ? parsed.snapshot : null;
    }
  }
  const observations = observationsFromSnapshot({ healthOk, snapshot });

  // 3. The state. Only trusted goes on.
  const state = await request("/api/internal/ops-observer/state", { body: { runDeadline, ownerDate } });
  if (state.late) return finish(1, "late");
  if (state.status === 409) return finish(1, "late");
  if (state.status !== 200 || !isTrustedState(state.json)) {
    const reason = TRUST_REASONS.includes(state.json?.trust) ? state.json.trust : "state_unavailable";
    return finish(1, "untrusted", { reason });
  }
  record.mode = state.json.mode;

  // 4. The next keys and the reservation the budget admits.
  const plan = planAdvance({ state: state.json, observations, nowMs: startedAt, ownerDate });
  record.deferred = plan.deferred;
  record.reservedItems = plan.reservation ? plan.reservation.items.length : 0;

  // 5. One advance.
  const advance = await request("/api/internal/ops-observer/advance", {
    body: {
      runDeadline,
      runId,
      baseGenesisId: state.json.genesisId,
      baseGeneration: state.json.generation,
      ownerDate,
      keys: plan.keys,
      reservation: plan.reservation,
    },
  });
  if (advance.late) return finish(1, "late");
  const result = advance.json?.result;
  if (advance.status === 409) return finish(1, "late");
  if (advance.status !== 200 || (result !== "advanced" && result !== "noop")) {
    return finish(1, "advance_refused", { result: asEnum(advance, "result", ADVANCE_RESULTS) });
  }

  // 6. The reservation, if this answer carries one.
  if (result === "advanced" && advance.json.sendPermitted === true) {
    const deliveryId = advance.json.deliveryId;
    // A permitted answer with no reservation planned, or an id the link
    // cannot carry, is not one this run can act on.
    if (!plan.reservation || !isCanonicalItemId(deliveryId)) return finish(1, "delivery_unusable");
    const message =
      plan.reservation.items.length > 0
        ? renderPageMessage({ itemId: deliveryId, withChannelCheck: plan.reservation.channelCheck })
        : renderChannelCheckMessage();
    const kind = plan.reservation.items.length > 0 ? "page" : "channel_check";
    const guard = checkNotification(kind, message);
    if (!guard.ok) return finish(1, "content_refused", { reason: guard.reason });
    if (state.json.mode !== "shadow") {
      // S2's page channel is not built; nothing is sent and the next run
      // closes this reservation as abandoned.
      return finish(1, "live_send_not_built");
    }
    const confirm = await request("/api/internal/ops-observer/confirm", { body: { runDeadline, deliveryId, runId } });
    if (confirm.late) return finish(1, "late");
    if (confirm.status === 409) return finish(1, "late");
    if (confirm.status !== 200 || confirm.json?.result !== "shadowed") {
      return finish(1, "confirm_refused", { result: asEnum(confirm, "result", CONFIRM_RESULTS) });
    }
    record.shadowed = true;
  }

  // 7. The heartbeat.
  if (advance.json.heartbeatWithheld === true) return finish(0, "heartbeat_withheld");
  const beat = await request("", { method: "GET", bearer: false, url: env.OPS_OBSERVER_HEARTBEAT_URL });
  if (beat.late) return finish(1, "late");
  if (!(beat.status >= 200 && beat.status < 300)) return finish(1, "heartbeat_failed");
  return finish(0, result === "noop" ? "noop" : "advanced");
}
