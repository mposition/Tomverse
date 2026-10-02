/** Descending, owner-scoped picker position; never an authorization token. */
export type AmuxV4RecentIdeaCursor = { submittedAt: Date; ideaId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export function encodeAmuxV4RecentIdeaCursor(cursor: AmuxV4RecentIdeaCursor): string {
  if (!(cursor.submittedAt instanceof Date) || !Number.isFinite(cursor.submittedAt.getTime()) ||
      !UUID.test(cursor.ideaId)) throw new TypeError("invalid AMUX recent idea cursor");
  return Buffer.from(JSON.stringify([cursor.submittedAt.toISOString(), cursor.ideaId]), "utf8")
    .toString("base64url");
}

export function parseAmuxV4RecentIdeaCursor(raw: unknown): AmuxV4RecentIdeaCursor | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        typeof decoded[0] !== "string" || !UTC_ISO.test(decoded[0]) ||
        typeof decoded[1] !== "string" || !UUID.test(decoded[1])) return null;
    const submittedAt = new Date(decoded[0]);
    if (!Number.isFinite(submittedAt.getTime()) || submittedAt.toISOString() !== decoded[0]) return null;
    const cursor = { submittedAt, ideaId: decoded[1] };
    return encodeAmuxV4RecentIdeaCursor(cursor) === raw ? cursor : null;
  } catch { return null; }
}
