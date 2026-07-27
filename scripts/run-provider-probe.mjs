const baseUrl =
  process.env.PROVIDER_PROBE_URL ||
  process.env.PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL;
const secret = process.env.PROVIDER_PROBE_SECRET || process.env.MAINTENANCE_SECRET;

if (!baseUrl || !secret || secret.length < 32) {
  console.error(
    "PROVIDER_PROBE_URL (or PUBLIC_APP_URL/NEXTAUTH_URL) and a 32+ character PROVIDER_PROBE_SECRET (or MAINTENANCE_SECRET) are required."
  );
  process.exit(1);
}

let endpoint;
try {
  endpoint = new URL("/api/internal/provider-probe/check", baseUrl);
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1";
  if (endpoint.protocol !== "https:" && !local) {
    throw new Error("Provider probe URL must use HTTPS.");
  }
} catch (error) {
  console.error("Invalid provider probe URL:", error);
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
    console.error("Provider probe cycle failed:", response.status, result);
    process.exitCode = 1;
  } else {
    console.log("Provider probe cycle completed:", {
      generatedAt: result?.generatedAt,
      succeeded: result?.succeeded,
      failed: result?.failed,
      noProbeModel: result?.noProbeModel,
      skipped: result?.skipped,
    });
  }
} catch (error) {
  console.error("Provider probe cycle failed:", error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
