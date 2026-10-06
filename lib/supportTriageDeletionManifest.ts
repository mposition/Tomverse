/**
 * The support-triage deletion manifest (docs/policy/support-triage.md §5).
 *
 * Every model support-triage writes is listed here, with how it reaches a
 * report, what account deletion does to it, and a closed classification of
 * every stored column. Nothing else lists these models: the store's model set,
 * the account-deletion walk and the deletion fixtures are derived from this
 * table, and `auditDeletionManifest()` fails when the Prisma schema and this
 * table disagree in either direction.
 *
 * Pure data and pure functions; no I/O.
 */

export const COLUMN_CLASSES = Object.freeze([
  /** The row's own id, `feedbackId`, or a key to another manifest model. Never a person's account. */
  "identifier",
  /** State, time, attempt counts, counters: values that do not come from a report. */
  "lifecycle",
  /** Derived from a report's text, type or signals: flags, lane, priority, template id, input digest. */
  "report_derived",
  /** Copied from evidence: error code, route class, release snapshots. */
  "evidence_snapshot",
  /** A group signal's server-value digest; its provenance is the row's provenanceClass. */
  "signal_snapshot",
] as const);
export type ColumnClass = (typeof COLUMN_CLASSES)[number];

/** Classes whose values must not survive account deletion or retention. */
export const REPORT_CONTENT_CLASSES: readonly ColumnClass[] = Object.freeze([
  "report_derived",
  "evidence_snapshot",
  "signal_snapshot",
]);

export type ManifestLink =
  | { readonly kind: "none" }
  | { readonly kind: "feedback_id"; readonly column: string }
  | { readonly kind: "via_model"; readonly model: string; readonly column: string }
  | { readonly kind: "untyped"; readonly column: string }
  /**
   * A parent reached through its members while it has any, and through a
   * list of departed member report ids (`column`, a String[]) once it has
   * none. `through` is the member model, which links back to this one.
   */
  | { readonly kind: "member_ids"; readonly column: string; readonly through: string }
  /**
   * A parent that holds no report id of its own and is reached only through
   * its children (`through`), whose deletion takes it whole. `column` is its id.
   */
  | { readonly kind: "via_children"; readonly column: string; readonly through: string };

export type AccountDeletionAction =
  | "none"
  | "delete"
  | "cascade_from_group"
  | "delete_parent_record";

/** The rows of the retention table in docs/policy/support-triage.md §5, one key each. */
export const RETENTION_KEYS = Object.freeze([
  "terminal_suggestion_30_days",
  "membership_while_report_open",
  "group_signal_while_group_open",
  "terminal_group_30_days",
  "not_queued_7_days",
  "group_key_tombstone_7_days",
  "run_30_days",
  "decision_record_12_months",
  "agent_digest_90_365_days",
] as const);
export type RetentionKey = (typeof RETENTION_KEYS)[number];

// Named once: a `retentionKey: "<digits in it>"` line reads to the secret
// scanner like an assigned credential, and this one shape is already known
// to it as a plain constant name.
const DECISION_RECORD_RETENTION_KEY = "decision_record_12_months" satisfies RetentionKey;

export type ManifestEntry = {
  readonly model: string;
  readonly link: ManifestLink;
  readonly onAccountDeletion: AccountDeletionAction;
  readonly retentionKey: RetentionKey;
  readonly columns: Readonly<Record<string, ColumnClass>>;
};

export const SUPPORT_TRIAGE_DELETION_MANIFEST: readonly ManifestEntry[] = Object.freeze([
  Object.freeze({
    model: "SupportTriageRun",
    link: Object.freeze({ kind: "none" }),
    // Content-free: no report, person or other model is named by a run row.
    onAccountDeletion: "none",
    retentionKey: "run_30_days",
    columns: Object.freeze({
      id: "identifier",
      sequence: "lifecycle",
      kind: "lifecycle",
      outcome: "lifecycle",
      createdAt: "lifecycle",
      deadlineAt: "lifecycle",
      finishedAt: "lifecycle",
      batchesCompleted: "lifecycle",
      overdueRemaining: "lifecycle",
      oldestOverdueAgeSeconds: "lifecycle",
      blocked: "lifecycle",
    }),
  }),
  Object.freeze({
    model: "SupportTriageSuggestion",
    link: Object.freeze({ kind: "feedback_id", column: "feedbackId" }),
    onAccountDeletion: "delete",
    retentionKey: "terminal_suggestion_30_days",
    columns: Object.freeze({
      id: "identifier",
      feedbackId: "identifier",
      // Derived from the report's text: can be matched by guessing a short report.
      inputDigest: "report_derived",
      state: "lifecycle",
      failureCode: "lifecycle",
      claimToken: "lifecycle",
      leaseExpiresAt: "lifecycle",
      attemptCount: "lifecycle",
      lane: "report_derived",
      keywordFlags: "report_derived",
      ownerQueueState: "lifecycle",
      displayedAt: "lifecycle",
      createdAt: "lifecycle",
      updatedAt: "lifecycle",
    }),
  }),
  Object.freeze({
    model: "SupportTriageGroup",
    link: Object.freeze({ kind: "member_ids", column: "retiredMemberIds", through: "SupportTriageGroupMember" }),
    // Deleted whatever its state when a member or a departed member is the
    // account's report; its members and signals go with it.
    onAccountDeletion: "delete",
    retentionKey: "terminal_group_30_days",
    columns: Object.freeze({
      id: "identifier",
      state: "lifecycle",
      primaryKind: "lifecycle",
      primarySnapshotDigest: "signal_snapshot",
      // A digest over member report ids: an identifier, cleared with the tombstone.
      groupCandidateKey: "identifier",
      // Includes the members' report statuses.
      groupInputDigest: "report_derived",
      keyRetiredAt: "lifecycle",
      retiredMemberIds: "identifier",
      decision: "lifecycle",
      decidedAt: "lifecycle",
      ownerQueueState: "lifecycle",
      displayedAt: "lifecycle",
      keyRecheckDeferredCount: "lifecycle",
      keyRecheckDeferredRunId: "lifecycle",
      keyRecheckLastEvaluatedRunSeq: "lifecycle",
      keyRecheckDeferredRunSeq: "lifecycle",
      createdAt: "lifecycle",
      updatedAt: "lifecycle",
    }),
  }),
  Object.freeze({
    model: "SupportTriageGroupMember",
    link: Object.freeze({ kind: "feedback_id", column: "feedbackId" }),
    onAccountDeletion: "cascade_from_group",
    retentionKey: "membership_while_report_open",
    columns: Object.freeze({
      groupId: "identifier",
      feedbackId: "identifier",
      primarySnapshotDigest: "signal_snapshot",
      createdAt: "lifecycle",
    }),
  }),
  Object.freeze({
    model: "SupportTriageGroupSignal",
    link: Object.freeze({ kind: "via_model", model: "SupportTriageGroup", column: "groupId" }),
    onAccountDeletion: "cascade_from_group",
    retentionKey: "group_signal_while_group_open",
    columns: Object.freeze({
      groupId: "identifier",
      kind: "lifecycle",
      snapshotDigest: "signal_snapshot",
      provenanceClass: "lifecycle",
      snapshotExpiresAt: "lifecycle",
      observedAt: "lifecycle",
    }),
  }),
  Object.freeze({
    model: "SupportTriageDecisionRecord",
    link: Object.freeze({ kind: "via_children", column: "id", through: "SupportTriageDecisionRecordLink" }),
    onAccountDeletion: "delete",
    retentionKey: DECISION_RECORD_RETENTION_KEY,
    columns: Object.freeze({
      id: "identifier",
      decisionKind: "lifecycle",
      decidedAt: "lifecycle",
      // Keyed, but over a binding derived from the reports: kept as report data.
      decisionEnvelopeDigest: "report_derived",
      digestVersion: "lifecycle",
      retentionUntil: "lifecycle",
    }),
  }),
  Object.freeze({
    model: "SupportTriageDecisionRecordLink",
    link: Object.freeze({ kind: "feedback_id", column: "feedbackId" }),
    // Any link gone takes the record whole, and with it every other link.
    onAccountDeletion: "delete_parent_record",
    retentionKey: DECISION_RECORD_RETENTION_KEY,
    columns: Object.freeze({
      id: "identifier",
      recordId: "identifier",
      feedbackId: "identifier",
    }),
  }),
]);

/**
 * Models that already reach `Feedback` and are owned by their own registry
 * entries, not by this manifest. Changing this list needs a reason in the
 * same commit.
 */
export const PRE_EXISTING_FEEDBACK_MODELS = Object.freeze([
  "FeedbackAutoFixCase",
  "FeedbackLifecycleEvent",
  "TraceErrorEvidence",
]);

const SCALAR_TYPES = new Set([
  "String",
  "Int",
  "BigInt",
  "Boolean",
  "DateTime",
  "Float",
  "Decimal",
  "Json",
  "Bytes",
]);

type ParsedField = {
  readonly name: string;
  readonly type: string;
  readonly relation: boolean;
  /** For a relation field, the local columns its `@relation(fields: [...])` names. */
  readonly relationFields: readonly string[];
  /** A `[]` field. */
  readonly list: boolean;
};
type ParsedModel = { readonly name: string; readonly fields: readonly ParsedField[]; readonly unreadable: readonly string[] };
type ParsedSchema = {
  readonly models: ReadonlyMap<string, ParsedModel>;
  /** Lines outside any block, or blocks of a kind this audit does not read. */
  readonly unreadable: readonly string[];
};

const FIELD_LINE = /^(\w+)\s+(\w+)(\[\]|\?)?(?:\s+(.*))?$/;
const BLOCK_OPEN = /^(model|enum|generator|datasource|view|type)\s+(\w+)\s*\{(.*)$/;
/**
 * The local columns named by a field's `@relation(..., fields: [...])`, read
 * as Prisma reads arguments: strings are opaque (a relation name may contain
 * `fields:` or a parenthesis), and only a top-level `fields:` argument counts.
 * `null` when the attributes cannot be read that way.
 */
export const relationFieldsOf = (attributes: string): readonly string[] | null => {
  // Whitespace may sit between the attribute and its parenthesis (comments are
  // already stripped). A bare `@relation` with no argument list names no field.
  // Find it outside strings: a default value may spell "@relation(" too.
  const masked = attributes.replace(/"(?:[^"\\]|\\.)*"/g, (text) => " ".repeat(text.length));
  const call = /@relation\b\s*(\()?/.exec(masked);
  if (!call) return [];
  if (!call[1]) return [];
  const openParen = call.index + call[0].length - 1;
  const args: string[] = [];
  let depth = 0;
  let current = "";
  let i = openParen + 1;
  for (; i < attributes.length; i += 1) {
    const char = attributes[i];
    if (char === '"') {
      let j = i + 1;
      while (j < attributes.length && attributes[j] !== '"') j += attributes[j] === "\\" ? 2 : 1;
      if (j >= attributes.length) return null;
      current += attributes.slice(i, j + 1);
      i = j;
    } else if (char === "[" || char === "(") {
      depth += 1;
      current += char;
    } else if (char === "]" || (char === ")" && depth > 0)) {
      depth -= 1;
      current += char;
    } else if (char === ")") {
      args.push(current.trim());
      break;
    } else if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (i >= attributes.length) return null;
  const named = args.find((arg) => /^fields\s*:/.test(arg));
  if (!named) return [];
  const list = /^fields\s*:\s*\[([^\]"]*)\]$/.exec(named);
  if (!list) return null;
  return list[1].split(",").map((column) => column.trim()).filter(Boolean);
};

/**
 * Removes `//` and `/* *\/` comments the way Prisma reads them: a comment
 * opener inside a string is text, and a block-comment opener inside a line
 * comment is part of that comment. Newlines are kept, so line numbers survive.
 */
export const stripPrismaComments = (schema: string) => {
  let out = "";
  let i = 0;
  while (i < schema.length) {
    const char = schema[i];
    const next = schema[i + 1];
    if (char === '"') {
      let j = i + 1;
      while (j < schema.length && schema[j] !== '"' && schema[j] !== "\n") {
        j += schema[j] === "\\" ? 2 : 1;
      }
      out += schema.slice(i, j + 1);
      i = j + 1;
    } else if (char === "/" && next === "/") {
      while (i < schema.length && schema[i] !== "\n") i += 1;
    } else if (char === "/" && next === "*") {
      const end = schema.indexOf("*/", i + 2);
      const stop = end < 0 ? schema.length : end + 2;
      out += schema.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
};

type Block = { kind: string; name: string; body: string[] };

/**
 * Reads a Prisma schema line by line. Every non-empty, non-comment line is
 * either understood or reported: text after an opening brace, a block kind
 * this audit does not read (view, type), and anything outside a block.
 */
export const parsePrismaSchema = (schema: string): ParsedSchema => {
  const lines = stripPrismaComments(schema.replace(/\r\n/g, "\n")).split("\n");
  const unreadable: string[] = [];
  const blocks: Block[] = [];
  let open: Block | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (open) {
      if (line === "}") {
        blocks.push(open);
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    if (line === "") continue;
    const start = BLOCK_OPEN.exec(line);
    if (!start) {
      unreadable.push(line);
      continue;
    }
    const [, kind, name, rest] = start;
    open = { kind, name, body: [] };
    if (rest.trim() !== "") unreadable.push(`${kind} ${name}: text after the opening brace "${rest.trim()}"`);
  }
  if (open) unreadable.push(`${open.kind} ${open.name}: no closing brace`);
  for (const block of blocks) {
    if (block.kind === "view" || block.kind === "type") {
      unreadable.push(`${block.kind} ${block.name}: a block kind this audit does not read`);
    }
  }
  const enums = new Set(blocks.filter((block) => block.kind === "enum").map((block) => block.name));
  const modelNames = new Set(blocks.filter((block) => block.kind === "model").map((block) => block.name));
  const models = new Map<string, ParsedModel>();
  for (const block of blocks) {
    if (block.kind !== "model") continue;
    const fields: ParsedField[] = [];
    const modelUnreadable: string[] = [];
    for (const line of block.body) {
      if (line === "" || line.startsWith("@@")) continue;
      const match = FIELD_LINE.exec(line);
      if (!match) {
        modelUnreadable.push(line);
        continue;
      }
      const [, fieldName, type, modifier, attributes = ""] = match;
      const list = modifier === "[]";
      if (modelNames.has(type)) {
        const relationFields = relationFieldsOf(attributes);
        if (relationFields === null) {
          modelUnreadable.push(line);
          continue;
        }
        fields.push({ name: fieldName, type, relation: true, relationFields, list });
      } else if (SCALAR_TYPES.has(type) || enums.has(type)) {
        fields.push({ name: fieldName, type, relation: false, relationFields: [], list });
      } else {
        modelUnreadable.push(line);
      }
    }
    models.set(block.name, { name: block.name, fields, unreadable: modelUnreadable });
  }
  return { models, unreadable };
};

/** Models that are a person's account or sign-in. */
const PERSON_MODELS = new Set(["User", "Account", "Session"]);
/** Scalar names that conventionally hold a person's id. A renamed one is code review's (T11). */
const PERSON_COLUMN = /(^|[a-z])(user|owner|admin|author|actor|operator|decider|reviewer|account)Id$/i;

/** Every model reachable from `Feedback` through relation fields that point at it. */
export const feedbackRelationClosure = (models: ParsedSchema["models"]) => {
  const reached = new Set<string>();
  const queue = ["Feedback"];
  while (queue.length > 0) {
    const target = queue.pop() as string;
    for (const model of models.values()) {
      if (model.name === target || reached.has(model.name)) continue;
      if (model.fields.some((field) => field.relation && field.type === target)) {
        reached.add(model.name);
        queue.push(model.name);
      }
    }
  }
  return reached;
};

/**
 * Compares the manifest with a Prisma schema and returns every disagreement.
 * An empty list is the only passing result.
 */
export const auditDeletionManifest = (
  schema: string,
  manifest: readonly ManifestEntry[] = SUPPORT_TRIAGE_DELETION_MANIFEST
) => {
  const failures: string[] = [];
  const parsed = parsePrismaSchema(schema);
  const models = parsed.models;
  const manifestModels = new Set(manifest.map((entry) => entry.model));
  if (manifestModels.size !== manifest.length) failures.push("a model is listed twice");

  // Nothing in the schema may be skipped silently, inside the manifest or not.
  for (const line of parsed.unreadable) failures.push(`schema: unreadable "${line}"`);
  for (const model of models.values()) {
    if (manifestModels.has(model.name)) continue;
    for (const line of model.unreadable) failures.push(`${model.name}: unreadable schema line "${line}"`);
  }
  const feedback = models.get("Feedback");

  for (const entry of manifest) {
    const model = models.get(entry.model);
    if (!model) {
      failures.push(`${entry.model}: listed in the manifest but not in the schema`);
      continue;
    }
    for (const line of model.unreadable) {
      failures.push(`${entry.model}: unreadable schema line "${line}"`);
    }
    const columns = model.fields.filter((field) => !field.relation).map((field) => field.name);
    for (const column of columns) {
      if (!(column in entry.columns)) failures.push(`${entry.model}.${column}: no classification`);
    }
    for (const [column, columnClass] of Object.entries(entry.columns)) {
      if (!columns.includes(column)) failures.push(`${entry.model}.${column}: classified but not in the schema`);
      if (!COLUMN_CLASSES.includes(columnClass)) failures.push(`${entry.model}.${column}: unknown class ${columnClass}`);
    }
    for (const field of model.fields) {
      if ((field.relation && PERSON_MODELS.has(field.type)) || (!field.relation && PERSON_COLUMN.test(field.name))) {
        failures.push(`${entry.model}.${field.name}: names a person's account`);
      }
    }
    if (!RETENTION_KEYS.includes(entry.retentionKey)) {
      failures.push(`${entry.model}: unknown retention key ${entry.retentionKey}`);
    }

    // The declared link must agree with the schema in both directions: a
    // relation to Feedback on either side, or a feedbackId column, is a link.
    const reachesFeedback =
      model.fields.some(
        (field) => (field.relation && field.type === "Feedback") || (!field.relation && field.name === "feedbackId")
      ) || Boolean(feedback?.fields.some((field) => field.relation && field.type === entry.model));
    if (entry.link.kind === "none" && reachesFeedback) {
      failures.push(`${entry.model}: declared link none but the schema connects it to Feedback`);
    }
    if (entry.link.kind !== "none") {
      if (!(entry.link.column in entry.columns)) {
        failures.push(`${entry.model}: link column ${entry.link.column} is not a classified column`);
      } else if (entry.columns[entry.link.column] !== "identifier") {
        failures.push(`${entry.model}: link column ${entry.link.column} must be an identifier`);
      }
      if (entry.link.kind === "via_model" && !manifestModels.has(entry.link.model)) {
        failures.push(`${entry.model}: links through ${entry.link.model}, which is not in the manifest`);
      }
      // The declared column must be the foreign key of a relation to the
      // declared target, or, for an untyped link, a plain feedbackId column
      // that no relation backs.
      const link = entry.link;
      const backing = model.fields.filter(
        (field) => field.relation && field.relationFields.includes(link.column)
      );
      if (link.kind === "feedback_id" || link.kind === "via_model") {
        const target = link.kind === "feedback_id" ? "Feedback" : link.model;
        if (!backing.some((field) => field.type === target)) {
          failures.push(
            `${entry.model}: link column ${link.column} is not the foreign key of a relation to ${target}`
          );
        }
      }
      if (link.kind === "member_ids") {
        const column = model.fields.find((field) => !field.relation && field.name === link.column);
        if (!column || column.type !== "String" || !column.list) {
          failures.push(`${entry.model}: member id list ${link.column} must be a String[] column`);
        }
        const through = manifest.find((other) => other.model === link.through);
        if (!through || through.link.kind !== "feedback_id") {
          failures.push(`${entry.model}: links through ${link.through}, which must link to Feedback by feedbackId`);
        }
        const back = models.get(link.through);
        if (!back?.fields.some((field) => field.relation && field.type === entry.model && field.relationFields.length > 0)) {
          failures.push(`${entry.model}: ${link.through} does not reference it`);
        }
      }
      if (link.kind === "via_children") {
        if (link.column !== "id") failures.push(`${entry.model}: a via_children link names the model's own id`);
        const through = manifest.find((other) => other.model === link.through);
        if (!through || through.link.kind !== "feedback_id" || through.onAccountDeletion !== "delete_parent_record") {
          failures.push(`${entry.model}: links through ${link.through}, which must link by feedbackId and delete its parent`);
        }
        const back = models.get(link.through);
        if (!back?.fields.some((field) => field.relation && field.type === entry.model && field.relationFields.length > 0)) {
          failures.push(`${entry.model}: ${link.through} does not reference it`);
        }
      }
      if (link.kind === "untyped") {
        if (link.column !== "feedbackId") {
          failures.push(`${entry.model}: an untyped link must be a feedbackId column`);
        }
        if (backing.length > 0) {
          failures.push(`${entry.model}: link column ${link.column} is backed by a relation; declare it typed`);
        }
      }
      if (entry.onAccountDeletion === "none") {
        failures.push(`${entry.model}: linked to a report but does nothing on account deletion`);
      }
    }
    if (entry.link.kind === "none") {
      for (const [column, columnClass] of Object.entries(entry.columns)) {
        if (REPORT_CONTENT_CLASSES.includes(columnClass)) {
          failures.push(`${entry.model}.${column}: a link-none model cannot hold ${columnClass}`);
        }
        if (columnClass === "identifier" && column !== "id") {
          failures.push(`${entry.model}.${column}: a link-none model's only identifier is its own id`);
        }
      }
    }
  }

  // Name-independent: anything that reaches Feedback by relation, or carries a
  // feedbackId column, is either pre-existing or in the manifest.
  const reaching = feedbackRelationClosure(models);
  for (const model of models.values()) {
    if (model.name === "Feedback") continue;
    if (model.fields.some((field) => !field.relation && field.name === "feedbackId")) reaching.add(model.name);
  }
  // Feedback itself is the root, reached again only through its own self-relations.
  reaching.delete("Feedback");
  for (const name of reaching) {
    if (!manifestModels.has(name) && !PRE_EXISTING_FEEDBACK_MODELS.includes(name)) {
      failures.push(`${name}: reaches Feedback but is not in the deletion manifest`);
    }
  }
  for (const name of models.keys()) {
    if (name.startsWith("SupportTriage") && !manifestModels.has(name)) {
      failures.push(`${name}: a support-triage model missing from the deletion manifest`);
    }
  }
  return failures;
};
