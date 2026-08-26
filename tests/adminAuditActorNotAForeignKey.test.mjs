import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * That nothing but the write which created an audit row can rewrite it.
 *
 * `AdminAuditLog.actorUserId` is part of the row's HMAC input and used to be a
 * foreign key with ON DELETE SET NULL. Deleting a user therefore made the
 * database null that column on every audit row that user had written, with no
 * application code involved, and the chain reported those rows exactly as it
 * reports a forged one.
 *
 * Staging showed it on 2026-08-26: eight rows written in one five-minute
 * window on 2026-07-29, all carrying a null `actorUserId` beside a surviving
 * `actorEmail`, all failing verification. That pair cannot be written -- every
 * audit-writing admin route guards on `session.user.id` first -- so the
 * database had set it afterwards.
 */

const ROOT = resolve(import.meta.dirname, "..");
const schema = readFileSync(resolve(ROOT, "prisma", "schema.prisma"), "utf8");
const model = schema.slice(
    schema.indexOf("model AdminAuditLog {"),
    schema.indexOf("}", schema.indexOf("model AdminAuditLog {"))
);

test("the audit row's actor is a plain column, not a relation", () => {
    assert.ok(model.includes("actorUserId"), "the column itself stays: it records who acted");
    assert.ok(
        !/@relation/.test(model),
        "a relation on this table gives the database a way to rewrite a signed row"
    );
    assert.ok(
        !/adminAuditLogs\s+AdminAuditLog\[\]/.test(schema),
        "the back-relation would restore the foreign key"
    );
});

test("no referential action may touch a hashed column", () => {
    // The specific hazard, stated as itself rather than as "no relation":
    // Cascade would delete the evidence and SetNull rewrites it. Either makes
    // the chain unable to tell an operator what it exists to tell them.
    assert.ok(
        !/onDelete:\s*(SetNull|Cascade)/.test(model),
        "a referential action on an audit row is a way to lose audit evidence"
    );
});

test("a migration drops the constraint, and preserves the rows", () => {
    const migrations = readdirSync(resolve(ROOT, "prisma", "migrations"));
    const dir = migrations.find((name) =>
        name.endsWith("_admin_audit_actor_not_a_foreign_key")
    );
    assert.ok(dir, "the schema change needs a migration to reach a deployed database");

    const sql = readFileSync(
        resolve(ROOT, "prisma", "migrations", dir, "migration.sql"),
        "utf8"
    );
    assert.match(sql, /DROP CONSTRAINT "AdminAuditLog_actorUserId_fkey"/);
    // Nothing else. Re-hashing a broken row would make the checker pass by
    // editing what it checks, and dropping the column would discard the actor
    // the surviving rows still name.
    assert.ok(
        !/UPDATE\s+"AdminAuditLog"|DELETE\s+FROM\s+"AdminAuditLog"|DROP COLUMN/i.test(sql),
        "the migration must not touch a single row or column"
    );
});

test("every audit-writing admin route requires an actor id first", () => {
    // What makes the null a proof rather than a guess: if a route could write
    // one, a null `actorUserId` beside an email would be an ordinary row.
    const routes = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = resolve(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith(".ts")) {
                const source = readFileSync(path, "utf8");
                if (source.includes("writeAdminAuditLog")) routes.push([path, source]);
            }
        }
    };
    walk(resolve(ROOT, "app", "api", "admin"));
    assert.ok(routes.length > 0, "there must be audit-writing routes to check");
    const unguarded = routes
        .filter(([, source]) => !source.includes("session?.user?.id"))
        .map(([path]) => path.slice(ROOT.length + 1));
    assert.deepEqual(unguarded, [], "these could write an audit row with no actor id");
});
