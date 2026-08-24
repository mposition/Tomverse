// The vocabularies, the two clocks, and the refusal that protects a profile
// somebody built (Slice 5A).
//
// docs/policy/assistant-package-import.md §5.4, §5.5, §5.6.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    ASSISTANT_KNOWLEDGE_RESERVATION_STATES,
    ASSISTANT_PROFILE_IMPORT_LIMITS,
    ASSISTANT_PROFILE_IMPORT_MODES,
    ASSISTANT_PROFILE_IMPORT_STATUSES,
    computeImportExpiries,
    judgeCreateCleanup,
    mergeCleanupDeletesProfile,
} from "../lib/assistantProfileImportCore.ts";

const MIGRATION = readFileSync(
    new URL(
        "../prisma/migrations/20260823090000_assistant_package_import/migration.sql",
        import.meta.url
    ),
    "utf8"
);

const SCHEMA = readFileSync(
    new URL("../prisma/schema.prisma", import.meta.url),
    "utf8"
);

/* --------------------------------------------------------------- the clocks */

const at = (iso) => new Date(iso);

test("the absolute clock runs from creation and the idle clock from activity", () => {
    const expiries = computeImportExpiries({
        createdAt: at("2026-08-23T00:00:00Z"),
        lastUserActivityAt: at("2026-08-23T06:00:00Z"),
    });
    assert.equal(expiries.absoluteExpiresAt.toISOString(), "2026-08-26T00:00:00.000Z");
    assert.equal(expiries.idleExpiresAt.toISOString(), "2026-08-24T06:00:00.000Z");
});

test("the idle clock never outlives the absolute one", () => {
    // Without the clamp, an import touched an hour before its absolute expiry
    // would report a deadline a day away and then be swept while the screen
    // still said it had time.
    const expiries = computeImportExpiries({
        createdAt: at("2026-08-23T00:00:00Z"),
        lastUserActivityAt: at("2026-08-25T23:00:00Z"),
    });
    assert.equal(expiries.idleExpiresAt.toISOString(), "2026-08-26T00:00:00.000Z");
    assert.deepEqual(expiries.idleExpiresAt, expiries.absoluteExpiresAt);
});

test("the two ttls are separate numbers from the conversation import's", () => {
    assert.equal(ASSISTANT_PROFILE_IMPORT_LIMITS.stagingIdleTtlMs, 24 * 60 * 60 * 1000);
    assert.equal(
        ASSISTANT_PROFILE_IMPORT_LIMITS.stagingAbsoluteTtlMs,
        72 * 60 * 60 * 1000
    );
    assert.ok(
        ASSISTANT_PROFILE_IMPORT_LIMITS.stagingIdleTtlMs <
            ASSISTANT_PROFILE_IMPORT_LIMITS.stagingAbsoluteTtlMs
    );
});

/* ------------------------------------------------------- deleting a draft */

const safe = {
    importStatus: "staging",
    importMode: "create",
    importProfileId: "p1",
    profileId: "p1",
    profileCurrentVersionId: null,
    profileVersionCount: 0,
    otherImportsForProfile: 0,
};

test("a draft this import created and nothing published may be deleted", () => {
    assert.deepEqual(judgeCreateCleanup(safe), { outcome: "delete_profile" });
});

test("every single condition alone refuses the deletion", () => {
    // The asymmetry is the rule: deleting a profile cannot be undone, leaving
    // a draft for a person to look at can. So one mismatch refuses everything
    // rather than deleting what still looks safe.
    const mutations = [
        [{ importStatus: "published" }, "import_not_staging"],
        [{ importMode: "merge" }, "import_not_create_mode"],
        [{ importProfileId: "other" }, "profile_mismatch"],
        [{ profileCurrentVersionId: "v1" }, "profile_is_published"],
        [{ profileVersionCount: 1 }, "profile_has_versions"],
        [{ otherImportsForProfile: 1 }, "profile_has_other_imports"],
    ];
    for (const [mutation, reason] of mutations) {
        const verdict = judgeCreateCleanup({ ...safe, ...mutation });
        assert.equal(verdict.outcome, "refuse", JSON.stringify(mutation));
        assert.deepEqual(verdict.reasons, [reason]);
    }
});

test("a refusal names every reason, not the first one found", () => {
    const verdict = judgeCreateCleanup({
        ...safe,
        importMode: "merge",
        profileCurrentVersionId: "v1",
    });
    assert.deepEqual(verdict.reasons, [
        "import_not_create_mode",
        "profile_is_published",
    ]);
});

test("a merge import never deletes a profile", () => {
    assert.equal(mergeCleanupDeletesProfile(), false);
});

/* ------------------------------------------------- the schema and migration */

test("the migration bounds every vocabulary the code holds", () => {
    for (const value of ASSISTANT_PROFILE_IMPORT_MODES) {
        assert.match(MIGRATION, new RegExp(`'${value}'`));
    }
    for (const value of ASSISTANT_PROFILE_IMPORT_STATUSES) {
        assert.match(MIGRATION, new RegExp(`'${value}'`));
    }
    for (const value of ASSISTANT_KNOWLEDGE_RESERVATION_STATES) {
        assert.match(MIGRATION, new RegExp(`'${value}'`));
    }
    assert.match(MIGRATION, /AssistantProfileImport_mode_check/);
    assert.match(MIGRATION, /AssistantProfileImport_status_check/);
    assert.match(MIGRATION, /AssistantKnowledgeUploadReservation_state_check/);
});

test("the reservation's three claim columns are constrained together", () => {
    // A row holding a token while pending claims a claimant nobody took; a row
    // finalizing with no timestamp is one the stale sweep passes over forever.
    assert.match(
        MIGRATION,
        /AssistantKnowledgeUploadReservation_claim_agreement_check/
    );
});

/**
 * The migration's executable statements, with every `--` comment removed.
 *
 * The comments in this file quote the follow-up `VALIDATE CONSTRAINT` on
 * purpose -- an operator reading the migration should find the whole procedure
 * there. So a test that greps the raw text would be reading the explanation as
 * if it were the instruction, which is the opposite of what it is checking.
 */
const statements = MIGRATION.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

const statementAdding = (constraint) => {
    const found = statements.find(
        (statement) =>
            statement.includes(`ADD CONSTRAINT "${constraint}"`)
    );
    assert.ok(found, `no statement adds ${constraint}`);
    return found;
};

test("the new column's constraint is valid and the old column's is not", () => {
    // The distinction is the whole staged-migration procedure: a new column is
    // NULL on every existing row and can be checked at once, while an existing
    // column carries rows nobody has surveyed.
    assert.ok(
        !/NOT VALID/i.test(
            statementAdding("AssistantKnowledgeFile_extractedBytes_non_negative_check")
        )
    );
    assert.match(
        statementAdding(
            "AssistantKnowledgeFile_extractedCharacters_non_negative_check"
        ),
        /NOT VALID/i
    );
});

test("this migration does not validate anything", () => {
    // `prisma migrate deploy` applies every pending migration in one run, so a
    // VALIDATE here would validate the constraint in the same deploy that
    // added it -- before the survey it is supposed to wait for, and failing
    // the deploy outright if any historical row violates it. The validation is
    // a separate submission, and the comments in this file say so; what must
    // not appear is a statement.
    for (const statement of statements) {
        assert.ok(
            !/VALIDATE\s+CONSTRAINT/i.test(statement),
            `the staged migration must not carry a VALIDATE CONSTRAINT: ${statement}`
        );
    }
});

test("the isolation column exists on the file, and cascades", () => {
    assert.match(SCHEMA, /importId String\?/);
    assert.match(
        SCHEMA,
        /import\s+AssistantProfileImport\?\s+@relation\(fields: \[importId\], references: \[id\], onDelete: Cascade\)/
    );
    // Restrict would abort account deletion: User cascades into both the
    // import and the file with no ordering between them.
    assert.ok(!/references: \[id\], onDelete: Restrict/.test(SCHEMA));
});

test("the provenance row outlives the version it names", () => {
    // SetNull rather than Cascade: if the version goes by any route, the fact
    // that an import happened still has to be true.
    assert.match(
        SCHEMA,
        /version\s+AssistantProfileVersion\?\s+@relation\(fields: \[versionId\], references: \[id\], onDelete: SetNull\)/
    );
    assert.match(MIGRATION, /AssistantProfileImport_versionId_fkey[\s\S]{0,200}ON DELETE SET NULL/);
});
