import { randomInt } from "node:crypto";
import { getTrustedClientIp } from "@/lib/clientIp";

const MAX_REPORT_BYTES = 16 * 1024;
const MAX_IP_BUCKETS = 10_000;
const BUCKET_RETENTION_MS = 2 * 60_000;

type ReportBucket = {
  minute: number;
  count: number;
  lastSeen: number;
};

const reportBuckets = new Map<string, ReportBucket>();

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const sampleRate = () => {
  const parsed = Number(process.env.CSP_REPORT_SAMPLE_RATE);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : 0.25;
};

const noContent = () =>
  new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });

const allowReportFromIp = (ip: string, now = Date.now()) => {
  const minute = Math.floor(now / 60_000);
  const limit = positiveInteger(process.env.CSP_REPORTS_PER_IP_PER_MINUTE, 20);
  const current = reportBuckets.get(ip);

  if (!current && reportBuckets.size >= MAX_IP_BUCKETS) {
    for (const [key, bucket] of reportBuckets) {
      if (now - bucket.lastSeen > BUCKET_RETENTION_MS) {
        reportBuckets.delete(key);
      }
    }
    if (reportBuckets.size >= MAX_IP_BUCKETS) return false;
  }

  if (!current || current.minute !== minute) {
    reportBuckets.set(ip, { minute, count: 1, lastSeen: now });
    return true;
  }

  current.lastSeen = now;
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
};

const removeControlCharacters = (value: unknown, maxLength: number) =>
  String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, maxLength);

const sanitizeReportedUrl = (value: unknown) => {
  const raw = removeControlCharacters(value, 2_048).trim();
  if (!raw) return "";

  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && !["http", "https"].includes(scheme)) {
    return `${scheme}:`;
  }

  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return raw.split(/[?#]/, 1)[0].slice(0, 500);
  }
};

const shouldSample = () => {
  const rate = sampleRate();
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return randomInt(0, 1_000_000) < rate * 1_000_000;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const extractCspReports = (value: unknown) => {
  const payloads = Array.isArray(value) ? value.slice(0, 10) : [value];
  return payloads.flatMap((payload) => {
    const record = asRecord(payload);
    if (!record) return [];

    const legacyReport = asRecord(record["csp-report"]);
    if (legacyReport) return [legacyReport];

    // Reporting API requests wrap CSPViolationReportBody in `body` and can
    // batch several reports in one JSON array.
    const reportingApiBody = asRecord(record.body);
    if (reportingApiBody) return [reportingApiBody];

    return [record];
  });
};

export async function POST(req: Request) {
  const clientIp = getTrustedClientIp(req);
  if (!allowReportFromIp(clientIp)) return noContent();

  const declaredLength = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REPORT_BYTES
  ) {
    return new Response(null, { status: 413 });
  }
  if (!req.body) return new Response(null, { status: 204 });

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REPORT_BYTES) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    const reports = extractCspReports(JSON.parse(text));
    if (!shouldSample()) return noContent();

    for (const report of reports) {
      const normalized = {
        documentUri: sanitizeReportedUrl(
          report["document-uri"] || report.documentURL || ""
        ),
        violatedDirective: removeControlCharacters(
          report["violated-directive"] || report.effectiveDirective || "",
          120
        ),
        blockedUri: sanitizeReportedUrl(
          report["blocked-uri"] || report.blockedURL || ""
        ),
        disposition: removeControlCharacters(report.disposition, 30),
      };
      if (!Object.values(normalized).some(Boolean)) continue;
      console.warn("CSP violation", normalized);
    }
  } catch {
    return new Response(null, { status: 400 });
  }

  return noContent();
}
