import http from "node:http";
import https from "node:https";

// AMUX already reads every subscription account the reviewers share, paced
// and cached (crates/amux-server/src/api/usage.rs), and serves the result at
// GET /api/usage on its own machine. Reading it here, rather than asking each
// vendor again, keeps one prober per account: the Claude usage endpoint
// rate-limits hard (HTTP 429) when two readers poll the same login.

const UNKNOWN = { state: "unknown" };
/** One read answers every provider for a minute: AMUX caches its own answer for that long. */
export const AMUX_USAGE_CACHE_MS = 60_000;
export const AMUX_USAGE_TIMEOUT_MS = 12_000;
export const AMUX_USAGE_MAX_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * The usage URL, if it names AMUX on this machine: http or https on a
 * loopback host. AMUX serves a self-signed certificate there, so TLS is not
 * verified -- which is only acceptable because the request never leaves the
 * machine. Anything else is refused rather than read without verification.
 */
export function amuxUsageEndpoint(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.username || url.password) return null;
  return url;
}

/**
 * One provider's quota from AMUX's usage body: the smallest remaining share of
 * its windows, as AMUX measured them. Anything AMUX did not measure, marks
 * stale, or does not list is unknown -- assignment needs evidence.
 */
export function amuxQuotaFromUsage(body, providerId) {
  if (!body || typeof body !== "object" || body.available !== true || body.stale === true) return UNKNOWN;
  const providers = Array.isArray(body.providers) ? body.providers : [];
  const entry = providers.find((row) => row && typeof row === "object" && row.id === providerId);
  if (!entry || entry.available !== true || entry.measured !== true || entry.stale === true) return UNKNOWN;
  const windows = Array.isArray(entry.windows) ? entry.windows : [];
  const remaining = windows
    .map((window) => window?.remaining_percent)
    .filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
  if (remaining.length === 0 || remaining.length !== windows.length) return UNKNOWN;
  const remainingPercent = Math.min(...remaining);
  return { state: remainingPercent === 0 ? "exhausted" : "available", remainingPercent };
}

/** GET the usage body: JSON within the size limit, or null for any failure. */
export function readAmuxUsage(url, { request, timeoutMs = AMUX_USAGE_TIMEOUT_MS } = {}) {
  const send = request ?? (url.protocol === "https:" ? https.request : http.request);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = send(url, {
        method: "GET",
        headers: { accept: "application/json" },
        // Loopback only (amuxUsageEndpoint): AMUX's certificate is self-signed.
        ...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return finish(null);
        }
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > AMUX_USAGE_MAX_BYTES) {
            res.destroy();
            return finish(null);
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            finish(null);
          }
        });
        res.on("error", () => finish(null));
      });
    } catch {
      return finish(null);
    }
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
    req.end();
  });
}

const amuxReads = new Map();

/**
 * The quota for one provider from AMUX. Every provider on the same URL shares
 * one read a minute, and a read already on its way answers every caller.
 * `provider.amuxProvider` names the AMUX provider when its id differs.
 */
export async function amuxQuota(provider, usageUrl, { now = Date.now(), read = readAmuxUsage, reads = amuxReads } = {}) {
  const url = amuxUsageEndpoint(usageUrl);
  if (!url) return UNKNOWN;
  const key = url.href;
  const entry = reads.get(key) ?? { at: -Infinity, body: null, inflight: null };
  reads.set(key, entry);
  const providerId = provider.amuxProvider ?? provider.id;
  if (entry.inflight) return amuxQuotaFromUsage(await entry.inflight, providerId);
  if (now >= entry.at && now - entry.at < AMUX_USAGE_CACHE_MS) return amuxQuotaFromUsage(entry.body, providerId);
  entry.inflight = read(url)
    .catch(() => null)
    .then((body) => {
      entry.body = body;
      entry.at = now;
      return body;
    })
    .finally(() => {
      entry.inflight = null;
    });
  return amuxQuotaFromUsage(await entry.inflight, providerId);
}
