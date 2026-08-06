// Keeps the data-domain registry in step with the schema it describes.
//
// The delivery plan promises that a new product table cannot silently escape
// account deletion and account export. A registry alone does not deliver that
// -- someone adds a table, forgets the registry, and the promise is quietly
// untrue. So the set of user-linked models is derived from
// prisma/schema.prisma on every run and compared against what is registered.
//
// Two derivations, both mechanical, both from the schema rather than from
// anyone's memory:
//
//   user-linked -- the model carries a userId/ownerId column or a User
//                  relation, so it holds data belonging to somebody;
//   cascade      -- the model is reachable from User through relations declared
//                  `onDelete: Cascade`, transitively, so deleting the user
//                  really does delete it.
//
// The second is what makes "cascade_from_user" a claim rather than a comment.
// Removing a cascade fails here instead of leaving data behind unnoticed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(repoRoot, "prisma", "schema.prisma");
const REGISTRY = path.join(repoRoot, "docs", "policy", "tomverse-chat-data-domain-registry.yaml");
const REGISTRY_RELATIVE = "docs/policy/tomverse-chat-data-domain-registry.yaml";

const ALLOWED_MECHANISMS = new Set([
  "cascade_from_user",
  "explicit_deletion",
  "retained",
  "unverified",
]);
const ALLOWED_EXPORT_STATES = new Set(["included", "excluded", "unverified"]);

const errors = [];
const fail = (message) => errors.push(message);

const schema = readFileSync(SCHEMA, "utf8");
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({
  name,
  body,
}));

// A model holds user data when it names a user column or relates to User.
const USER_LINK = /\buserId\s+String|user\s+User\b|ownerId\s+String|User\s+@relation/;
const userLinked = new Set(models.filter(({ body }) => USER_LINK.test(body)).map(({ name }) => name));

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

if (registry?.schemaVersion !== 1) fail(`unsupported schemaVersion ${registry?.schemaVersion}`);
if (!Array.isArray(registry?.domains) || registry.domains.length === 0) {
  console.error(`FAIL ${REGISTRY_RELATIVE}: domains must be a non-empty list`);
  process.exit(1);
}

const registered = new Map();
for (const row of registry.domains) {
  const model = row?.prismaModel;
  if (typeof model !== "string" || model === "") {
    fail(`a row has no prismaModel (domain: ${row?.domain ?? "unnamed"})`);
    continue;
  }
  if (registered.has(model)) {
    fail(`${model}: duplicate row`);
    continue;
  }
  registered.set(model, row);

  if (typeof row.domain !== "string" || row.domain === "") fail(`${model}: needs a domain name`);
  if (typeof row.owner !== "string" || row.owner === "") fail(`${model}: needs an owner`);

  if (!userLinked.has(model)) {
    fail(
      `${model}: registered but carries no user data in the schema. Remove the row, or add the ` +
        "user column or relation that makes it a data domain."
    );
    continue;
  }

  if (!ALLOWED_MECHANISMS.has(row.deletionMechanism)) {
    fail(
      `${model}: deletionMechanism "${row.deletionMechanism}" must be one of ` +
        [...ALLOWED_MECHANISMS].join(", ")
    );
    continue;
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

  // Keeping financial or audit rows past deletion is a legitimate decision. It
  // has to look different from an oversight, so it needs its reason.
  if (row.deletionMechanism === "retained") {
    if (typeof row.retentionReason !== "string" || row.retentionReason.trim() === "") {
      fail(`${model}: "retained" needs a retentionReason. Retention by omission is not a decision.`);
    }
  } else if (typeof row.retentionReason === "string" && row.retentionReason.trim() !== "") {
    fail(`${model}: retentionReason only applies to a "retained" row.`);
  }

  if (!ALLOWED_EXPORT_STATES.has(row.inUnifiedExport)) {
    fail(
      `${model}: inUnifiedExport "${row.inUnifiedExport}" must be one of ` +
        [...ALLOWED_EXPORT_STATES].join(", ")
    );
  }
}

// The promise itself: a new table cannot escape the privacy workflows.
for (const model of userLinked) {
  if (!registered.has(model)) {
    fail(
      `${model} holds user data but is not in the registry. Add a row with its deletion mechanism ` +
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

const counts = registry.domains.reduce((totals, row) => {
  totals[row.deletionMechanism] = (totals[row.deletionMechanism] ?? 0) + 1;
  return totals;
}, {});
const unverifiedDeletion = counts.unverified ?? 0;
const unverifiedExport = registry.domains.filter(
  (row) => row.inUnifiedExport === "unverified"
).length;

console.log(
  `OK ${REGISTRY_RELATIVE}: ${registry.domains.length} data domains, all user-linked models ` +
    `registered. Deletion: ${Object.entries(counts)
      .map(([mechanism, count]) => `${count} ${mechanism}`)
      .join(", ")}.`
);
if (unverifiedDeletion > 0 || unverifiedExport > 0) {
  console.log(
    `   ${unverifiedDeletion} domain(s) have an unverified deletion path and ` +
      `${unverifiedExport} an unverified export state; PRIVACY-01/02 stay blocked until each is ` +
      "traced or recorded as retained."
  );
}
