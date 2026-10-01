// The marketing publisher's worker: one authenticated request, then exit.
//
// Started by scripts/run-marketing-publisher.mjs, which gives it the run id and
// the deadline and kills it at that deadline. It sends exactly `{ runId,
// deadline }` to the app route with the publisher's own secret, and reports
// what came back. It does not retry: the next run is five minutes away, and a
// retry of a request whose outcome is unknown is how a publisher does
// something twice.

const baseUrl = process.env.MARKETING_PUBLISH_URL;
const secret = process.env.MARKETING_PUBLISH_SECRET;
const runId = process.env.MARKETING_PUBLISHER_RUN_ID;
const deadline = process.env.MARKETING_PUBLISHER_DEADLINE;

if (!baseUrl || !secret || secret.length < 32) {
  console.error(
    "MARKETING_PUBLISH_URL and a 32+ character MARKETING_PUBLISH_SECRET are required.",
  );
  process.exit(1);
}
if (!runId || !deadline) {
  console.error(
    "This worker is started by scripts/run-marketing-publisher.mjs, which supplies the run id and deadline.",
  );
  process.exit(1);
}

let endpoint;
try {
  endpoint = new URL("/api/internal/marketing-publisher", baseUrl);
  const isLocal =
    endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !isLocal) {
    throw new Error("MARKETING_PUBLISH_URL must use HTTPS.");
  }
} catch (error) {
  console.error("Invalid MARKETING_PUBLISH_URL:", error);
  process.exit(1);
}

// Aborted a little before the deadline, so the worker can say it ran out of
// time rather than simply vanish when the supervisor's SIGKILL lands.
const remaining = new Date(deadline).getTime() - Date.now() - 2_000;
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), Math.max(0, remaining));

try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ runId, deadline }),
    signal: controller.signal,
  });
  const result = await response.json().catch(() => null);
  if (response.status === 202) {
    // The same run id is already running: a resend of this request. Not an
    // error, and not a second run.
    console.warn(`Marketing publisher run ${runId} is already running.`);
  } else if (!response.ok) {
    console.error(`Marketing publisher run ${runId} failed:`, response.status, result);
    process.exitCode = 1;
  } else if (result && result.status && result.status !== "succeeded") {
    // A 2xx says the request was handled; it does not say the run succeeded.
    // Exiting zero on a run the database recorded as failed would leave
    // Railway's green execution contradicting the row.
    console.error(`Marketing publisher run ${runId} did not succeed:`, result);
    process.exitCode = 1;
  } else {
    console.log(`Marketing publisher run ${runId}:`, result);
  }
} catch (error) {
  console.error(`Marketing publisher run ${runId} request did not complete:`, error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
