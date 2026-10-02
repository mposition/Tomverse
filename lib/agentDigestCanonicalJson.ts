/**
 * The canonical bytes of an agent digest payload.
 *
 * The shared `AgentDigestItem` contract (five agent teams) fixes how a payload
 * becomes bytes so that every team computes the same `sizeBytes` and
 * `payloadSha256` for the same value. The rules are RFC 8785 (JSON
 * Canonicalization Scheme) restricted to the contract's input domain:
 *
 * - object keys sorted by UTF-16 code unit, not by code point or locale;
 * - no Unicode normalization: keys that differ only in NFC/NFD stay distinct;
 * - strings serialized as ECMAScript `JSON.stringify` does, which is what
 *   RFC 8785 specifies -- but a lone surrogate is an error, never replaced;
 * - numbers must be safe integers (the contract admits no fractions and no
 *   integer beyond 2^53, which IEEE-754 cannot hold exactly);
 * - no `undefined`, functions, symbols, bigints, dates or other non-JSON values.
 *
 * The bytes are computed once, from the value the store received, before it
 * is written. The `payload` column is `jsonb`, which normalises in its own
 * way, so a value read back from the database is never re-hashed.
 */
import { createHash } from "node:crypto";

export class AgentDigestCanonicalJsonError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "AgentDigestCanonicalJsonError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new AgentDigestCanonicalJsonError("lone_surrogate");
  return JSON.stringify(value);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, depth: number): string {
  if (depth > 64) throw new AgentDigestCanonicalJsonError("too_deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new AgentDigestCanonicalJsonError("number_not_safe_integer");
      // -0 serializes as 0, which is what RFC 8785 requires.
      return String(value === 0 ? 0 : value);
    case "string":
      return serializeString(value);
    case "object": {
      if (Array.isArray(value)) {
        // An index loop, not map(): map() skips the holes of a sparse array, which
        // would let Array(1) hash like [] and Array(2) print the invalid "[,]".
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new AgentDigestCanonicalJsonError("sparse_array");
          }
          items.push(serialize(value[index], depth + 1));
        }
        return `[${items.join(",")}]`;
      }
      if (!isPlainObject(value)) throw new AgentDigestCanonicalJsonError("not_plain_object");
      const record = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units -- exactly the order RFC 8785 asks for.
      const keys = Object.keys(record).sort();
      return `{${keys
        .map((key) => {
          if (record[key] === undefined) throw new AgentDigestCanonicalJsonError("undefined_value");
          return `${serializeString(key)}:${serialize(record[key], depth + 1)}`;
        })
        .join(",")}}`;
    }
    default:
      throw new AgentDigestCanonicalJsonError(`unsupported_${typeof value}`);
  }
}

/** The canonical JSON text of `value`, or a thrown `AgentDigestCanonicalJsonError`. */
export function agentDigestCanonicalJson(value: unknown): string {
  return serialize(value, 0);
}

export type AgentDigestCanonicalBytes = {
  bytes: Uint8Array;
  sizeBytes: number;
  payloadSha256: string;
};

/** UTF-8 bytes of the canonical text, their length and their lowercase SHA-256. */
export function agentDigestCanonicalBytes(value: unknown): AgentDigestCanonicalBytes {
  const bytes = new TextEncoder().encode(agentDigestCanonicalJson(value));
  return {
    bytes,
    sizeBytes: bytes.length,
    payloadSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
