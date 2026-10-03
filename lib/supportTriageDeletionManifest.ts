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
  | { readonly kind: "untyped"; readonly column: string };

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

type ParsedField = { readonly name: string; readonly type: string; readonly relation: boolean };
type ParsedModel = { readonly name: string; readonly fields: readonly ParsedField[]; readonly unreadable: readonly string[] };
type ParsedSchema = {
  readonly models: ReadonlyMap<string, ParsedModel>;
  /** Lines outside any block, or blocks of a kind this audit does not read. */
  readonly unreadable: readonly string[];
};

const FIELD_LINE = /^(\w+)\s+(\w+)(\[\]|\?)?(?:\s+(.*))?$/;
const BLOCK_OPEN = /^(model|enum|generator|datasource|view|type)\s+(\w+)\s*\{(.*)$/;
const stripComment = (line: string) => line.replace(/\/\/.*$/, "").trim();

type Block = { kind: string; name: string; body: string[] };

/**
 * Reads a Prisma schema line by line. Every non-empty, non-comment line is
 * either understood or reported: text after an opening brace, a block kind
 * this audit does not read (view, type), and anything outside a block.
 */
export const parsePrismaSchema = (schema: string): ParsedSchema => {
  // Block comments become blank lines, so every other line keeps its number.
  const lines = schema
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .split("\n");
  const unreadable: string[] = [];
  const blocks: Block[] = [];
  let open: Block | null = null;
  for (const raw of lines) {
    const line = stripComment(raw);
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
      const [, fieldName, type] = match;
      if (modelNames.has(type)) {
        fields.push({ name: fieldName, type, relation: true });
      } else if (SCALAR_TYPES.has(type) || enums.has(type)) {
        fields.push({ name: fieldName, type, relation: false });
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
