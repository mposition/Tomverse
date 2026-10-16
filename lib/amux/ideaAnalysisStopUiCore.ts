export type AmuxAnalysisStopReceipt = {
  holdId: string; previewId: string; ideaId: string; auditId: string;
};

const ID = /^[A-Za-z0-9:_-]{1,128}$/;

export function parseAmuxAnalysisStopReceipt(status: number, value: unknown,
  expected: { holdId: string; previewId: string; ideaId: string },
  readback = false): AmuxAnalysisStopReceipt | null {
  if (status !== (readback ? 200 : 201) || !value ||
      typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (readback && row.status !== "committed") return null;
  if (row.holdId !== expected.holdId || row.previewId !== expected.previewId ||
      row.ideaId !== expected.ideaId || typeof row.auditId !== "string" ||
      !ID.test(row.auditId)) return null;
  return { holdId: expected.holdId, previewId: expected.previewId,
    ideaId: expected.ideaId, auditId: row.auditId };
}

export function amuxAnalysisStopRequestKey(holdId: string): string {
  if (!ID.test(holdId)) throw new TypeError("invalid hold ID");
  return `amux-v19-analysis-stop:${holdId}`;
}

export function isAmuxAnalysisStopRequestId(value: string | null): value is string {
  return value !== null && ID.test(value);
}
