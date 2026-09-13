const baseUrl =
  process.env.MAINTENANCE_URL ||
  process.env.PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL;
const secret = process.env.MAINTENANCE_SECRET;

if (!baseUrl || !secret || secret.length < 32) {
  console.error(
    "MAINTENANCE_URL (or PUBLIC_APP_URL/NEXTAUTH_URL) and a 32+ character MAINTENANCE_SECRET are required."
  );
  process.exit(1);
}

let endpoint;
try {
  endpoint = new URL("/api/internal/maintenance/credit-reservations", baseUrl);
  const isLocal =
    endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !isLocal) {
    throw new Error("Maintenance URL must use HTTPS.");
  }
} catch (error) {
  console.error("Invalid maintenance URL:", error);
  process.exit(1);
}

/**
 * How long this runner waits before giving up on the route.
 *
 * It has to outlast the route, not merely approach it. The route declares
 * `maxDuration = 300` because it ends with the memory extraction dispatch,
 * which is budgeted at 120s and may overrun by one chunk -- so a healthy run
 * can take several minutes. This was 60s, left over from before that dispatch
 * existed, and on 2026-09-13 the staging route took 125s: the platform logged
 * `499 125012ms` for a request this runner had already abandoned at 60s, the
 * script exited 1, and Railway marked the deployment CRASHED. Nothing was
 * broken. The sweep finished; only the process that was waiting for it had
 * stopped waiting.
 *
 * Past the route's own limit, a slow run ends with whatever the platform
 * answers -- a result, a 503 this script already treats as a deferral, or a
 * timeout from the server side -- instead of an abort this process chose.
 * The margin covers a cold start and the network. The cron fires every fifteen
 * minutes (`railway.credit-reconciliation.json`), so a run this long never
 * overlaps the next. `tests/cronClientTimeouts.test.mjs` fails if this ever
 * falls back under the route's limit.
 */
const REQUEST_TIMEOUT_MS = 330_000;

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    signal: controller.signal,
  });
  const result = await response.json().catch(() => null);
  // A 503 the route marked retryable means the database dropped the
  // connection under an idempotent sweep that runs again in fifteen minutes.
  // Exiting non-zero on that turns a deferral into a crashed deployment, which
  // says the job is broken when nothing is. The route has already reported it.
  if (response.status === 503 && result?.retryable) {
    console.warn(
      "Credit reservation reconciliation deferred; the next scheduled run will retry:",
      result.code || "unknown"
    );
  } else if (!response.ok) {
    console.error("Credit reconciliation request failed:", response.status, result);
    process.exitCode = 1;
  } else {
    // `result.result` is the credit-reservation object alone. The response
    // carries a dozen sibling sweeps that ride along on this cadence -- image
    // assets, generated artifacts, message attachments, assistant knowledge,
    // staged imports, memory extraction -- and logging only the first field
    // discarded every one of them, so the cron's own log could not answer what
    // a run had deleted.
    //
    // Everything except `success` is reported. Naming the fields here would
    // mean editing this script every time a sweep is added, and the sweep that
    // gets forgotten is exactly the one nobody is watching.
    const sweeps = Object.fromEntries(
      Object.entries(result ?? {}).filter(([key]) => key !== "success")
    );
    console.log("Credit reservation reconciliation completed:", sweeps);
  }
} catch (error) {
  console.error("Credit reconciliation request failed:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
