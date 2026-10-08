/** Ascending candidate position. This is pagination, never an approval token. */
export type AmuxV4AnalysisQueueCursor = { confirmedAt: Date; previewId: string };

const PREVIEW_ID = /^[A-Za-z0-9:_-]{1,100}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseAmuxV4AnalysisQueueCursor(raw: unknown): AmuxV4AnalysisQueueCursor | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        typeof decoded[0] !== "string" || !UTC_ISO.test(decoded[0]) ||
        typeof decoded[1] !== "string" || !PREVIEW_ID.test(decoded[1])) return null;
    const confirmedAt = new Date(decoded[0]);
    return Number.isFinite(confirmedAt.getTime()) &&
      confirmedAt.toISOString() === decoded[0]
      ? { confirmedAt, previewId: decoded[1] } : null;
  } catch { return null; }
}

export function encodeAmuxV4AnalysisQueueCursor(value: AmuxV4AnalysisQueueCursor): string {
  if (!(value.confirmedAt instanceof Date) ||
      !Number.isFinite(value.confirmedAt.getTime()) ||
      !PREVIEW_ID.test(value.previewId)) throw new TypeError("invalid AMUX analysis queue cursor");
  return Buffer.from(JSON.stringify([value.confirmedAt.toISOString(), value.previewId]), "utf8")
    .toString("base64url");
}
