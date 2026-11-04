import { parseArgs } from "node:util";

const MAX_BACKFILL_DAYS = 31;
const DAY_MS = 86_400_000;

const baseUrl =
  process.env.PROVIDER_USAGE_SYNC_URL ||
  process.env.PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL;
const secret = process.env.PROVIDER_USAGE_SYNC_SECRET;

if (!baseUrl || !secret || secret.length < 32) {
  console.error(
    "PROVIDER_USAGE_SYNC_URL (or PUBLIC_APP_URL/NEXTAUTH_URL) and a 32+ character PROVIDER_USAGE_SYNC_SECRET are required."
  );
  process.exit(1);
}

const parseDay = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? parsed
    : null;
};

// With --from/--to this re-syncs each past UTC day without Slack reports. The
// route overwrites a day's provider_api row, so repeating a day is harmless.
const backfillDays = () => {
  const usage = `Use --from YYYY-MM-DD --to YYYY-MM-DD, at most ${MAX_BACKFILL_DAYS} days.`;
  let values;
  try {
    ({ values } = parseArgs({
      options: { from: { type: "string" }, to: { type: "string" } },
    }));
  } catch {
    console.error(usage);
    process.exit(1);
  }
  if (values.from === undefined && values.to === undefined) return null;
  const from = parseDay(values.from);
  const to = parseDay(values.to);
  const count = from && to ? (to.getTime() - from.getTime()) / DAY_MS + 1 : 0;
  if (count < 1 || count > MAX_BACKFILL_DAYS) {
    console.error(usage);
    process.exit(1);
  }
  return Array.from({ length: count }, (_, index) =>
    new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10)
  );
};

const days = backfillDays();

const syncUrl = (search) => {
  const endpoint = new URL(`/api/internal/provider-usage/sync?${search}`, baseUrl);
  const isLocal =
    endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !isLocal) {
    throw new Error("Provider usage sync URL must use HTTPS.");
  }
  return endpoint;
};

try {
  syncUrl("");
} catch (error) {
  console.error("Invalid provider usage sync URL:", error);
  process.exit(1);
}

const postSync = async (search) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(syncUrl(search), {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    return { response, result: await response.json().catch(() => null) };
  } finally {
    clearTimeout(timeout);
  }
};

// The web service logs the full diagnostic. This names the provider beside the
// run itself, on one line so that Railway keeps it together.
const logFailures = (result) => {
  const failures = (result?.results ?? []).filter(
    (item) => item.status === "failed"
  );
  for (const { provider, diagnostic } of failures) {
    console.error(
      `Provider usage sync failure: ${JSON.stringify({
        date: result.date,
        provider,
        httpStatus: diagnostic?.httpStatus ?? null,
        errorCode: diagnostic?.errorCode ?? null,
        failureStage: diagnostic?.failureStage ?? null,
        traceId: diagnostic?.traceId ?? null,
      })}`
    );
  }
  return failures.length;
};

const runDaily = async () => {
  const { response, result } = await postSync("notify=slack");
  if (!response.ok) {
    console.error("Daily provider usage sync failed:", response.status, result);
    process.exitCode = 1;
    return;
  }
  logFailures(result);
  console.log("Daily provider usage sync completed:", {
    date: result?.date,
    notification: result?.notification,
    infrastructureNotification: result?.infrastructureNotification,
  });
};

const backfillDay = async (date) => {
  const { response, result } = await postSync(`date=${date}`);
  // The route answers for yesterday when it cannot read the date.
  if (!response.ok || result?.date !== date) {
    console.error(
      `Provider usage backfill failed: ${JSON.stringify({ date, httpStatus: response.status })}`
    );
    return false;
  }
  const failed = logFailures(result);
  console.log(
    `Provider usage backfill: ${JSON.stringify({
      date,
      synced: result.results.filter((item) => item.status === "synced").length,
      failed,
    })}`
  );
  return failed === 0;
};

const runBackfill = async () => {
  for (const date of days) {
    const succeeded = await backfillDay(date).catch((error) => {
      console.error(`Provider usage backfill failed: ${date}`, error);
      return false;
    });
    if (!succeeded) process.exitCode = 1;
  }
};

try {
  await (days ? runBackfill() : runDaily());
} catch (error) {
  console.error("Daily provider usage sync failed:", error);
  process.exitCode = 1;
}
