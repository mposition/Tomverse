const MAX_REPORT_BYTES = 16 * 1024;

export async function POST(req: Request) {
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
    const payload = JSON.parse(text) as Record<string, unknown>;
    const report =
      payload["csp-report"] && typeof payload["csp-report"] === "object"
        ? (payload["csp-report"] as Record<string, unknown>)
        : payload;
    console.warn("CSP violation", {
      documentUri: String(
        report["document-uri"] || report.documentURL || ""
      ).slice(0, 500),
      violatedDirective: String(
        report["violated-directive"] || report.effectiveDirective || ""
      ).slice(0, 120),
      blockedUri: String(
        report["blocked-uri"] || report.blockedURL || ""
      ).slice(0, 500),
      disposition: String(report.disposition || "").slice(0, 30),
    });
  } catch {
    return new Response(null, { status: 400 });
  }

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
