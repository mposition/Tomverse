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

let endpoint;
try {
  endpoint = new URL("/api/internal/provider-usage/sync?notify=slack", baseUrl);
  const isLocal =
    endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !isLocal) {
    throw new Error("Provider usage sync URL must use HTTPS.");
  }
} catch (error) {
  console.error("Invalid provider usage sync URL:", error);
  process.exit(1);
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000);
try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    signal: controller.signal,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    console.error("Daily provider usage sync failed:", response.status, result);
    process.exitCode = 1;
  } else {
    console.log("Daily provider usage sync completed:", {
      date: result?.date,
      notification: result?.notification,
      infrastructureNotification: result?.infrastructureNotification,
    });
  }
} catch (error) {
  console.error("Daily provider usage sync failed:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
