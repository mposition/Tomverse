/**
 * How the attachment audit decides things, without a database or a bucket.
 *
 * Split out so the parts that are easy to get wrong -- the classification, the
 * redaction, the resume cursor, the bounded worker pool -- can be tested with
 * plain values, and so the script beside it is only wiring.
 *
 * The rule this file exists to keep: **a report about missing files must not
 * itself be a leak.** An audit that named object keys, filenames or message
 * content would be the most sensitive artefact this repository produces, and
 * it would be produced routinely and pasted into tickets. So the row shape is
 * an allowlist and there is no option to widen it.
 */

/** The four answers an object probe can produce. Nothing collapses to two. */
export const ATTACHMENT_AUDIT_STATES = Object.freeze([
  /** Storage holds it and the metadata matches the row. */
  "available",
  /** Storage answered 404. Confirmed loss. */
  "missing",
  /**
   * Storage refused us or did not answer.
   *
   * Deliberately its own state rather than folded into `missing`: a rotated
   * key or a five-minute bucket outage would otherwise be reported as an
   * account having lost every file it owns, and that number would then be
   * pasted into an incident channel.
   */
  "temporarily_unreachable",
  /** It is there, and it is not what the row says it is. */
  "metadata_mismatch",
]);

/**
 * Turns one probe result into an audit state.
 *
 * `probe` is the shape `probeR2Object` returns. The size and content-type
 * comparison is done here rather than in the probe so this stays testable and
 * so the probe stays a probe -- nothing in this path deletes or rewrites
 * anything it disagrees with.
 */
export const classifyAttachmentProbe = (probe, row) => {
  if (probe.state === "missing") return "missing";
  if (probe.state !== "present") return "temporarily_unreachable";
  const sizeKnown = typeof probe.size === "number" && probe.size > 0;
  if (sizeKnown && typeof row.size === "number" && row.size > 0 && probe.size !== row.size) {
    return "metadata_mismatch";
  }
  const expected = (row.mediaType || "").split(";", 1)[0].trim().toLowerCase();
  const actual = (probe.contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (expected && actual && expected !== actual) return "metadata_mismatch";
  return "available";
};

/**
 * The only fields an audit row may carry.
 *
 * Field by field, never a spread of the database row: the row has
 * `objectKey`, and a spread is how it would reach a file somebody attaches to
 * a ticket. The user's own filename is absent for the same reason -- a
 * filename is frequently the most identifying thing about a document.
 */
export const auditRow = (row, state, probe) => ({
  attachmentId: row.id,
  conversationId: row.conversationId,
  createdAt:
    row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  mediaType: row.mediaType,
  declaredSize: row.size,
  state,
  storageStatus: probe?.storageStatus ?? null,
  alreadyMarkedUnavailable: Boolean(row.unavailableAt),
});

/**
 * A cursor that survives an interrupted run.
 *
 * `(createdAt, id)` rather than an offset: rows are inserted while the audit
 * runs, and an offset silently skips or repeats under insertion. The id breaks
 * ties so two rows written in the same millisecond cannot make the cursor
 * stall on itself.
 */
export const encodeAuditCursor = (row) =>
  row
    ? `${(row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).toISOString()}|${row.id}`
    : null;

export const decodeAuditCursor = (value) => {
  if (typeof value !== "string" || !value.includes("|")) return null;
  const [iso, id] = value.split("|");
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
};

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Low by default at the call site, because this is pointed at production
 * storage: an audit that saturates the bucket's request budget degrades the
 * product it is auditing, and there is no deadline on knowing the answer.
 */
export const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
};

/**
 * Retries a probe that could not reach storage, with exponential backoff.
 *
 * Only `temporarily_unreachable` is retried, and that is the point: retrying a
 * 404 cannot change it, and retrying it anyway would multiply the request cost
 * of exactly the case the audit exists to count.
 */
export const probeWithRetry = async (probe, { attempts = 3, baseDelayMs = 250, sleep } = {}) => {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = { state: "unreachable", size: null, contentType: null, storageStatus: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await probe();
    if (last.state !== "unreachable") return last;
    if (attempt < attempts - 1) await wait(baseDelayMs * 2 ** attempt);
  }
  return last;
};

/** Empty counters, so a run that examined nothing still reports every state. */
export const emptyAuditSummary = () => ({
  totalRows: null,
  examined: 0,
  available: 0,
  missing: 0,
  temporarily_unreachable: 0,
  metadata_mismatch: 0,
  alreadyMarkedUnavailable: 0,
  markedThisRun: 0,
});

/**
 * The closing lines of a run.
 *
 * `unchecked` is stated rather than left to arithmetic, because a partial run
 * that reports only what it found reads as a complete one. A number nobody
 * computed is the difference between "12 files are missing" and "12 files are
 * missing out of the 400 we got to, of 51,000".
 */
export const describeAuditSummary = (summary) => {
  const unchecked =
    typeof summary.totalRows === "number"
      ? Math.max(0, summary.totalRows - summary.examined)
      : null;
  return [
    `Rows in scope:        ${summary.totalRows ?? "unknown"}`,
    `Rows examined:        ${summary.examined}`,
    `  available:          ${summary.available}`,
    `  missing:            ${summary.missing}`,
    `  unreachable:        ${summary.temporarily_unreachable}`,
    `  metadata mismatch:  ${summary.metadata_mismatch}`,
    `Already marked:       ${summary.alreadyMarkedUnavailable}`,
    `Marked this run:      ${summary.markedThisRun}`,
    `Not examined:         ${unchecked ?? "unknown"}`,
  ];
};
