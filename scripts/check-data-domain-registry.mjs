// Keeps the data-domain registry in step with the schema it describes.
//
// The delivery plan promises that a new product table cannot silently escape
// account deletion and account export. A registry alone does not deliver that
// -- someone adds a table, forgets the registry, and the promise is quietly
// untrue. So the set of user-linked models is derived from
// prisma/schema.prisma on every run and compared against what is registered.
//
// Three derivations, all mechanical, all from the schema rather than from
// anyone's memory:
//
//   user-linked -- the model carries a userId/ownerId column or a User
//                  relation, so it holds data belonging to somebody;
//   cascade      -- the model is reachable from User through relations declared
//                  `onDelete: Cascade`, transitively, so deleting the user
//                  really does delete it;
//   columns      -- each model's own columns and their nullability, so an
//                  anonymisation cannot name a field that does not exist, or
//                  promise NULL for a column that cannot take one.
//
// The second is what makes "cascade_from_user" a claim rather than a comment.
// Removing a cascade fails here instead of leaving data behind unnoticed.
//
// What this cannot check, and therefore demands in writing: whether an
// anonymised row can be re-joined to the person through a child table, a log,
// or a third party. `reidentificationReview` is that judgement, recorded with
// its open risks rather than assumed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { EXPORT_DOMAIN_DECLARATIONS } from "../lib/accountDataExportDomains.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(repoRoot, "prisma", "schema.prisma");
// A path argument exists so the validator can be pointed at a fixture and
// checked that it really rejects what it claims to. A validator nobody has seen
// fail is a validator nobody knows works.
const DEFAULT_REGISTRY = path.join(
  repoRoot,
  "docs",
  "policy",
  "tomverse-chat-data-domain-registry.yaml"
);
const REGISTRY = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_REGISTRY;
const REGISTRY_RELATIVE = path.relative(repoRoot, REGISTRY);

const REGISTRY_SCHEMA_VERSION = 3;

// Whose data the User link represents.
//
//   subject  the linked user is the person the row is about. Almost every row.
//   actor    the linked user is the operator who did something. The person the
//            row is *about* is somewhere else -- in this schema, an untyped
//            targetType/targetId pair with no foreign key, which no derivation
//            over the schema can see. Saying so in the registry is the only way
//            that linkage gets graded at all.
const ALLOWED_LINKAGE_ROLES = new Set(["subject", "actor"]);
const ALLOWED_SUBJECT_REFERENCE_KINDS = new Set(["untyped_target", "none"]);
const ALLOWED_SUBJECT_ACTIONS = new Set(["delete", "retain"]);

const ALLOWED_ACTIONS = new Set(["delete", "anonymise", "retain", "unverified"]);
const ALLOWED_MECHANISMS = new Set(["cascade_from_user", "explicit_deletion", "ttl_purge"]);
const ALLOWED_POLICIES = new Set(["immediate", "ttl", "statutory", "legal_hold", "unverified"]);
const ALLOWED_STATUSES = new Set(["implemented", "planned"]);
const ALLOWED_EXPORT_STATES = new Set([
  "included",
  "included_filtered",
  "excluded",
  "unverified",
]);

// Columns that name a person directly. An anonymised row that keeps one of
// these has not been anonymised, whatever else was scrubbed.
//
// The pattern catches `createdByEmail` and `actorEmail` as well as `email`.
// Those were how three tables kept an operator's address after that operator
// deleted their own account: the relation was onDelete: SetNull, which cleared
// the id and left the address beside it.
const DIRECT_IDENTIFIER_COLUMNS = ["userId", "ownerId", "subjectKey", "traceId"];
const DIRECT_IDENTIFIER_PATTERN = /^(email|.*Email)$/;

const isDirectIdentifier = (column) =>
  DIRECT_IDENTIFIER_COLUMNS.includes(column) || DIRECT_IDENTIFIER_PATTERN.test(column);

const RETENTION_FIELDS = [
  "retentionPolicyRef",
  "legalBasis",
  "retentionStartsFrom",
  "retentionPeriod",
  "owner",
  "legalHoldOverridesPurge",
  "nextReviewAt",
];

const errors = [];
const fail = (message) => errors.push(message);

const isFilledString = (value) => typeof value === "string" && value.trim() !== "";

const schema = readFileSync(SCHEMA, "utf8");
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({
  name,
  body,
}));

// A model holds user data when it names a user column or relates to User.
//
// The relation half of this used to be `user\s+User\b|User\s+@relation`, which
// required the relation field to be *named* `user` and to be non-optional.
// Three models satisfied neither -- AdminAuditLog.actor, AdminNote.createdBy and
// ModelOverride.updatedBy are all `X User? @relation` -- so they escaped the
// registry entirely and were graded by nothing. Matching any field whose type
// is User, optional or not, is what the rule was always supposed to say.
const USER_LINK = /\buserId\s+String|\bownerId\s+String|\w+\s+User\??\s+@relation/;
const userLinked = new Set(models.filter(({ body }) => USER_LINK.test(body)).map(({ name }) => name));

// Two questions, and they stopped having the same answer.
//
// "Does this registered row still hold user data?" guards a stale registry
// entry. "Does this model hold user data, so it must register?" is the sweep
// below. One rule answered both while every user-holding table had a User
// relation -- and on 2026-08-26 `AdminAuditLog` stopped having one, on purpose:
// `actorUserId` is part of that row's HMAC input, so `ON DELETE SET NULL`
// rewrote signed audit rows whenever an account was deleted and made them
// indistinguishable from forged ones. See
// prisma/migrations/20260826070000_admin_audit_actor_not_a_foreign_key.
//
// The row still holds a user's id and address; only the foreign key is gone.
// Reading "no relation" as "no user data" would have deleted its registry row
// and let the most privacy-sensitive table in the schema out of the workflows
// -- the same escape the USER_LINK comment above records catching once.
//
// So the registered-row check reads columns. The sweep keeps the narrower rule
// deliberately: widening it would newly require FeedbackLifecycleEvent and
// RefundRequestTimelineEvent to register, and those rows carry decisions --
// owner, legal basis, retention period, review date -- that no script can
// derive. They escape today too; widening the sweep is a governance change
// with an owner, not a side effect of this one.
const USER_COLUMN = /^\s{2}\w*[Uu]serId\s+String\b/m;
const holdsUserData = new Set(
  models
    .filter(({ body }) => USER_LINK.test(body) || USER_COLUMN.test(body))
    .map(({ name }) => name)
);
// User does not point at a user; it is one. The derivation cannot see that, and
// leaving the root out would let the account's own profile escape both
// workflows -- which is exactly what the registry exists to prevent.
userLinked.add("User");
holdsUserData.add("User");

// Scalar columns and their nullability, so an anonymisation can be checked
// against the table it claims to scrub. Relation fields are skipped: they are
// navigation, not storage, and scrubbing them means scrubbing their scalars.
const RELATION_TYPES = new Set(models.map(({ name }) => name));
const columnsByModel = new Map();
for (const { name, body } of models) {
  const columns = new Map();
  for (const line of body.split("\n")) {
    const match = /^\s{2}(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
    if (!match) continue;
    const [, column, type, list, optional] = match;
    if (RELATION_TYPES.has(type) || list) continue;
    columns.set(column, { nullable: Boolean(optional), unique: /@unique/.test(line) });
  }
  columnsByModel.set(name, columns);
}

// Transitive closure over cascading relations, starting at User.
const cascadeEdges = [];
for (const { name, body } of models) {
  for (const relation of body.matchAll(/(\w+)\s+(\w+)\??\s+@relation\(([^)]*)\)/g)) {
    if (/onDelete:\s*Cascade/.test(relation[3])) cascadeEdges.push([name, relation[2]]);
  }
}
const cascadeReachable = new Set(["User"]);
for (let changed = true; changed; ) {
  changed = false;
  for (const [child, parent] of cascadeEdges) {
    if (cascadeReachable.has(parent) && !cascadeReachable.has(child)) {
      cascadeReachable.add(child);
      changed = true;
    }
  }
}

let registry;
try {
  registry = parse(readFileSync(REGISTRY, "utf8"));
} catch (cause) {
  console.error(`FAIL ${REGISTRY_RELATIVE}: unreadable or invalid YAML -- ${cause.message}`);
  process.exit(1);
}

if (registry?.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
  fail(
    `unsupported schemaVersion ${registry?.schemaVersion}; this validator reads ` +
      `${REGISTRY_SCHEMA_VERSION} (deletionAction and retentionPolicy as separate axes)`
  );
}
if (!Array.isArray(registry?.domains) || registry.domains.length === 0) {
  console.error(`FAIL ${REGISTRY_RELATIVE}: domains must be a non-empty list`);
  process.exit(1);
}

/** Field lists are only meaningful if every entry is a real column. */
const checkFieldList = (model, label, value, { required }) => {
  if (value === undefined || value === null) {
    if (required) fail(`${model}: needs ${label}`);
    return [];
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(isFilledString)) {
    fail(`${model}: ${label} must be a non-empty list of column names`);
    return [];
  }
  const columns = columnsByModel.get(model) ?? new Map();
  for (const field of value) {
    if (!columns.has(field)) {
      fail(`${model}: ${label} names "${field}", which is not a column on the model`);
    }
  }
  return value;
};

const registered = new Map();
for (const row of registry.domains) {
  const model = row?.prismaModel;
  if (!isFilledString(model)) {
    fail(`a row has no prismaModel (domain: ${row?.domain ?? "unnamed"})`);
    continue;
  }
  if (registered.has(model)) {
    fail(`${model}: duplicate row`);
    continue;
  }
  registered.set(model, row);

  if (!isFilledString(row.domain)) fail(`${model}: needs a domain name`);
  if (!isFilledString(row.owner)) fail(`${model}: needs an owner`);

  if (!holdsUserData.has(model)) {
    fail(
      `${model}: registered but carries no user data in the schema. Remove the row, or add the ` +
        "user column or relation that makes it a data domain."
    );
    continue;
  }

  // Whose data the User link is. Every row says, because "this table relates to
  // User" answers nothing on its own: the relation can be the person the row
  // describes or the operator who wrote it, and the deletion obligations are
  // completely different.
  if (!ALLOWED_LINKAGE_ROLES.has(row.userLinkageRole)) {
    fail(
      `${model}: userLinkageRole "${row.userLinkageRole}" must be one of ` +
        [...ALLOWED_LINKAGE_ROLES].join(", ")
    );
    continue;
  }

  if (row.userLinkageRole === "actor") {
    // An actor row's deletionAction covers the operator's own account. The
    // person the row is *about* is reached some other way, and that way has to
    // be written down -- the schema cannot express it, so nothing else can
    // check that it was considered at all.
    const reference = row.subjectReference;
    if (typeof reference !== "object" || reference === null || Array.isArray(reference)) {
      fail(
        `${model}: an "actor" row needs a subjectReference. Its User relation is the operator, ` +
          "so the registry has said nothing yet about the person the row describes."
      );
    } else if (!ALLOWED_SUBJECT_REFERENCE_KINDS.has(reference.kind)) {
      fail(
        `${model}: subjectReference.kind "${reference.kind}" must be one of ` +
          [...ALLOWED_SUBJECT_REFERENCE_KINDS].join(", ")
      );
    } else if (reference.kind === "untyped_target") {
      const columns = columnsByModel.get(model) ?? new Map();
      for (const key of ["targetTypeColumn", "targetIdColumn"]) {
        const column = reference[key];
        if (!isFilledString(column)) {
          fail(`${model}: subjectReference.${key} is missing.`);
        } else if (!columns.has(column)) {
          fail(`${model}: subjectReference.${key} names "${column}", which is not a column.`);
        }
      }
      if (!isFilledString(reference.subjectTargetType)) {
        fail(
          `${model}: subjectReference.subjectTargetType is missing. Without the value that means ` +
            "'this row is about a user', the reference cannot be resolved by anything."
        );
      }
      if (!ALLOWED_SUBJECT_ACTIONS.has(reference.deletionAction)) {
        fail(
          `${model}: subjectReference.deletionAction "${reference.deletionAction}" must be one ` +
            `of ${[...ALLOWED_SUBJECT_ACTIONS].join(", ")}. There is no foreign key here, so ` +
            "nothing happens by default and 'nothing' has to be a decision."
        );
      }
      if (reference.deletionAction === "delete" && !isFilledString(reference.deletionMechanism)) {
        fail(`${model}: subjectReference.deletionAction "delete" needs a deletionMechanism.`);
      }
      if (reference.deletionAction === "retain") {
        const retention = reference.retention;
        if (typeof retention !== "object" || retention === null || Array.isArray(retention)) {
          fail(`${model}: subjectReference retained without a retention block.`);
        } else {
          for (const field of RETENTION_FIELDS) {
            const value = retention[field];
            const filled =
              field === "legalHoldOverridesPurge"
                ? typeof value === "boolean"
                : isFilledString(value);
            if (!filled) fail(`${model}: subjectReference.retention.${field} is missing.`);
          }
        }
      }
    }
  } else if (row.subjectReference !== undefined && row.subjectReference !== null) {
    fail(
      `${model}: subjectReference only applies to an "actor" row. On a "subject" row the User ` +
        "link already is the person."
    );
  }

  if (!ALLOWED_ACTIONS.has(row.deletionAction)) {
    fail(
      `${model}: deletionAction "${row.deletionAction}" must be one of ` +
        [...ALLOWED_ACTIONS].join(", ")
    );
    continue;
  }
  if (!ALLOWED_POLICIES.has(row.retentionPolicy)) {
    fail(
      `${model}: retentionPolicy "${row.retentionPolicy}" must be one of ` +
        [...ALLOWED_POLICIES].join(", ")
    );
    continue;
  }
  if (!ALLOWED_STATUSES.has(row.implementationStatus)) {
    fail(
      `${model}: implementationStatus "${row.implementationStatus}" must be one of ` +
        [...ALLOWED_STATUSES].join(", ")
    );
    continue;
  }
  if (row.implementationStatus === "planned" && !isFilledString(row.plannedWorkRef)) {
    fail(
      `${model}: a planned row needs a plannedWorkRef. An intention without a work item is a ` +
        "gap that reads like a decision."
    );
  }
  if (row.implementationStatus === "implemented" && isFilledString(row.plannedWorkRef)) {
    fail(`${model}: plannedWorkRef only applies to a planned row.`);
  }

  // "unverified" is honest but has to be honest on both axes at once: a row
  // whose deletion nobody has traced cannot have a known retention either.
  if (
    (row.deletionAction === "unverified") !== (row.retentionPolicy === "unverified")
  ) {
    fail(
      `${model}: deletionAction and retentionPolicy must both be "unverified" or neither. ` +
        "An untraced deletion path has no known retention."
    );
  }

  // --- axis one: what happens to the row -----------------------------------
  if (row.deletionAction === "retain") {
    if (row.deletionMechanism !== undefined && row.deletionMechanism !== null) {
      fail(`${model}: a retained row is not deleted, so it has no deletionMechanism.`);
    }
  } else if (row.deletionAction === "unverified") {
    if (isFilledString(row.deletionMechanism)) {
      fail(`${model}: an unverified row cannot claim a deletionMechanism.`);
    }
  } else if (!ALLOWED_MECHANISMS.has(row.deletionMechanism)) {
    fail(
      `${model}: deletionMechanism "${row.deletionMechanism}" must be one of ` +
        [...ALLOWED_MECHANISMS].join(", ")
    );
  }

  // The claim that makes this registry worth having: cascade is checked, not
  // asserted. Dropping an onDelete: Cascade fails here rather than silently
  // leaving a deleted user's rows behind.
  if (row.deletionMechanism === "cascade_from_user" && !cascadeReachable.has(model)) {
    fail(
      `${model}: claims cascade_from_user, but the schema does not reach it from User through ` +
        "cascading relations. Either restore the cascade or record how it is really deleted."
    );
  }

  if (row.deletionAction === "anonymise") {
    const columns = columnsByModel.get(model) ?? new Map();
    const fields = checkFieldList(model, "anonymisationFields", row.anonymisationFields, {
      required: true,
    });
    const listed = new Set(fields);

    // The user's objection to a one-axis model, made checkable: setting userId
    // to NULL is not anonymisation while the row still carries another column
    // that names the same person.
    for (const identifier of columns.keys()) {
      if (isDirectIdentifier(identifier) && !listed.has(identifier)) {
        fail(
          `${model}: anonymisationFields omits "${identifier}", which still names the person. ` +
            "An anonymised row cannot keep a direct identifier."
        );
      }
    }

    const replacements = row.anonymisationReplacements ?? {};
    if (typeof replacements !== "object" || Array.isArray(replacements)) {
      fail(`${model}: anonymisationReplacements must be a mapping of column to replacement value`);
    } else {
      for (const field of fields) {
        const column = columns.get(field);
        if (!column) continue;
        const hasReplacement = Object.prototype.hasOwnProperty.call(replacements, field);
        if (!column.nullable && !hasReplacement) {
          fail(
            `${model}: "${field}" is not nullable, so anonymising it cannot mean setting NULL. ` +
              "Give it an anonymisationReplacements entry."
          );
        }
        if (column.unique && hasReplacement && !String(replacements[field]).includes("{id}")) {
          fail(
            `${model}: "${field}" is unique, so every anonymised row would collide on the same ` +
              'replacement. Interpolate the row\'s own key with "{id}".'
          );
        }
      }
      for (const field of Object.keys(replacements)) {
        if (!listed.has(field)) {
          fail(`${model}: anonymisationReplacements covers "${field}", which is not anonymised.`);
        }
      }
    }

    // The part no derivation can settle. Demanded only once the anonymisation
    // exists -- reviewing a scrub that has not been written yet reviews nothing.
    if (row.implementationStatus === "implemented") {
      const review = row.reidentificationReview;
      if (typeof review !== "object" || review === null || Array.isArray(review)) {
        fail(
          `${model}: an implemented anonymisation needs a reidentificationReview. Clearing the ` +
            "direct identifiers is checkable here; whether the row can be re-joined to the person " +
            "through another table, a log or a third party is not."
        );
      } else {
        if (!isFilledString(review.reviewedBy)) fail(`${model}: reidentificationReview needs a reviewedBy`);
        if (!isFilledString(review.reviewedAt)) fail(`${model}: reidentificationReview needs a reviewedAt`);
        if (
          !Array.isArray(review.joinRisksConsidered) ||
          review.joinRisksConsidered.length === 0 ||
          !review.joinRisksConsidered.every(isFilledString)
        ) {
          fail(
            `${model}: reidentificationReview needs joinRisksConsidered -- the join paths that ` +
              "were looked at, including the ones still open."
          );
        }
      }
    }
  } else {
    for (const key of ["anonymisationFields", "anonymisationReplacements", "reidentificationReview"]) {
      if (row[key] !== undefined && row[key] !== null) {
        fail(`${model}: ${key} only applies to an "anonymise" row.`);
      }
    }
  }

  if (row.minimisationFields !== undefined && row.minimisationFields !== null) {
    checkFieldList(model, "minimisationFields", row.minimisationFields, { required: false });
  }

  // --- axis two: how long whatever survives is kept -------------------------
  if (row.retentionPolicy === "ttl") {
    if (!Number.isInteger(row.ttlDays) || row.ttlDays <= 0) {
      fail(`${model}: a "ttl" row needs a positive integer ttlDays.`);
    }
  } else if (row.ttlDays !== undefined && row.ttlDays !== null) {
    fail(`${model}: ttlDays only applies to a "ttl" row.`);
  }

  const retentionRequired =
    row.retentionPolicy === "statutory" || row.retentionPolicy === "legal_hold";
  if (retentionRequired) {
    const retention = row.retention;
    if (typeof retention !== "object" || retention === null || Array.isArray(retention)) {
      fail(
        `${model}: retentionPolicy "${row.retentionPolicy}" needs a retention block. ` +
          "Retention by omission is not a decision."
      );
    } else {
      for (const field of RETENTION_FIELDS) {
        const value = retention[field];
        const filled = field === "legalHoldOverridesPurge" ? typeof value === "boolean" : isFilledString(value);
        if (!filled) fail(`${model}: retention.${field} is missing.`);
      }
      // Without a review date a "TBD" period is permanent by accident.
      if (isFilledString(retention.nextReviewAt) && !/^\d{4}-\d{2}-\d{2}$/.test(retention.nextReviewAt)) {
        fail(`${model}: retention.nextReviewAt must be an ISO date.`);
      }
    }
  } else if (row.retention !== undefined && row.retention !== null) {
    fail(`${model}: a retention block only applies to a statutory or legal_hold row.`);
  }

  // A row kept under a legal basis has to be kept, not merely not-deleted.
  if (row.deletionAction === "retain" && row.retentionPolicy === "immediate") {
    fail(`${model}: a retained row cannot have an "immediate" retention policy.`);
  }

  if (!ALLOWED_EXPORT_STATES.has(row.inUnifiedExport)) {
    fail(
      `${model}: inUnifiedExport "${row.inUnifiedExport}" must be one of ` +
        [...ALLOWED_EXPORT_STATES].join(", ")
    );
  }
}

// The export side has three places that must agree: this registry, the domain
// declarations, and the fetchers keyed off them (checked in
// lib/accountDataExport.ts by exportDomainWiringProblems). Two of the three are
// compared here; a disagreement means the registry is describing an export that
// does not exist, or hiding one that does.
const declaredByDomain = new Map(
  EXPORT_DOMAIN_DECLARATIONS.map((declaration) => [declaration.domain, declaration])
);

for (const [model, row] of registered) {
  const declaration = declaredByDomain.get(row.domain);
  if (!declaration) {
    fail(
      `${model}: domain "${row.domain}" has no export declaration in ` +
        "lib/accountDataExportDomains.ts. Every data domain needs one, even if it is unverified."
    );
    continue;
  }
  if (declaration.prismaModel !== model) {
    fail(
      `${row.domain}: the registry maps it to ${model} but the export declaration says ` +
        `${declaration.prismaModel}.`
    );
  }
  if (declaration.state !== row.inUnifiedExport) {
    fail(
      `${row.domain}: registry says inUnifiedExport "${row.inUnifiedExport}" but the export ` +
        `declares "${declaration.state}". The registry must describe the export that exists.`
    );
  }
}

for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
  const registeredRow = [...registered.values()].find((row) => row.domain === declaration.domain);
  if (!registeredRow) {
    fail(
      `${declaration.domain}: declared in the export but absent from the registry, so its ` +
        "deletion path is unrecorded."
    );
  }
}

// The promise itself: a new table cannot escape the privacy workflows.
for (const model of userLinked) {
  if (!registered.has(model)) {
    fail(
      `${model} holds user data but is not in the registry. Add a row with its deletion action ` +
        `(the schema says it is ${cascadeReachable.has(model) ? "" : "NOT "}reachable from User by cascade) ` +
        "and its export state."
    );
  }
}

if (errors.length > 0) {
  console.error(`FAIL ${REGISTRY_RELATIVE} (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}

const tally = (key) =>
  registry.domains.reduce((totals, row) => {
    totals[row[key]] = (totals[row[key]] ?? 0) + 1;
    return totals;
  }, {});
const describe = (totals) =>
  Object.entries(totals)
    .map(([value, count]) => `${count} ${value}`)
    .join(", ");

const planned = registry.domains.filter((row) => row.implementationStatus === "planned");
const unverifiedDeletion = registry.domains.filter(
  (row) => row.deletionAction === "unverified"
).length;
const unverifiedExport = registry.domains.filter(
  (row) => row.inUnifiedExport === "unverified"
).length;

console.log(
  `OK ${REGISTRY_RELATIVE}: ${registry.domains.length} data domains, all user-linked models ` +
    `registered.\n   Deletion action: ${describe(tally("deletionAction"))}.` +
    `\n   Retention policy: ${describe(tally("retentionPolicy"))}.`
);
if (planned.length > 0) {
  console.log(
    `   ${planned.length} domain(s) are decided but not yet built -- ` +
      `${planned.map((row) => row.domain).join(", ")}. PRIVACY-01 stays blocked until each ships.`
  );
}
if (unverifiedDeletion > 0 || unverifiedExport > 0) {
  console.log(
    `   ${unverifiedDeletion} domain(s) have an unverified deletion path and ` +
      `${unverifiedExport} an unverified export state; PRIVACY-01/02 stay blocked until each is ` +
      "traced or recorded as retained."
  );
}
