/**
 * Does any bucket lifecycle rule delete objects the database still references?
 *
 * Written after a production incident in which a signed-in user's attachment
 * was removed from R2 about a day after it was uploaded, while the
 * `MessageAttachment` row that named it stayed. Every later turn in that
 * conversation re-read the file, got `NotFound`, and the error surfaced as an
 * AI provider outage. No application code deleted it: there was no cleanup
 * tombstone, and the upload's `boundAt` was intact. A time-based rule on the
 * bucket did.
 *
 * The rule that has to hold, and that this file decides:
 *
 *   **No enabled expiration rule may cover a prefix whose objects a database
 *   row points at.**
 *
 * Only the guest attachment prefix is expiry-eligible, because guest objects
 * are ephemeral by contract and no durable row names them.
 *
 * Pure and dependency-free so it can be unit tested with hand-written
 * configurations. The script beside it fetches the live configuration and
 * hands it here; nothing in this file talks to a network, and nothing in it
 * prints a key, a bucket name or a credential.
 */

/**
 * Prefixes whose objects a database row points at.
 *
 * Mirrors the constants in `lib/`, listed here rather than imported because
 * this file must stay loadable by a plain `node` process with no TypeScript
 * and no application bootstrap. `tests/r2LifecyclePolicy.test.mjs` asserts the
 * two lists agree, so drift is a failing test rather than a silent gap.
 */
export const PROTECTED_OBJECT_PREFIXES = Object.freeze([
  // lib/messageAttachmentStorage.ts -- files a signed-in user sent. Kept until
  // the conversation or the account is deleted.
  "attachments/",
  // lib/generatedArtifactStorage.ts -- files an answer produced.
  "message-artifacts/",
  // lib/imageGenerationStateCore.ts -- generated images the user paid for.
  "images/",
  // lib/assistantKnowledgeLimits.ts -- assistant profile knowledge chunks.
  "assistant-knowledge/",
]);

/**
 * Prefixes whose objects are ephemeral by contract.
 *
 * A rule here is allowed but not required: the guest sweep is application code
 * (`listExpiredR2Objects`), and a bucket rule beside it is belt and braces.
 */
export const EPHEMERAL_OBJECT_PREFIXES = Object.freeze(["guest-attachments/"]);

/**
 * Whether a lifecycle rule's prefix covers objects under a protected prefix.
 *
 * Two directions, and both matter:
 *
 *  - The rule's prefix is a *parent* of the protected one (`""`, `"a"`,
 *    `"attach"`): every protected object is inside it. The empty prefix is the
 *    case that caused the incident and the one a substring test would miss,
 *    because `"".includes(...)` is false in the direction people write it.
 *  - The rule's prefix is *inside* the protected one
 *    (`"attachments/9f2c/"`): only some protected objects, which is still
 *    protected objects.
 *
 * Prefix matching is on characters, exactly as S3 does it -- not on path
 * segments. `attach` really does select `attachments/...` in a bucket, so a
 * segment-aware comparison would report safe where the bucket is not.
 */
export const prefixesOverlap = (rulePrefix, protectedPrefix) => {
  const rule = rulePrefix ?? "";
  if (rule === "") return true;
  return rule.startsWith(protectedPrefix) || protectedPrefix.startsWith(rule);
};

const asArray = (value) =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

/**
 * The prefixes one rule selects.
 *
 * S3 has three spellings for the same idea across API versions -- a top-level
 * `Prefix`, `Filter.Prefix`, and `Filter.And.Prefix` -- and a rule with none of
 * them selects the whole bucket. That last case is the dangerous default: a
 * rule written to expire "old uploads" with the prefix left out expires
 * everything, and reports nothing while doing it.
 */
export const rulePrefixes = (rule) => {
  const found = [];
  if (typeof rule?.Prefix === "string") found.push(rule.Prefix);
  if (typeof rule?.Filter?.Prefix === "string") found.push(rule.Filter.Prefix);
  if (typeof rule?.Filter?.And?.Prefix === "string") {
    found.push(rule.Filter.And.Prefix);
  }
  for (const inner of asArray(rule?.Filter?.And?.Filters)) {
    if (typeof inner?.Prefix === "string") found.push(inner.Prefix);
  }
  return found.length > 0 ? found : [""];
};

/** Whether a rule deletes anything at all (as opposed to aborting uploads). */
export const ruleDeletesObjects = (rule) =>
  Boolean(
    rule?.Expiration?.Days !== undefined ||
      rule?.Expiration?.Date !== undefined ||
      rule?.Expiration?.ExpiredObjectDeleteMarker === true ||
      rule?.NoncurrentVersionExpiration !== undefined
  );

/**
 * Reads a lifecycle configuration and reports what it would delete.
 *
 * Fail-closed in both directions a check like this can fail open:
 *
 *  - A rule whose prefix cannot be read at all is treated as covering the
 *    whole bucket, because that is what S3 does with it.
 *  - `AbortIncompleteMultipartUpload`-only rules are reported as safe, because
 *    they delete no completed object -- that is the one exemption, and it is
 *    narrow enough to state.
 *
 * Returns findings rather than throwing, so a caller can print all of them.
 */
export const auditLifecycleConfiguration = (configuration) => {
  const rules = asArray(configuration?.Rules);
  const violations = [];
  const allowed = [];
  for (const rule of rules) {
    const id = typeof rule?.ID === "string" ? rule.ID : "(unnamed rule)";
    const enabled = rule?.Status === "Enabled";
    if (!enabled) continue;
    if (!ruleDeletesObjects(rule)) continue;
    const prefixes = rulePrefixes(rule);
    const hits = [];
    for (const prefix of prefixes) {
      for (const protectedPrefix of PROTECTED_OBJECT_PREFIXES) {
        if (prefixesOverlap(prefix, protectedPrefix)) {
          hits.push({ rulePrefix: prefix, protectedPrefix });
        }
      }
    }
    if (hits.length > 0) {
      violations.push({
        id,
        // The whole-bucket case is called out by name: it is the one an
        // operator reads as "there is no prefix here, so it must be scoped
        // somehow", and it is the opposite.
        wholeBucket: prefixes.some((prefix) => prefix === ""),
        overlaps: hits,
        expirationDays:
          typeof rule?.Expiration?.Days === "number" ? rule.Expiration.Days : null,
      });
    } else {
      allowed.push({ id, prefixes });
    }
  }
  return {
    ruleCount: rules.length,
    violations,
    allowed,
    ok: violations.length === 0,
  };
};

/**
 * One line per finding, for an operator.
 *
 * Rule ids and prefixes only. A prefix is a naming convention rather than a
 * secret -- and it is the whole content of the finding -- but no object key,
 * bucket name, endpoint or credential appears here or in the caller.
 */
export const describeLifecycleAudit = (audit) => {
  if (audit.ok) {
    return [
      `Lifecycle rules examined: ${audit.ruleCount}.`,
      "No enabled deletion rule covers a database-referenced prefix.",
    ];
  }
  const lines = [
    `Lifecycle rules examined: ${audit.ruleCount}.`,
    `Rules deleting database-referenced objects: ${audit.violations.length}.`,
  ];
  for (const violation of audit.violations) {
    lines.push(
      `  - ${violation.id}${violation.wholeBucket ? " [whole bucket: no prefix]" : ""}` +
        (violation.expirationDays !== null
          ? ` expires after ${violation.expirationDays}d`
          : "") +
        ` -> ${[
          ...new Set(violation.overlaps.map((hit) => hit.protectedPrefix)),
        ].join(", ")}`
    );
  }
  return lines;
};
