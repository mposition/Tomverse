import "server-only";

import { timingSafeEqual } from "node:crypto";

import { DM_DIGEST_KEY_BYTES, isDmKeyPeriod } from "@/lib/amux/decisionMakerBodyCore";

/**
 * The AMUX Decision Maker's digest keys (docs/policy/amux-decision-maker.md
 * §10: "키는 30일 단위로 바꾸고 서버 비밀 저장소에만 두며 로그에 남기지
 * 않는다"), stage S1d.
 *
 * The keys live in one server secret, `AMUX_DM_DIGEST_KEYS`: comma-separated
 * `<key period>:<base64 of 32 random bytes>` entries, one per 30-day key
 * period still in use (lib/amux/decisionMakerBodyCore.ts derives a request's
 * period from its database-clock `createdAt`). They are never written to the
 * database -- the registry (`AmuxDecisionMakerDigestKeyEvent`) keeps only a
 * key check value -- nor to a log, an audit entry, a response or an error.
 * Errors here name what is wrong, never a value.
 *
 * Rotation is an operator's provisioning step plus a recorded event: add the
 * next period's key to the secret, then record its rotation through
 * `rotateDecisionMakerDigestKey()`. Destruction is the reverse: record it
 * through `destroyDecisionMakerDigestKey()` -- which the database refuses
 * while any body of the period remains, a hold is open on one of its
 * requests, or one of its requests is still open -- and then remove the entry
 * from the secret. A period whose destruction is recorded is refused for every
 * body write even while its entry is still present.
 */

export const DM_DIGEST_KEYS_ENV = "AMUX_DM_DIGEST_KEYS";

export type DmDigestKeyRing = ReadonlyMap<number, Buffer>;

export class DecisionMakerDigestKeyError extends Error {
  readonly code: "not_configured" | "malformed";

  constructor(code: DecisionMakerDigestKeyError["code"]) {
    super(`AMUX Decision Maker digest keys ${code === "not_configured" ? "are not configured" : "are malformed"}`);
    this.name = "DecisionMakerDigestKeyError";
    this.code = code;
  }
}

const ENTRY = /^(0|[1-9][0-9]{0,9}):((?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=)$/;

/**
 * The key ring from the secret's value. Every entry is a distinct period and
 * a distinct canonical 32-byte key; anything else refuses the whole ring,
 * since a half-read ring would digest some requests with no key at all.
 */
export const parseDecisionMakerDigestKeyRing = (value: string | undefined): DmDigestKeyRing => {
  if (typeof value !== "string" || value.trim() === "") throw new DecisionMakerDigestKeyError("not_configured");
  const ring = new Map<number, Buffer>();
  for (const raw of value.split(",")) {
    const match = ENTRY.exec(raw.trim());
    if (!match) throw new DecisionMakerDigestKeyError("malformed");
    const period = Number(match[1]);
    const key = Buffer.from(match[2], "base64");
    if (!isDmKeyPeriod(period) || key.length !== DM_DIGEST_KEY_BYTES || key.toString("base64") !== match[2]) {
      throw new DecisionMakerDigestKeyError("malformed");
    }
    if (ring.has(period) || [...ring.values()].some((other) => timingSafeEqual(other, key))) {
      throw new DecisionMakerDigestKeyError("malformed");
    }
    ring.set(period, key);
  }
  return ring;
};

export const loadDecisionMakerDigestKeyRing = (
  env: Record<string, string | undefined> = process.env,
): DmDigestKeyRing => parseDecisionMakerDigestKeyRing(env[DM_DIGEST_KEYS_ENV]);

/** The period's key, or null when the ring does not hold it. */
export const decisionMakerPeriodKey = (ring: DmDigestKeyRing, period: number): Buffer | null => {
  if (!isDmKeyPeriod(period)) return null;
  const key = ring.get(period);
  return key !== undefined && key.length === DM_DIGEST_KEY_BYTES ? key : null;
};
