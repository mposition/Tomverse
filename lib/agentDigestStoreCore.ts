/**
 * What the AgentDigestItem writer checks before it opens a transaction.
 *
 * The shared contract (team 3 sre-ops design, contracts 1-9) admits a row only
 * when its agent and kind are listed, its idempotency key carries the agent's
 * prefix, its payload has canonical bytes within 16 KiB, and no string in it
 * looks like a credential. The database repeats every check it can express
 * (migration 20261003000000_agent_digest_item); the secret scan and the
 * canonical bytes exist only here.
 *
 * A refusal carries a reason code and, for a secret, the matching rule ids --
 * never the matched text, because a secret written into a record about a
 * secret is still a leaked secret.
 *
 * Pure: no database, no clock, no environment.
 */

import {
  agentDigestCanonicalBytes,
  agentDigestCanonicalJson,
  AgentDigestCanonicalJsonError,
} from "./agentDigestCanonicalJson.ts";
import {
  AGENT_DIGEST_AGENT_KEYS,
  AGENT_DIGEST_KINDS,
  AGENT_DIGEST_MAX_PAYLOAD_BYTES,
  type AgentDigestAgentKey,
} from "./agentDigestContract.ts";
import { detectSecrets, type SecretRuleId } from "./engineeringAgentSecretPatterns.ts";

/**
 * The digest-submission transaction's limits (docs/policy/qa-release-agent.md
 * section 10, "timeout"). The database enforces the statement and idle limits
 * and re-arms them for every statement and idle gap; the transaction maximum
 * is the application value 3A + 5 seconds for A statements; Prisma's own
 * timeout is five seconds longer, never its 5-second default.
 */
export const AGENT_DIGEST_STORE_TIMEOUTS = Object.freeze({
  statementMs: 2_000,
  idleMs: 1_000,
  statements: 9,
  transactionMs: (3 * 9 + 5) * 1_000,
  prismaMs: (3 * 9 + 5) * 1_000 + 5_000,
});

/** Same limit as AgentDigestItem_idempotency_length_check. */
export const AGENT_DIGEST_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/** The part after "<agentKey>:" -- printable ASCII without spaces. */
const IDEMPOTENCY_SUFFIX = /^[\x21-\x7e]+$/;

export type AgentDigestSubmission = {
  agentKey: string;
  kind: string;
  schemaVersion: number;
  idempotencyKey: string;
  payload: unknown;
};

export type AgentDigestPreparedRow = {
  agentKey: AgentDigestAgentKey;
  kind: string;
  schemaVersion: number;
  idempotencyKey: string;
  payload: unknown;
  payloadSha256: string;
  sizeBytes: number;
};

export type AgentDigestRefusal =
  | "unknown_agent"
  | "unknown_kind"
  | "schema_version_out_of_range"
  | "idempotency_key_invalid"
  | "payload_not_canonical"
  | "payload_too_large"
  | "payload_contains_secret";

export type AgentDigestPreparation =
  | { ok: true; row: AgentDigestPreparedRow }
  | { ok: false; reason: AgentDigestRefusal; secretRuleIds?: SecretRuleId[] };

const isAgentKey = (value: string): value is AgentDigestAgentKey =>
  (AGENT_DIGEST_AGENT_KEYS as readonly string[]).includes(value);

/**
 * The texts the secret scan reads. Raw keys and string leaves, because the
 * escaped JSON text can split a pattern at an escape; and each key joined to
 * its scalar value, because the assignment rules ("API_TOKEN=...") need the
 * name and the value together and neither matches alone.
 */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      if (typeof item === "string" || typeof item === "number") into.push(`${key}=${item}`);
      collectStrings(item, into);
    }
  }
}

function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNul);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, item]) => key.includes("\u0000") || containsNul(item));
  }
  return false;
}

export function prepareAgentDigestItem(input: AgentDigestSubmission): AgentDigestPreparation {
  if (!isAgentKey(input.agentKey)) return { ok: false, reason: "unknown_agent" };
  if (!AGENT_DIGEST_KINDS[input.agentKey].includes(input.kind)) return { ok: false, reason: "unknown_kind" };
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1 || input.schemaVersion > 1000) {
    return { ok: false, reason: "schema_version_out_of_range" };
  }
  const prefix = `${input.agentKey}:`;
  const key = input.idempotencyKey;
  if (
    typeof key !== "string" ||
    key.length > AGENT_DIGEST_IDEMPOTENCY_KEY_MAX_LENGTH ||
    !key.startsWith(prefix) ||
    !IDEMPOTENCY_SUFFIX.test(key.slice(prefix.length))
  ) {
    return { ok: false, reason: "idempotency_key_invalid" };
  }

  // A digest body is a JSON object. A top-level null in particular would
  // reach the column as SQL NULL, which the insert trigger refuses.
  if (input.payload === null || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    return { ok: false, reason: "payload_not_canonical" };
  }

  // Everything below works on an independent snapshot parsed from the
  // canonical text, never on the caller's object: the caller cannot change
  // what was hashed, sized and scanned while the write is still pending.
  let payload: unknown;
  let bytes: { sizeBytes: number; payloadSha256: string };
  try {
    payload = JSON.parse(agentDigestCanonicalJson(input.payload));
    bytes = agentDigestCanonicalBytes(payload);
  } catch (error) {
    if (error instanceof AgentDigestCanonicalJsonError) return { ok: false, reason: "payload_not_canonical" };
    throw error;
  }
  // PostgreSQL jsonb cannot hold U+0000, so a body or key containing it is
  // refused here instead of failing inside the transaction.
  if (containsNul(payload)) return { ok: false, reason: "payload_not_canonical" };
  // The DB also refuses an empty body; a canonical value is never zero bytes.
  if (bytes.sizeBytes > AGENT_DIGEST_MAX_PAYLOAD_BYTES) return { ok: false, reason: "payload_too_large" };

  // The idempotency key is stored and copied into the audit chain, which
  // nothing ever expires, so it is scanned like the body.
  const strings: string[] = [key];
  collectStrings(payload, strings);
  const found = new Set<SecretRuleId>();
  for (const text of strings) for (const id of detectSecrets(text)) found.add(id);
  if (found.size > 0) return { ok: false, reason: "payload_contains_secret", secretRuleIds: [...found].sort() };

  return {
    ok: true,
    row: {
      agentKey: input.agentKey,
      kind: input.kind,
      schemaVersion: input.schemaVersion,
      idempotencyKey: key,
      payload,
      payloadSha256: bytes.payloadSha256,
      sizeBytes: bytes.sizeBytes,
    },
  };
}

export type AgentDigestExisting = { payloadSha256: string; kind: string; schemaVersion: number };

/**
 * A second submission under the same key: the same bytes are a replay, which
 * answers success without a second row or audit entry; anything else is a
 * conflict and nothing is written.
 */
export function classifyAgentDigestRepeat(
  existing: AgentDigestExisting,
  row: Pick<AgentDigestPreparedRow, "payloadSha256" | "kind" | "schemaVersion">,
): "replayed" | "conflict" {
  return existing.payloadSha256 === row.payloadSha256 &&
    existing.kind === row.kind &&
    existing.schemaVersion === row.schemaVersion
    ? "replayed"
    : "conflict";
}
