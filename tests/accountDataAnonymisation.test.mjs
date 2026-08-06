import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

import {
  ACCOUNT_ANONYMISATIONS,
  ANONYMISED_SUBJECT,
  buildAnonymisationStatement,
  SUBJECT_TARGET_DELETIONS,
} from "../lib/accountDataAnonymisation.ts";

const registry = parse(
  readFileSync(
    new URL("../docs/policy/tomverse-chat-data-domain-registry.yaml", import.meta.url),
    "utf8"
  )
);
const rows = registry.domains.filter((row) => row.deletionAction === "anonymise");
const byModel = new Map(ACCOUNT_ANONYMISATIONS.map((entry) => [entry.prismaModel, entry]));

// Two tables anonymise inline in lib/accountDeletion.ts, from before this
// module existed; the other four go through it. Naming them here rather than
// deriving the split means adding a fifth to the registry without implementing
// it fails, instead of quietly widening the exemption.
const INLINE_IN_ACCOUNT_DELETION = new Set(["Feedback", "RefundRequest"]);

test("every registry anonymisation is implemented somewhere", () => {
  assert.ok(rows.length > 0, "the registry declares no anonymisations");
  for (const row of rows) {
    const implemented =
      byModel.has(row.prismaModel) || INLINE_IN_ACCOUNT_DELETION.has(row.prismaModel);
    assert.ok(implemented, `${row.prismaModel} is declared anonymise but nothing anonymises it`);
  }
});

test("nothing anonymises a table the registry does not declare", () => {
  const declared = new Set(rows.map((row) => row.prismaModel));
  for (const entry of ACCOUNT_ANONYMISATIONS) {
    assert.ok(
      declared.has(entry.prismaModel),
      `${entry.prismaModel} is anonymised but not declared in the registry`
    );
  }
});

// The claim that makes the registry worth having on this axis: the columns it
// says are cleared are the columns the code clears. Either side drifting is a
// silent gap -- the registry would keep asserting an anonymisation that the
// implementation stopped performing.
test("the implemented column list matches the registry field for field", () => {
  for (const entry of ACCOUNT_ANONYMISATIONS) {
    const row = rows.find((candidate) => candidate.prismaModel === entry.prismaModel);
    assert.ok(row, `${entry.prismaModel} has no registry row`);
    assert.deepEqual(
      Object.keys(entry.columns).sort(),
      [...row.anonymisationFields].sort(),
      `${entry.prismaModel}: implementation and registry disagree on which columns are cleared`
    );
  }
});

// A NOT NULL column cannot take NULL, and the registry says what it takes
// instead. If those two answers differ, one of them is wrong about the schema.
test("the registry's replacements match what the implementation writes", () => {
  for (const entry of ACCOUNT_ANONYMISATIONS) {
    const row = rows.find((candidate) => candidate.prismaModel === entry.prismaModel);
    const declared = row.anonymisationReplacements ?? {};

    for (const [column, replacement] of Object.entries(entry.columns)) {
      const registryValue = declared[column];
      switch (replacement.kind) {
        case "null":
          assert.equal(
            registryValue,
            undefined,
            `${entry.prismaModel}.${column} is set to NULL but the registry gives it a replacement`
          );
          break;
        case "literal":
          assert.equal(
            registryValue,
            replacement.value,
            `${entry.prismaModel}.${column} replacement disagrees with the registry`
          );
          break;
        case "perRow":
          assert.equal(
            registryValue,
            `${replacement.prefix}{id}`,
            `${entry.prismaModel}.${column} per-row replacement disagrees with the registry`
          );
          break;
        case "emptyJson":
          assert.equal(
            registryValue,
            "{}",
            `${entry.prismaModel}.${column} should be recorded as emptied in the registry`
          );
          break;
        default:
          assert.fail(`unknown replacement kind for ${entry.prismaModel}.${column}`);
      }
    }
  }
});

// The user's objection, restated as a test: clearing userId is where this
// starts, not where it finishes.
test("no anonymisation clears only the user link", () => {
  for (const entry of ACCOUNT_ANONYMISATIONS) {
    const columns = Object.keys(entry.columns);
    // Whatever the link column is called -- userId on a subject table,
    // createdById or updatedById where the linked user is the operator.
    assert.ok(
      columns.includes(entry.userColumn),
      `${entry.prismaModel} does not clear its own link column ${entry.userColumn}`
    );
    assert.ok(
      columns.length > 1,
      `${entry.prismaModel} clears only ${entry.userColumn}, which renames the row rather than anonymising it`
    );
  }
});

// The linkage no schema derivation can see. AdminNote.targetId points at a user
// by convention with no foreign key, so nothing cascaded and nothing did:
// notes written about a customer outlived that customer's account entirely.
test("every untyped subject reference the registry declares is followed by the code", () => {
  const declared = registry.domains
    .filter((row) => row.subjectReference?.kind === "untyped_target")
    .filter((row) => row.subjectReference.deletionAction === "delete");
  assert.ok(declared.length > 0, "no untyped subject deletion is declared");

  const implemented = new Set(SUBJECT_TARGET_DELETIONS.map((entry) => entry.prismaModel));
  for (const row of declared) {
    assert.ok(
      implemented.has(row.prismaModel),
      `${row.prismaModel} declares its subject rows are deleted, but nothing deletes them`
    );
    const entry = SUBJECT_TARGET_DELETIONS.find((e) => e.prismaModel === row.prismaModel);
    assert.equal(
      entry.subjectTargetType,
      row.subjectReference.subjectTargetType,
      `${row.prismaModel}: the target type the code matches is not the one declared`
    );
  }
});

test("nothing deletes subject rows the registry says are retained", () => {
  const retained = new Set(
    registry.domains
      .filter((row) => row.subjectReference?.deletionAction === "retain")
      .map((row) => row.prismaModel)
  );
  for (const entry of SUBJECT_TARGET_DELETIONS) {
    assert.equal(
      retained.has(entry.prismaModel),
      false,
      `${entry.prismaModel} is deleted by subject, but the registry says those rows are retained`
    );
  }
});

test("every value in the statement is a bound parameter, never inlined", () => {
  for (const entry of ACCOUNT_ANONYMISATIONS) {
    const { sql, values } = buildAnonymisationStatement(entry);
    assert.equal(
      sql.includes(ANONYMISED_SUBJECT),
      false,
      `${entry.prismaModel} inlines the placeholder into the SQL`
    );
    assert.equal(sql.includes("anonymised:"), false, `${entry.prismaModel} inlines a prefix`);

    const placeholders = new Set((sql.match(/\$\d+/g) ?? []).map((token) => Number(token.slice(1))));
    assert.equal(
      placeholders.size,
      values.length,
      `${entry.prismaModel}: ${placeholders.size} placeholders for ${values.length} values`
    );
    for (let index = 1; index <= values.length; index += 1) {
      assert.ok(placeholders.has(index), `${entry.prismaModel} skips placeholder $${index}`);
    }
  }
});

test("a unique column takes the row's own key, so anonymised rows cannot collide", () => {
  for (const entry of ACCOUNT_ANONYMISATIONS) {
    const { sql } = buildAnonymisationStatement(entry);
    for (const [column, replacement] of Object.entries(entry.columns)) {
      if (replacement.kind !== "perRow") continue;
      assert.match(
        sql,
        new RegExp(`"${column}" = \\$\\d+ \\|\\| "id"`),
        `${entry.prismaModel}.${column} does not interpolate the row key`
      );
    }
  }
});

test("the statement scopes itself to one account", () => {
  for (const entry of ACCOUNT_ANONYMISATIONS) {
    const { sql, userParameterIndex } = buildAnonymisationStatement(entry);
    assert.match(sql, new RegExp(`WHERE "${entry.userColumn}" = \\$${userParameterIndex}$`));
    assert.equal(/WHERE .* OR /.test(sql), false, "the predicate is wider than one account");
  }
});

test("an unsafe identifier in a declaration is refused rather than interpolated", () => {
  assert.throws(
    () =>
      buildAnonymisationStatement({
        prismaModel: "X",
        table: 'User"; DROP TABLE "User',
        userColumn: "userId",
        columns: { userId: { kind: "null" } },
      }),
    /Unsafe table name/
  );
  assert.throws(
    () =>
      buildAnonymisationStatement({
        prismaModel: "X",
        table: "User",
        userColumn: "userId",
        columns: { 'a" = "b': { kind: "null" } },
      }),
    /Unsafe column name/
  );
});

// Order is the whole correctness argument: three of these four relations are
// onDelete: SetNull, so after the User row is gone there is no userId left to
// match and the rows keep every identifier they had.
test("anonymisation runs before the user row is deleted", () => {
  const source = readFileSync(new URL("../lib/accountDeletion.ts", import.meta.url), "utf8");
  const anonymise = source.indexOf("anonymiseAccountData(tx");
  const deleteUser = source.indexOf("tx.user.delete");
  assert.ok(anonymise > 0, "account deletion does not anonymise anything");
  assert.ok(deleteUser > 0, "account deletion does not delete the user");
  assert.ok(anonymise < deleteUser, "anonymisation runs after the user row is already gone");
});
