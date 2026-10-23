/** Stable reservation pagination position; never an execution authorization. */
export type AmuxSessionAnalysisQueueCursor = { createdAt: Date; reservationId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseAmuxSessionAnalysisQueueCursor(raw: unknown):
  AmuxSessionAnalysisQueueCursor | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 ||
        typeof value[0] !== "string" || !UTC_ISO.test(value[0]) ||
        typeof value[1] !== "string" || !UUID.test(value[1])) return null;
    const createdAt = new Date(value[0]);
    return Number.isFinite(createdAt.getTime()) && createdAt.toISOString() === value[0]
      ? { createdAt, reservationId: value[1] } : null;
  } catch { return null; }
}

export function encodeAmuxSessionAnalysisQueueCursor(
  value: AmuxSessionAnalysisQueueCursor,
): string {
  if (!(value.createdAt instanceof Date) || !Number.isFinite(value.createdAt.getTime()) ||
      !UUID.test(value.reservationId)) {
    throw new TypeError("invalid AMUX session analysis queue cursor");
  }
  return Buffer.from(JSON.stringify([value.createdAt.toISOString(), value.reservationId]), "utf8")
    .toString("base64url");
}
