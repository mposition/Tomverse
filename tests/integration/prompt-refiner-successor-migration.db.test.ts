import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { computeAdminAuditEntryHash } from "@/lib/adminAuditIntegrityCore";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import {
    PROMPT_REFINER_RUNTIME_SOURCE_PATHS,
    buildPromptRefinerRuntimeSourceManifest,
    buildPromptRefinerStageAdmissionFacts,
    prefixedPromptRefinerDigest,
} from "@/lib/promptRefinerStageAdmissionCore";

const { Client } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIRECTORY = path.join(REPOSITORY_ROOT, "prisma", "migrations");
const SUCCESSOR_MIGRATION = "20260928130000_prompt_refiner_confirmatory_successor_v4";
const SUCCESSOR_MIGRATION_PATH = path.join(
    MIGRATIONS_DIRECTORY,
    SUCCESSOR_MIGRATION,
    "migration.sql"
);
const COMMIT_SHA = "75e6d901ddb6aad00b57dc27e6866241aa4d34c3";
const DEPLOYMENT_ID = "prompt-refiner-successor-upgrade-test";
const EVIDENCE_SPEC_DIGEST =
    "7794b9fbbd8fba1f16d19f935a977098f3f7a8d302014d6e7de3fe00813ae4c1";
const AUDIT_INTEGRITY_SECRET = "prompt-refiner-successor-upgrade-audit-fixture-key";

const LEGACY_STAGE_DIGESTS = Object.freeze({
    1: "sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f",
    2: "sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1",
    3: "sha256:3d1ed8d096a6c0530ee8a20b61b479c67fe8e658f4ebcd31062311ff2079ce72",
} as const);
const LEGACY_RUN_DIGESTS = Object.freeze({
    3: "sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280",
    4: "sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7",
    5: "sha256:774dd559f20a69c7c94f55b1204245b77dc93769771e6b5abd0f60c5099415fd",
} as const);

const PRESERVED_TABLES = Object.freeze([
    "AdminAuditLog",
    "PromptRefinerReservationStage",
    "PromptRefinerReservation",
    "PromptRefinerShadowRun",
    "PromptRefinerShadowAttempt",
] as const);

// This suite never exercises an application writer. It builds signed synthetic
// history only inside its owned scratch database so the migration can prove it
// preserves the real audit-chain bytes along with the four Refiner tables.

type PgClient = InstanceType<typeof Client>;
type LegacyStageVersion = keyof typeof LEGACY_STAGE_DIGESTS;
type LegacyRunVersion = keyof typeof LEGACY_RUN_DIGESTS;
type AuditChain = { previousHash: string | null; nextTimestampMs: number };

const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const testDatabaseUrl = (): URL => {
    const raw = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
    assert.ok(raw, "TEST_DATABASE_URL is required for the migration upgrade test");
    const url = new URL(raw);
    assert.ok(
        url.protocol === "postgres:" || url.protocol === "postgresql:",
        "the migration upgrade test requires PostgreSQL"
    );
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const schemaName = url.searchParams.get("schema") || "";
    assert.match(
        `${databaseName}_${schemaName}`,
        /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i,
        "the caller database or schema must carry an explicit test marker"
    );
    return url;
};

const scratchDatabaseName = (caller: URL): string => {
    const callerName = decodeURIComponent(caller.pathname.replace(/^\//, ""));
    const safePrefix = callerName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 29);
    const name = `${safePrefix}_test_refiner_${process.pid}_${randomBytes(4).toString("hex")}`;
    assert.match(name, /(?:^|_)test(?:_|$)/);
    assert.match(name, /^[a-z0-9_]{1,63}$/);
    return name;
};

const withDatabase = (source: URL, databaseName: string): string => {
    const target = new URL(source);
    target.pathname = `/${encodeURIComponent(databaseName)}`;
    target.searchParams.delete("schema");
    return target.toString();
};

const currentAdmissionFacts = () => {
    const files = new Map(
        PROMPT_REFINER_RUNTIME_SOURCE_PATHS.map((relativePath) => [
            relativePath,
            readFileSync(path.join(REPOSITORY_ROOT, relativePath)),
        ])
    );
    const source = buildPromptRefinerRuntimeSourceManifest({ commitSha: COMMIT_SHA, files });
    return buildPromptRefinerStageAdmissionFacts({
        runtimeCommitSha: COMMIT_SHA,
        runtimeDeploymentId: DEPLOYMENT_ID,
        runtimeEnvironment: "staging",
        runtimeSourceManifest: source.manifest,
        runtimeSourceIdentityDigest: source.sourceIdentityDigest,
        runtimeSourceManifestDigest: source.manifestDigest,
    });
};

const legacyStageFixture = (
    version: LegacyStageVersion,
    currentFacts: ReturnType<typeof currentAdmissionFacts>
) => {
    const removedPaths = new Set([
        "prisma/migrations/20260928130000_prompt_refiner_confirmatory_successor_v4/migration.sql",
        ...(version <= 2
            ? ["prisma/migrations/20260927130000_prompt_refiner_shadow_stage_successor_v3/migration.sql"]
            : []),
        ...(version === 1
            ? ["prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql"]
            : []),
    ]);
    const files = currentFacts.runtimeSourceManifest.files.filter(
        (entry) => !removedPaths.has(entry.path)
    );
    const runtimeSourceManifest = {
        schemaVersion: `prompt-refiner-runtime-source-manifest-v${version + 1}`,
        commitSha: currentFacts.runtimeCommitSha,
        totalSizeBytes: files.reduce((total, entry) => total + entry.sizeBytes, 0),
        files,
    };
    const executionManifest = structuredClone(currentFacts.executionManifest) as Record<
        string,
        unknown
    >;
    executionManifest.schemaVersion = `prompt-refiner-shadow-execution-manifest-v${version}`;
    executionManifest.stageId = `prompt-refiner-shadow-v${version}`;
    executionManifest.reservationContractDigest = LEGACY_STAGE_DIGESTS[version];
    executionManifest.runtimeSource = {
        fileCount: 186 + version,
        maxFileBytes: 8 * 1024 * 1024,
        maxTotalBytes: 16 * 1024 * 1024,
    };
    return {
        version,
        stageId: `prompt-refiner-shadow-v${version}`,
        contractDigest: LEGACY_STAGE_DIGESTS[version],
        admissionVersion: `prompt-refiner-stage-admission-v${version}`,
        runtimeSourceManifest,
        runtimeSourceIdentityDigest: prefixedPromptRefinerDigest({ files }),
        runtimeSourceManifestDigest: prefixedPromptRefinerDigest(runtimeSourceManifest),
        executionManifest,
        executionManifestDigest: prefixedPromptRefinerDigest(executionManifest),
        currentFacts,
    };
};

const applyBaselineMigrations = async (client: PgClient) => {
    const migrationDirectories = readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    assert.ok(migrationDirectories.includes(SUCCESSOR_MIGRATION));
    const baseline = migrationDirectories.filter((name) => name < SUCCESSOR_MIGRATION);
    assert.ok(baseline.length > 0);
    for (const migration of baseline) {
        const sql = readFileSync(path.join(MIGRATIONS_DIRECTORY, migration, "migration.sql"), "utf8");
        await client.query(sql);
    }
};

const insertAuditRow = async (
    client: PgClient,
    chain: AuditChain,
    input: {
        id: string;
        action: string;
        targetType: string;
        targetId: string;
        summary: string;
        metadata: Record<string, unknown>;
    }
) => {
    const createdAt = new Date(chain.nextTimestampMs++);
    const hashInput = {
        previousHash: chain.previousHash,
        actorUserId: null,
        actorEmail: "prompt-refiner-successor-upgrade@test.invalid",
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        summary: input.summary,
        metadata: input.metadata,
        ipAddress: "127.0.0.1",
        userAgent: "prompt-refiner-successor-upgrade-test",
        createdAt: createdAt.toISOString(),
    };
    const entryHash = computeAdminAuditEntryHash(hashInput, AUDIT_INTEGRITY_SECRET);
    await client.query(
        `
          INSERT INTO "AdminAuditLog" (
            "id", "actorUserId", "actorEmail", "action", "targetType", "targetId",
            "summary", "metadata", "ipAddress", "userAgent", "previousHash", "entryHash",
            "createdAt"
          ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
        `,
        [
            input.id,
            hashInput.actorEmail,
            input.action,
            input.targetType,
            input.targetId,
            input.summary,
            JSON.stringify(input.metadata),
            hashInput.ipAddress,
            hashInput.userAgent,
            chain.previousHash,
            entryHash,
            createdAt,
        ]
    );
    chain.previousHash = entryHash;
};

const insertAuditRows = async (
    client: PgClient,
    chain: AuditChain,
    version: LegacyStageVersion
) => {
    const runVersion = (version + 2) as LegacyRunVersion;
    for (const kind of ["stage", "run", "dispatch"] as const) {
        const targetType =
            kind === "stage"
                ? "PromptRefinerReservationStage"
                : kind === "run"
                  ? "PromptRefinerShadowRun"
                  : "PromptRefinerShadowAttempt";
        const targetId =
            kind === "stage"
                ? `prompt-refiner-shadow-v${version}`
                : kind === "run"
                  ? `legacy-shadow-run-v${runVersion}`
                  : `legacy-attempt-v${runVersion}`;
        await insertAuditRow(client, chain, {
            id: `legacy-v${version}-${kind}-audit`,
            action: `prompt_refiner.synthetic_${kind}`,
            targetType,
            targetId,
            summary: `Synthetic legacy v${version} ${kind} provenance for migration preservation.`,
            metadata: { fixture: "prompt-refiner-successor-upgrade", version, kind },
        });
    }
};

const insertLegacyPair = async (
    client: PgClient,
    auditChain: AuditChain,
    stage: ReturnType<typeof legacyStageFixture>,
    timestamp: Date
) => {
    const runVersion = (stage.version + 2) as LegacyRunVersion;
    const approvalExpiresAt = new Date(timestamp.getTime() + 60 * 60_000);
    const requestId = `legacy-request-v${stage.version}`;
    const reservationId = `legacy-reservation-v${stage.version}`;
    const runId = `legacy-shadow-run-v${runVersion}`;
    const attemptId = `legacy-attempt-v${runVersion}`;
    const reservationStatus = stage.version === 1 ? "expired" : stage.version === 2 ? "consumed" : "reserved";
    const reservationTerminalAt = new Date(timestamp.getTime() + 6 * 60_000);
    const runStatus = runVersion === 3 ? "stopped_unknown" : "running";
    const isTerminal = runVersion === 3;

    await insertAuditRows(client, auditChain, stage.version);
    await client.query(
        `
          INSERT INTO "PromptRefinerReservationStage" (
            "id", "contractVersion", "contractDigest", "status",
            "perRequestCostMicroUsd", "maxReservations", "costCeilingMicroUsd",
            "reservationCount", "allocatedCostMicroUsd", "admissionVersion",
            "proposalVersion", "proposalDigest", "evidenceBundleDigest",
            "evidenceManifestSha256", "historicalSourceRef",
            "historicalSourceIdentityDigest", "corpusDigest", "runtimeCommitSha",
            "runtimeSourceIdentityDigest", "runtimeSourceManifest",
            "runtimeSourceManifestDigest", "runtimeEnvironment", "runtimeDeploymentId",
            "executionManifest", "executionManifestDigest", "approvedBy", "approvedAt",
            "approvalExpiresAt", "authorizationAuditLogId", "createdAt", "updatedAt"
          ) VALUES (
            $1, 'prompt-refiner-execution-contract-v1', $2, $21,
            24916, 100, 2491600, 1, 24916, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13::jsonb, $14, 'staging', $15, $16::jsonb, $17,
            'mposition', $18, $19, $20, $18, $18
          )
        `,
        [
            stage.stageId,
            stage.contractDigest,
            stage.admissionVersion,
            stage.currentFacts.proposalVersion,
            stage.currentFacts.proposalDigest,
            stage.currentFacts.evidenceBundleDigest,
            stage.currentFacts.evidenceManifestSha256,
            stage.currentFacts.historicalSourceRef,
            stage.currentFacts.historicalSourceIdentityDigest,
            stage.currentFacts.corpusDigest,
            stage.currentFacts.runtimeCommitSha,
            stage.runtimeSourceIdentityDigest,
            JSON.stringify(stage.runtimeSourceManifest),
            stage.runtimeSourceManifestDigest,
            stage.currentFacts.runtimeDeploymentId,
            JSON.stringify(stage.executionManifest),
            stage.executionManifestDigest,
            timestamp,
            approvalExpiresAt,
            `legacy-v${stage.version}-stage-audit`,
            stage.version === 3 ? "approved" : "closed",
        ]
    );
    if (isTerminal) {
        await insertAuditRow(client, auditChain, {
            id: `legacy-v${stage.version}-terminal-audit`,
            action: "prompt_refiner.synthetic_terminal",
            targetType: "PromptRefinerShadowAttempt",
            targetId: attemptId,
            summary: "Synthetic terminal legacy receipt for migration preservation.",
            metadata: { fixture: "prompt-refiner-successor-upgrade", terminal: true },
        });
    }
    await client.query(
        `
          INSERT INTO "PromptRefinerReservation" (
            "id", "stageId", "requestId", "contractDigest", "status",
            "reservedCostMicroUsd", "expiresAt", "consumedAt", "releasedAt",
            "expiredAt", "createdAt", "updatedAt"
          ) VALUES ($1, $2, $3, $4, $5, 24916, $6, $7, NULL, $8, $9, $10)
        `,
        [
            reservationId,
            stage.stageId,
            requestId,
            stage.contractDigest,
            reservationStatus,
            new Date(timestamp.getTime() + 5 * 60_000),
            stage.version === 2 ? reservationTerminalAt : null,
            stage.version === 1 ? reservationTerminalAt : null,
            timestamp,
            reservationStatus === "reserved" ? timestamp : reservationTerminalAt,
        ]
    );
    await client.query(
        `
          INSERT INTO "PromptRefinerShadowRun" (
            "id", "stageId", "runContractVersion", "runContractDigest", "corpusDigest",
            "evidenceSpecDigest", "adapterVersion", "status", "perRequestCostMicroUsd",
            "maxDispatches", "costCeilingMicroUsd", "dispatchCount", "terminalCount",
            "knownActualCostMicroUsd", "runtimeCommitSha", "runtimeDeploymentId",
            "runtimeSourceManifest", "runtimeSourceManifestDigest", "previewBindingDigest",
            "approvedBy", "approvedAt", "approvalExpiresAt", "authorizationAuditLogId",
            "startedAt", "completedAt", "stoppedAt", "stopReason", "createdAt", "updatedAt"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, 'prompt-refiner-openai-sdk-adapter-v1', $7,
            24916, 16, 398656, 1, $8, 0, $9, $10, $11::jsonb, $12, $13,
            'mposition', $14, $15, $16, $17, NULL, $18, $19, $20, $20
          )
        `,
        [
            runId,
            stage.stageId,
            `prompt-refiner-shadow-run-v${runVersion}`,
            LEGACY_RUN_DIGESTS[runVersion],
            stage.currentFacts.corpusDigest,
            runVersion === 3 ? null : EVIDENCE_SPEC_DIGEST,
            runStatus,
            isTerminal ? 1 : 0,
            stage.currentFacts.runtimeCommitSha,
            stage.currentFacts.runtimeDeploymentId,
            JSON.stringify(stage.runtimeSourceManifest),
            stage.runtimeSourceManifestDigest,
            `sha256:${String(runVersion).repeat(64)}`,
            timestamp,
            approvalExpiresAt,
            `legacy-v${stage.version}-run-audit`,
            timestamp,
            isTerminal ? new Date(timestamp.getTime() + 2_000) : null,
            isTerminal ? "unknown_after_dispatch" : null,
            new Date(timestamp.getTime() + 1_000),
        ]
    );
    await client.query(
        `
          INSERT INTO "PromptRefinerShadowAttempt" (
            "id", "runId", "reservationId", "requestId", "caseId", "caseIndex",
            "stageId", "reservationContractDigest", "runContractDigest", "provider",
            "modelId", "adapterVersion", "status", "terminalReason", "failureLayer",
            "failureCode", "dispatchIntentAt", "terminalAt", "durationMs",
            "dispatchAuditLogId", "terminalAuditLogId", "evidence", "createdAt", "updatedAt"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, 'openai', 'gpt-5-6-luna',
            'prompt-refiner-openai-sdk-adapter-v1', $10, $11, $12, $13, $14, $15,
            $16, $17, $18, NULL, $14, $19
          )
        `,
        [
            attemptId,
            runId,
            reservationId,
            requestId,
            `legacy-case-v${runVersion}`,
            stage.version - 1,
            stage.stageId,
            stage.contractDigest,
            LEGACY_RUN_DIGESTS[runVersion],
            isTerminal ? "terminal" : "dispatch_intent",
            isTerminal ? "unknown_after_dispatch" : null,
            isTerminal ? "provider" : null,
            isTerminal ? "synthetic_unknown" : null,
            new Date(timestamp.getTime() + 1_000),
            isTerminal ? new Date(timestamp.getTime() + 2_000) : null,
            isTerminal ? 1_000 : null,
            `legacy-v${stage.version}-dispatch-audit`,
            isTerminal ? `legacy-v${stage.version}-terminal-audit` : null,
            isTerminal ? new Date(timestamp.getTime() + 2_000) : new Date(timestamp.getTime() + 1_000),
        ]
    );
};

const assertAuditChain = async (client: PgClient) => {
    const result = await client.query<{
        previousHash: string | null;
        entryHash: string;
        actorUserId: string | null;
        actorEmail: string | null;
        action: string;
        targetType: string;
        targetId: string | null;
        summary: string;
        metadata: unknown;
        ipAddress: string | null;
        userAgent: string | null;
        createdAt: Date;
    }>(
        `
          SELECT "previousHash", "entryHash", "actorUserId", "actorEmail", "action",
                 "targetType", "targetId", "summary", "metadata", "ipAddress", "userAgent",
                 "createdAt"
          FROM "AdminAuditLog"
          ORDER BY "createdAt", "id"
        `
    );
    let previousHash: string | null = null;
    for (const row of result.rows) {
        assert.equal(row.previousHash, previousHash);
        assert.equal(
            row.entryHash,
            computeAdminAuditEntryHash(
                {
                    previousHash,
                    actorUserId: row.actorUserId,
                    actorEmail: row.actorEmail,
                    action: row.action,
                    targetType: row.targetType,
                    targetId: row.targetId,
                    summary: row.summary,
                    metadata: row.metadata,
                    ipAddress: row.ipAddress,
                    userAgent: row.userAgent,
                    createdAt: row.createdAt.toISOString(),
                },
                AUDIT_INTEGRITY_SECRET
            )
        );
        previousHash = row.entryHash;
    }
    assert.equal(result.rowCount, 10);
};

const tableSnapshot = async (client: PgClient, table: (typeof PRESERVED_TABLES)[number]) => {
    const result = await client.query<{ row: unknown }>(
        `SELECT to_jsonb(row_value) AS row FROM ${quoteIdentifier(table)} AS row_value ORDER BY "id"`
    );
    const canonical = canonicalBenchmarkJson(result.rows.map(({ row }) => row));
    return {
        rowCount: result.rowCount,
        canonical,
        digest: createHash("sha256").update(canonical).digest("hex"),
    };
};

const preservedSnapshot = async (client: PgClient) =>
    Object.fromEntries(
        await Promise.all(PRESERVED_TABLES.map(async (table) => [table, await tableSnapshot(client, table)]))
    );

const assertMalformedCurrentStageRefused = async (
    client: PgClient,
    facts: ReturnType<typeof currentAdmissionFacts>,
    manifest: Record<string, unknown>,
    label: string
) => {
    const manifestDigest = prefixedPromptRefinerDigest(manifest);
    await client.query(`SAVEPOINT ${quoteIdentifier(label)}`);
    await assert.rejects(
        client.query(
            `
              INSERT INTO "PromptRefinerReservationStage" (
                "id", "contractVersion", "contractDigest", "status",
                "perRequestCostMicroUsd", "maxReservations", "costCeilingMicroUsd",
                "reservationCount", "allocatedCostMicroUsd", "admissionVersion",
                "proposalVersion", "proposalDigest", "evidenceBundleDigest",
                "evidenceManifestSha256", "historicalSourceRef",
                "historicalSourceIdentityDigest", "corpusDigest", "runtimeCommitSha",
                "runtimeSourceIdentityDigest", "runtimeSourceManifest",
                "runtimeSourceManifestDigest", "runtimeEnvironment", "runtimeDeploymentId",
                "executionManifest", "executionManifestDigest", "approvedBy", "approvedAt",
                "approvalExpiresAt", "authorizationAuditLogId", "createdAt", "updatedAt"
              ) VALUES (
                'prompt-refiner-shadow-v4', 'prompt-refiner-execution-contract-v1',
                'sha256:681c85cfd79b6e1fff2a2857dfbbd9166f7691848b4415eee231a587cca9ad0f',
                'approved', 24916, 100, 2491600, 0, 0, 'prompt-refiner-stage-admission-v4',
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, 'staging', $12,
                $13::jsonb, $14, 'mposition', $15, $16, 'legacy-v3-stage-audit', $15, $15
              )
            `,
            [
                facts.proposalVersion,
                facts.proposalDigest,
                facts.evidenceBundleDigest,
                facts.evidenceManifestSha256,
                facts.historicalSourceRef,
                facts.historicalSourceIdentityDigest,
                facts.corpusDigest,
                facts.runtimeCommitSha,
                facts.runtimeSourceIdentityDigest,
                JSON.stringify(manifest),
                manifestDigest,
                facts.runtimeDeploymentId,
                JSON.stringify(facts.executionManifest),
                facts.executionManifestDigest,
                new Date("2026-09-28T00:00:00.000Z"),
                new Date("2026-09-28T01:00:00.000Z"),
            ]
        ),
        /PromptRefinerReservationStage_runtime_identity_check/
    );
    await client.query(`ROLLBACK TO SAVEPOINT ${quoteIdentifier(label)}`);
};

test(
    "the additive v4/v6 successor migration preserves three legacy pairs byte-for-byte",
    { timeout: 180_000 },
    async (t) => {
        const callerUrl = testDatabaseUrl();
        const databaseName = scratchDatabaseName(callerUrl);
        const admin = new Client({ connectionString: callerUrl.toString() });
        const scratch = new Client({ connectionString: withDatabase(callerUrl, databaseName) });
        let created = false;
        try {
            await admin.connect();
            await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);
            created = true;
            await scratch.connect();
            await scratch.query("SET TIME ZONE 'UTC'");
            await applyBaselineMigrations(scratch);

            const facts = currentAdmissionFacts();
            await scratch.query('ALTER TABLE "PromptRefinerReservationStage" DISABLE TRIGGER USER');
            await scratch.query('ALTER TABLE "PromptRefinerReservation" DISABLE TRIGGER USER');
            await scratch.query('ALTER TABLE "PromptRefinerShadowRun" DISABLE TRIGGER USER');
            await scratch.query('ALTER TABLE "PromptRefinerShadowAttempt" DISABLE TRIGGER USER');
            const auditChain: AuditChain = {
                previousHash: null,
                nextTimestampMs: Date.parse("2026-09-24T00:00:00.000Z"),
            };
            for (const version of [1, 2, 3] as const) {
                await insertLegacyPair(
                    scratch,
                    auditChain,
                    legacyStageFixture(version, facts),
                    new Date(`2026-09-${23 + version}T00:00:00.000Z`)
                );
            }
            await scratch.query('ALTER TABLE "PromptRefinerShadowAttempt" ENABLE TRIGGER USER');
            await scratch.query('ALTER TABLE "PromptRefinerShadowRun" ENABLE TRIGGER USER');
            await scratch.query('ALTER TABLE "PromptRefinerReservation" ENABLE TRIGGER USER');
            await scratch.query('ALTER TABLE "PromptRefinerReservationStage" ENABLE TRIGGER USER');
            await assertAuditChain(scratch);

            const before = await preservedSnapshot(scratch);
            assert.deepEqual(
                Object.fromEntries(
                    PRESERVED_TABLES.map((table) => [table, before[table].rowCount])
                ),
                {
                    AdminAuditLog: 10,
                    PromptRefinerReservationStage: 3,
                    PromptRefinerReservation: 3,
                    PromptRefinerShadowRun: 3,
                    PromptRefinerShadowAttempt: 3,
                }
            );

            const migrationSql = readFileSync(SUCCESSOR_MIGRATION_PATH, "utf8");
            assert.doesNotMatch(
                migrationSql,
                /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(?:AdminAuditLog|PromptRefinerReservationStage|PromptRefinerReservation|PromptRefinerShadowRun|PromptRefinerShadowAttempt)"/im
            );
            await scratch.query(migrationSql);

            const after = await preservedSnapshot(scratch);
            assert.deepEqual(after, before);
            for (const table of PRESERVED_TABLES) {
                t.diagnostic(
                    `${table}: before=${before[table].rowCount}/${before[table].digest} ` +
                        `after=${after[table].rowCount}/${after[table].digest} exactBytesEqual=true`
                );
            }
            await assertAuditChain(scratch);

            const validator = await scratch.query<{
                current_valid: boolean;
                sql_null_is_null: boolean;
                missing_is_false: boolean;
                json_null_is_false: boolean;
            }>(
                `
                  SELECT
                    "prompt_refiner_runtime_manifest_valid"($1::jsonb, $2, $3, $4) AS current_valid,
                    "prompt_refiner_runtime_manifest_valid"(NULL::jsonb, $2, $3, $4) IS NULL
                      AS sql_null_is_null,
                    "prompt_refiner_runtime_manifest_valid"(
                      ($1::jsonb - 'totalSizeBytes'), $2, $3, $5
                    ) IS FALSE
                      AS missing_is_false,
                    "prompt_refiner_runtime_manifest_valid"(
                      jsonb_set($1::jsonb, '{totalSizeBytes}', 'null'::jsonb), $2, $3, $6
                    ) IS FALSE AS json_null_is_false
                `,
                [
                    JSON.stringify(facts.runtimeSourceManifest),
                    facts.runtimeCommitSha,
                    facts.runtimeSourceIdentityDigest,
                    facts.runtimeSourceManifestDigest,
                    prefixedPromptRefinerDigest(
                        Object.fromEntries(
                            Object.entries(facts.runtimeSourceManifest).filter(
                                ([key]) => key !== "totalSizeBytes"
                            )
                        )
                    ),
                    prefixedPromptRefinerDigest({
                        ...facts.runtimeSourceManifest,
                        totalSizeBytes: null,
                    }),
                ]
            );
            assert.deepEqual(validator.rows[0], {
                current_valid: true,
                sql_null_is_null: true,
                missing_is_false: true,
                json_null_is_false: true,
            });

            await scratch.query("BEGIN");
            await scratch.query('ALTER TABLE "PromptRefinerReservationStage" DISABLE TRIGGER USER');
            const missing = structuredClone(facts.runtimeSourceManifest) as unknown as Record<
                string,
                unknown
            >;
            delete missing.totalSizeBytes;
            await assertMalformedCurrentStageRefused(scratch, facts, missing, "missing_manifest_key");
            await assertMalformedCurrentStageRefused(
                scratch,
                facts,
                { ...facts.runtimeSourceManifest, totalSizeBytes: null },
                "json_null_manifest_key"
            );
            await scratch.query("ROLLBACK");

            await scratch.query("BEGIN");
            const closedStage = await scratch.query<{ status: string }>(
                `
                  UPDATE "PromptRefinerReservationStage"
                  SET "status" = 'closed', "updatedAt" = "updatedAt"
                  WHERE "id" = 'prompt-refiner-shadow-v3'
                  RETURNING "status"
                `
            );
            assert.equal(closedStage.rows[0]?.status, "closed");
            const expiredReservation = await scratch.query<{
                status: string;
                expiredAt: Date | null;
            }>(
                `
                  UPDATE "PromptRefinerReservation"
                  SET "status" = 'expired'
                  WHERE "id" = 'legacy-reservation-v3'
                  RETURNING "status", "expiredAt"
                `
            );
            assert.equal(expiredReservation.rows[0]?.status, "expired");
            assert.ok(expiredReservation.rows[0]?.expiredAt);
            const accounting = await scratch.query<{
                reservationCount: number;
                allocatedCostMicroUsd: string;
            }>(
                `
                  SELECT "reservationCount", "allocatedCostMicroUsd"
                  FROM "PromptRefinerReservationStage"
                  WHERE "id" = 'prompt-refiner-shadow-v3'
                `
            );
            assert.deepEqual(accounting.rows[0], {
                reservationCount: 1,
                allocatedCostMicroUsd: "24916",
            });

            await scratch.query('SAVEPOINT "immutable_legacy_provenance"');
            await assert.rejects(
                scratch.query(
                    `
                      UPDATE "PromptRefinerReservationStage"
                      SET "runtimeDeploymentId" = 'rewritten-deployment'
                      WHERE "id" = 'prompt-refiner-shadow-v2'
                    `
                ),
                /contract is immutable/
            );
            await scratch.query('ROLLBACK TO SAVEPOINT "immutable_legacy_provenance"');

            await scratch.query('SAVEPOINT "terminal_legacy_rewrite"');
            await assert.rejects(
                scratch.query(
                    `
                      UPDATE "PromptRefinerReservation"
                      SET "status" = 'released'
                      WHERE "id" = 'legacy-reservation-v1'
                    `
                ),
                /already terminal/
            );
            await scratch.query('ROLLBACK TO SAVEPOINT "terminal_legacy_rewrite"');

            await scratch.query('SAVEPOINT "fresh_legacy_insert"');
            await assert.rejects(
                scratch.query(
                    `
                      INSERT INTO "PromptRefinerReservationStage"
                      SELECT * FROM "PromptRefinerReservationStage"
                      WHERE "id" = 'prompt-refiner-shadow-v3'
                    `
                ),
                /v4 must start with zero accounting and approved status/
            );
            await scratch.query('ROLLBACK TO SAVEPOINT "fresh_legacy_insert"');
            await scratch.query("ROLLBACK");
        } finally {
            await scratch.end().catch(() => undefined);
            if (created) {
                assert.match(databaseName, /(?:^|_)test(?:_|$)/);
                await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
            }
            await admin.end().catch(() => undefined);
        }
    }
);
