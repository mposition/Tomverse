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

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);
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
    console.log("Credit reservation reconciliation completed:", result?.result || {});
  }
} catch (error) {
  console.error("Credit reconciliation request failed:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
