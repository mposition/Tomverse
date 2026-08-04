// Read-only audit for the v2 image multi-model backfill (policy §14 of
// docs/policy/image-generation.md). Run BEFORE deploying the
// 20260804010000_image_multimodel_groups migration to record the input
// counts, and AFTER to verify the invariants. Never writes; recovery from a
// violation is forward repair, not rollback.
//
//   npx tsx scripts/audit-image-backfill.mjs        (uses DATABASE_URL)
//
// Pre-migration, the group/target tables do not exist yet: those sections
// report "not_migrated" instead of failing.

// The application's own client, not a bare `new PrismaClient()`: this project
// connects through a PrismaPg driver adapter, and a client constructed
// without one throws before it ever reaches a query.
import { prisma } from "../lib/prisma.ts";

const tableExists = async (name) => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public."${name}"') IS NOT NULL AS "exists"`
  );
  return Boolean(rows[0]?.exists);
};

const main = async () => {
  const migrated = await tableExists("ImageGenerationGroup");

  const [generations, generationsByStatus, reservations] = await Promise.all([
    prisma.imageGeneration.count().catch(() => null),
    prisma.$queryRawUnsafe(
      'SELECT "status", COUNT(*)::int AS "count" FROM "ImageGeneration" GROUP BY "status"'
    ),
    prisma.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS "total", COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "ImageGeneration" g WHERE g."id" = r."generationId"))::int AS "orphans" FROM "ImageCreditReservation" r'
    ),
  ]);

  const report = {
    auditedAt: new Date().toISOString(),
    migrated,
    generations: {
      total: generations,
      byStatus: Object.fromEntries(
        generationsByStatus.map((row) => [row.status, row.count])
      ),
    },
    reservations: {
      total: reservations[0]?.total ?? 0,
      orphans: reservations[0]?.orphans ?? 0,
    },
  };

  if (migrated) {
    const [groups, targets, violations, identity] = await Promise.all([
      prisma.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS "count" FROM "ImageGenerationGroup"'
      ),
      prisma.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS "count", COUNT("currentGenerationId")::int AS "withCurrent" FROM "ImageGenerationTarget"'
      ),
      prisma.$queryRawUnsafe(
        `SELECT
           (SELECT COUNT(*)::int FROM "ImageGeneration" g
             WHERE NOT EXISTS (SELECT 1 FROM "ImageGenerationTarget" t WHERE t."id" = g."targetId")) AS "generationsWithoutTarget",
           (SELECT COUNT(*)::int FROM "ImageGenerationTarget" t
             WHERE t."currentGenerationId" IS NULL) AS "targetsWithoutCurrentAttempt",
           (SELECT COUNT(*)::int FROM "ImageCreditReservation" r
             WHERE r."identitySource" NOT IN ('recorded', 'inferred_v1_backfill')) AS "unknownIdentitySources"`
      ),
      prisma.$queryRawUnsafe(
        'SELECT "identitySource", COUNT(*)::int AS "count" FROM "ImageCreditReservation" GROUP BY "identitySource"'
      ),
    ]);
    report.groups = { total: groups[0]?.count ?? 0 };
    report.targets = {
      total: targets[0]?.count ?? 0,
      withCurrentAttempt: targets[0]?.withCurrent ?? 0,
    };
    report.invariants = violations[0];
    report.reservationIdentity = Object.fromEntries(
      identity.map((row) => [row.identitySource, row.count])
    );
    report.ok =
      report.invariants.generationsWithoutTarget === 0 &&
      report.invariants.targetsWithoutCurrentAttempt === 0 &&
      report.invariants.unknownIdentitySources === 0;
  } else {
    report.groups = "not_migrated";
    report.targets = "not_migrated";
    report.ok = null;
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.ok === false) process.exitCode = 1;
};

main()
  .catch((error) => {
    console.error("Image backfill audit failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
