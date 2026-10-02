/** Opaque position in the owner's read-only, newest-first card listing. */
export type AmuxAdminCardCursor = { updatedAt: Date; id: string };

const CARD_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseAmuxAdminCardCursor(raw: unknown): AmuxAdminCardCursor | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 ||
        typeof value[0] !== "string" || !UTC_ISO.test(value[0]) ||
        typeof value[1] !== "string" || !CARD_ID.test(value[1])) return null;
    const updatedAt = new Date(value[0]);
    return Number.isFinite(updatedAt.getTime()) && updatedAt.toISOString() === value[0]
      ? { updatedAt, id: value[1] } : null;
  } catch { return null; }
}

export function encodeAmuxAdminCardCursor(row: AmuxAdminCardCursor): string {
  if (!(row.updatedAt instanceof Date) || !Number.isFinite(row.updatedAt.getTime()) ||
      !CARD_ID.test(row.id)) throw new TypeError("invalid AMUX card cursor");
  return Buffer.from(JSON.stringify([row.updatedAt.toISOString(), row.id]), "utf8")
    .toString("base64url");
}
