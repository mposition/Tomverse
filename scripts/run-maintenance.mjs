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
  endpoint = new URL("/api/internal/maintenance/cleanup", baseUrl);
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
  if (!response.ok) {
    console.error("Maintenance request failed:", response.status, result);
    process.exitCode = 1;
  } else {
    console.log("Maintenance cleanup completed:", result?.deleted || {});
  }
} catch (error) {
  console.error("Maintenance request failed:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
