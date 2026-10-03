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

export type ManifestEntry = {
  readonly model: string;
  readonly link: ManifestLink;
  readonly onAccountDeletion: AccountDeletionAction;
  /** The retention rule in docs/policy/support-triage.md §5 this model follows. */
  readonly retentionKey: string;
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

const FIELD_LINE = /^(\w+)\s+(\w+)(\[\]|\?)?(?:\s+(.*))?$/;

/** Reads models and enums from a Prisma schema. A line it cannot read is reported, never skipped. */
export const parsePrismaSchema = (schema: string) => {
  const text = schema.replace(/\r\n/g, "\n");
  const enums = new Set([...text.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));
  const blocks = [...text.matchAll(/^model\s+(\w+)\s*\{\n([\s\S]*?)^\}/gm)];
  const modelNames = new Set(blocks.map((m) => m[1]));
  const models = new Map<string, ParsedModel>();
  for (const [, name, body] of blocks) {
    const fields: ParsedField[] = [];
    const unreadable: string[] = [];
    for (const raw of body.split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (line === "" || line.startsWith("@@")) continue;
      const match = FIELD_LINE.exec(line);
      if (!match) {
        unreadable.push(line);
        continue;
      }
      const [, fieldName, type] = match;
      if (modelNames.has(type)) {
        fields.push({ name: fieldName, type, relation: true });
      } else if (SCALAR_TYPES.has(type) || enums.has(type)) {
        fields.push({ name: fieldName, type, relation: false });
      } else {
        unreadable.push(line);
      }
    }
    models.set(name, { name, fields, unreadable });
  }
  return models;
};

const PERSON_COLUMN = /^(userId|ownerId)$|(userId|UserId)$/;

/** Every model reachable from `Feedback` through relation fields that point at it. */
export const feedbackRelationClosure = (models: ReadonlyMap<string, ParsedModel>) => {
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
  const models = parsePrismaSchema(schema);
  const manifestModels = new Set(manifest.map((entry) => entry.model));
  if (manifestModels.size !== manifest.length) failures.push("a model is listed twice");

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
      if ((field.relation && field.type === "User") || PERSON_COLUMN.test(field.name)) {
        failures.push(`${entry.model}.${field.name}: names a person's account`);
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
