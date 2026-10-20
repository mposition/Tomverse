import { setTimeout as sleepFor } from "node:timers/promises";

/** The v19 runner's one path to the app, and the stop rule it polls under.
 *
 * The fixed Ubuntu worker reaches the app over Wi-Fi only (operator,
 * 2026-10-20: a wired link is not possible), so drops of a few seconds are
 * routine: a DNS "Try again", a refused connect, a request that never
 * arrives. What a failure proves decides what may be sent again:
 *
 * - Unsent: fetch failed before the request could leave the host (DNS
 *   ENOTFOUND/EAI_AGAIN, ECONNREFUSED, no route, connect timeout), read from
 *   Node fetch's `error.cause.code`. The same bytes are sent again after a
 *   short backoff, a write included: nothing reached the app.
 * - Sent, answer lost (timeout, reset, lost body) or any failure this cannot
 *   classify: a write is never sent again; its caller reads back instead.
 *   A read has no effect, so it is simply asked again.
 * - A gateway answer (502/503/504) is asked again for a read, and handed to a
 *   write's caller for its readback.
 *
 * Bounds. The cycle unit runs with TimeoutStartSec=infinity and v19 has no
 * CLI deadline (scripts/systemd/amux-v19-max-session-cycle.service): the
 * operator's stop and the seven-day retention end a long call. Neither bounds
 * a retry, so these constants do. The staging drops of 2026-10-20 lasted
 * about ten seconds. One request waits at most its budget plus one
 * per-request timeout; a step whose request exhausts its budget ends the
 * step, so one cycle adds at most one exhausted budget per step on top of
 * its normal run, and an explicit operator stop is still honoured at once. */
export const AMUX_V19_APP_RETRY_DELAYS_MS = Object.freeze([
  1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
/** No new attempt starts once this much time has passed since the first:
 * three times the observed drop. */
export const AMUX_V19_APP_RETRY_BUDGET_MS = 30_000;
/** A readback decides whether an uncertain write landed, so it waits twice
 * as long before the step reports it unreachable. */
export const AMUX_V19_APP_READBACK_BUDGET_MS = 60_000;
/** Operator, 2026-10-20: only an explicit stop answer, or this long with no
 * stop answer at all, stops an attempt. */
export const AMUX_V19_STOP_UNREACHABLE_LIMIT_MS = 120_000;
/** Same cadence as the in-run poll (AMUX_V19_STOP_POLL_INTERVAL_MS). */
export const AMUX_V19_STOP_RETRY_INTERVAL_MS = 5_000;
export const AMUX_V19_STOP_READ_TIMEOUT_MS = 8_000;
/** A stop check answers `false` (the app said continue), this word (no
 * answer reached the runner) or anything else (stop). */
export const AMUX_V19_STOP_UNREACHABLE = "unreachable";

const GATEWAY = new Set([502, 503, 504]);
/** Codes Node fetch reports when no connection was ever established. */
const UNSENT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED",
  "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT"]);
const READ_FAILED = Object.freeze({ read: "read_unreachable",
  readback: "readback_unreachable", poll: "read_unreachable" });

const realTiming = Object.freeze({
  now: () => performance.now(),
  sleep: (ms, signal) => sleepFor(ms, undefined, signal ? { signal } : {}),
});
let timing = realTiming;

/** Tests replace the clock and the sleep so a retry schedule runs at once.
 * Returns the function that restores the previous timing. */
export function setAmuxV19AppTimingForTest(next) {
  const prior = timing;
  timing = next ?? realTiming;
  return () => { timing = prior; };
}

/** True only when every connect attempt failed before a connection existed.
 * Anything else, including our own timeout, may have reached the app. */
export function amuxV19RequestUnsent(error) {
  const cause = error?.cause;
  if (cause === null || typeof cause !== "object") return false;
  const causes = Array.isArray(cause.errors) && cause.errors.length > 0
    ? cause.errors : [cause];
  return causes.every((item) => UNSENT.has(item?.code));
}

async function boundedBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  let valid = true;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) { valid = false; break; }
      chunks.push(value);
      size += value.byteLength;
      if (size > maxBytes) { valid = false; break; }
    }
    return valid ? Buffer.concat(chunks, size) : null;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    try { await reader.cancel(); } catch { /* Never log response content. */ }
    reader.releaseLock();
  }
}

async function attemptOnce(request) {
  const signals = [AbortSignal.timeout(request.timeoutMs)];
  if (request.signal) signals.push(request.signal);
  let response;
  try {
    response = await request.fetchImpl(request.url, {
      method: request.method, redirect: "manual", cache: "no-store",
      signal: AbortSignal.any(signals), headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
  } catch (error) {
    return { failure: amuxV19RequestUnsent(error) ? "unsent" : "lost" };
  }
  try {
    if (response.url && response.url !== request.url) {
      try { await response.body?.cancel(); } catch { /* Redirect body. */ }
      return { failure: "redirected" };
    }
    const body = await boundedBody(response, request.maxBytes);
    return { reply: { kind: "response", status: response.status,
      contentType: response.headers?.get?.("content-type")?.split(";")[0]
        ?.trim().toLowerCase() ?? null, body } };
  } catch { return { failure: "lost" }; }
}

/** One request to the app under the rules above. `purpose` is "read",
 * "readback" (a read after an uncertain write), "poll" (one stop read; the
 * stop rule re-asks) or "write". Resolves to
 * `{ kind: "response", status, contentType, body }`, where body is a Buffer
 * the caller zeroes (null when oversized or malformed), or to
 * `{ kind: "failed", reason }` with a fixed reason word. Never throws for a
 * network failure. */
export async function amuxV19AppRequest(request) {
  const write = request.purpose === "write";
  // The time budget, not a count, ends the retries: past the listed delays
  // the last one repeats, so a 60 s readback really waits up to 60 s.
  const retries = request.purpose === "poll" ? 0 : Number.POSITIVE_INFINITY;
  const budget = request.purpose === "readback"
    ? AMUX_V19_APP_READBACK_BUDGET_MS : AMUX_V19_APP_RETRY_BUDGET_MS;
  const exhausted = Object.freeze({ kind: "failed", reason: write
    ? "network_unsent_retry_exhausted"
    : READ_FAILED[request.purpose] ?? "read_unreachable" });
  const started = timing.now();
  for (let tries = 0; ; tries += 1) {
    const outcome = await attemptOnce(request);
    if (outcome.reply) {
      if (write || !GATEWAY.has(outcome.reply.status)) return outcome.reply;
      outcome.reply.body?.fill(0);
    } else if (outcome.failure === "redirected") {
      return { kind: "failed", reason: "response_invalid" };
    } else if (write && outcome.failure !== "unsent") {
      return { kind: "failed", reason: "network_sent_unconfirmed" };
    }
    const wait = AMUX_V19_APP_RETRY_DELAYS_MS[
      Math.min(tries, AMUX_V19_APP_RETRY_DELAYS_MS.length - 1)];
    if (tries >= retries || request.signal?.aborted ||
        timing.now() - started + wait > budget) return exhausted;
    try { await timing.sleep(wait, request.signal); }
    catch { return exhausted; }
  }
}

/** The JSON of an application/json reply, else null. Zeroes the body. */
export function amuxV19ReplyJson(reply) {
  const body = reply?.kind === "response" ? reply.body : null;
  if (!body) return null;
  try {
    return reply.contentType === "application/json"
      ? JSON.parse(body.toString("utf8")) : null;
  } catch { return null; }
  finally { body.fill(0); }
}

/** The fixed reason a reply was not usable. */
export const amuxV19ReplyReason = (reply) =>
  reply?.kind === "failed" ? reply.reason : "response_invalid";

/** Why a write stays unconfirmed after its readback: the readback never
 * reached the app, else the write's own failure, else the app answered the
 * write with something other than its receipt. */
export const amuxV19UnconfirmedWriteReason = (write, readback) =>
  readback?.kind === "failed" && readback.reason === "readback_unreachable"
    ? "readback_unreachable"
    : write?.kind === "failed" ? write.reason : "write_unconfirmed";

/** One bounded stop read. "continue" only for an explicit `false`;
 * "unreachable" for a thrown, stalled or unanswered read; "aborted" when the
 * caller's own signal ended it; "stop" for every other answer. */
export async function readAmuxV19StopState(stopCheck, parentSignal,
  timeoutMs = AMUX_V19_STOP_READ_TIMEOUT_MS) {
  if (typeof stopCheck !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError("invalid v19 stop check");
  if (parentSignal?.aborted) return "aborted";
  const controller = new AbortController();
  const skipped = Symbol("skipped");
  let timer;
  let onParentAbort;
  try {
    const checked = Promise.resolve().then(() =>
      controller.signal.aborted ? skipped : stopCheck(controller.signal))
      .then((value) => value === skipped ? "aborted"
        : value === false ? "continue"
        : value === AMUX_V19_STOP_UNREACHABLE ? "unreachable" : "stop",
      () => "unreachable");
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("unreachable");
      }, timeoutMs);
    });
    const parentAborted = parentSignal ? new Promise((resolve) => {
      onParentAbort = () => { controller.abort(); resolve("aborted"); };
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      if (parentSignal.aborted) onParentAbort();
    }) : null;
    return await Promise.race(parentAborted
      ? [checked, expired, parentAborted] : [checked, expired]);
  } finally {
    clearTimeout(timer);
    if (onParentAbort) parentSignal.removeEventListener("abort", onParentAbort);
    controller.abort();
  }
}

/** The contact record of one attempt. `observe` turns one stop state into
 * the reason to stop now, or null: an explicit stop at once, an unanswered
 * read only once reads have failed in a row for the contact limit. */
export function createAmuxV19StopContact(
  limitMs = AMUX_V19_STOP_UNREACHABLE_LIMIT_MS) {
  let unreachableSince = null;
  return Object.freeze({
    observe(state) {
      if (state === "continue") {
        unreachableSince = null;
        return null;
      }
      if (state === "aborted") return "stop_aborted";
      if (state !== "unreachable") return "stop_requested";
      const now = timing.now();
      unreachableSince ??= now;
      return now - unreachableSince >= limitMs ? "stop_unreachable" : null;
    },
  });
}

/** While the CLI runs: one read; null means keep running. */
export async function pollAmuxV19Stop(stopCheck, contact, signal) {
  return contact.observe(await readAmuxV19StopState(stopCheck, signal));
}

/** Before a step the app must still allow (a checkout, the CLI, a receipt or
 * result write): only an explicit continue passes. An unanswered read is
 * asked again until the contact limit; an explicit stop ends it at once.
 * Resolves to null (continue) or the reason to stop. */
export async function confirmAmuxV19Continue(stopCheck, contact, signal) {
  while (true) {
    const state = await readAmuxV19StopState(stopCheck, signal);
    const reason = contact.observe(state);
    if (reason || state === "continue") return reason;
    try { await timing.sleep(AMUX_V19_STOP_RETRY_INTERVAL_MS, signal); }
    catch { return "stop_aborted"; }
  }
}
