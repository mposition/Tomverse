import { randomInt } from "node:crypto";
import { after } from "next/server";
import { getAnonymousClientKey } from "@/lib/clientIp";
import {
  cspSourcePosition,
  isBrowserExtensionCspSource,
  isTrustedCspDocumentUri,
  sanitizeCspReportedUrl,
} from "@/lib/cspReportCore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

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
  const clientIp = getAnonymousClientKey(req);
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
      const rawDocumentUri =
        report["document-uri"] || report.documentURL || "";
      if (!isTrustedCspDocumentUri(rawDocumentUri)) continue;

      const normalized = {
        documentUri: sanitizeCspReportedUrl(rawDocumentUri),
        violatedDirective: removeControlCharacters(
          report["violated-directive"] || report.effectiveDirective || "",
          120
        ),
        blockedUri: sanitizeCspReportedUrl(
          report["blocked-uri"] || report.blockedURL || ""
        ),
        // Without this the recurring `script-src blocked eval` report on
        // /chat was unactionable: the page it happened on says nothing about
        // whether our own bundle, an allowed third-party tag, or a browser
        // extension called eval. `sanitizeCspReportedUrl` reduces a
        // non-http(s) source to its bare scheme, so an extension shows up as
        // `chrome-extension:` without recording which extension it was.
        sourceFile: sanitizeCspReportedUrl(
          report["source-file"] || report.sourceFile || ""
        ),
        sourcePosition: cspSourcePosition(report),
        disposition: removeControlCharacters(report.disposition, 30),
      };
      if (!Object.values(normalized).some(Boolean)) continue;

      // An extension injecting `eval` into a user's own browser is not an
      // incident about this deployment, and it arrives steadily: two issues,
      // 56 events in two weeks, still firing. Filed as operational incidents
      // they sit in the same stream as real problems and train the stream to
      // be ignored -- the same failure staging's permanently-red readiness
      // had. Counted here instead, so the volume stays visible without
      // claiming something is wrong with the app.
      //
      // Only extension schemes are treated this way. `data:` and `blob:` are
      // also non-http(s) and are what injected script looks like, so they keep
      // reporting, and so does a violation with no source at all.
      if (isBrowserExtensionCspSource(normalized.sourceFile)) {
        console.info(
          JSON.stringify({
            event: "csp_violation_from_browser_extension",
            documentUri: normalized.documentUri,
            violatedDirective: normalized.violatedDirective,
            blockedUri: normalized.blockedUri,
            sourceFile: normalized.sourceFile,
          })
        );
        continue;
      }

      after(() =>
        reportOperationalIncident({
          code: "CSP_VIOLATION_DETECTED",
          title: "Content Security Policy violation detected",
          // The source is in the summary, not only in the context. Both of
          // today's issues read "script-src blocked eval" and nothing else,
          // so the one fact that decides whether anyone should act -- whose
          // code called eval -- was invisible until someone opened an event.
          error: `${normalized.violatedDirective || "unknown directive"} blocked ${normalized.blockedUri || "unknown resource"} from ${normalized.sourceFile || "an unreported source"}`,
          severity: "warning",
          cooldownMs: 15 * 60 * 1_000,
          context: {
            component: "csp-report",
            documentUri: normalized.documentUri,
            violatedDirective: normalized.violatedDirective,
            blockedUri: normalized.blockedUri,
            sourceFile: normalized.sourceFile,
            sourcePosition: normalized.sourcePosition,
            disposition: normalized.disposition,
          },
        })
      );
    }
  } catch {
    return new Response(null, { status: 400 });
  }

  return noContent();
}
