const baseUrl =
  process.env.PROVIDER_MODEL_CATALOG_SYNC_URL ||
  process.env.PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL;
const secret =
  process.env.PROVIDER_MODEL_CATALOG_SYNC_SECRET ||
  process.env.MAINTENANCE_SECRET;

if (!baseUrl || !secret || secret.length < 32) {
  console.error(
    "PROVIDER_MODEL_CATALOG_SYNC_URL (or PUBLIC_APP_URL/NEXTAUTH_URL) and a 32+ character PROVIDER_MODEL_CATALOG_SYNC_SECRET (or MAINTENANCE_SECRET) are required."
  );
  process.exit(1);
}

let endpoint;
try {
  endpoint = new URL("/api/internal/provider-model-catalog/check", baseUrl);
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !local) {
    throw new Error("Provider model catalog monitor URL must use HTTPS.");
  }
} catch (error) {
  console.error("Invalid provider model catalog monitor URL:", error);
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
    console.error("Daily provider model catalog monitor failed:", response.status, result);
    process.exitCode = 1;
  } else {
    console.log("Daily provider model catalog monitor completed:", {
      generatedAt: result?.generatedAt,
      checked: result?.checked,
      failed: result?.failed,
      missing: result?.missing,
      newCandidates: result?.newCandidates,
      lifecycleWarnings: result?.lifecycleWarnings,
      slackDelivered: result?.slackDelivered,
      emailDelivered: result?.emailDelivered,
    });
  }
} catch (error) {
  console.error("Daily provider model catalog monitor failed:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

