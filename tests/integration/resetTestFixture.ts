import type { PrismaClient } from "@prisma/client";

/**
 * Clear a disposable integration fixture without weakening production's
 * append-only triggers. TRUNCATE ... CASCADE can reach unrelated protected
 * history tables through audit foreign keys, even when they are empty.
 */
export async function resetTestFixture(
  prisma: PrismaClient,
  statement: string,
): Promise<void> {
  const raw = process.env.TEST_DATABASE_URL;
  const active = process.env.DATABASE_URL;
  if (!raw || !active || raw !== active) {
    throw new Error("Fixture reset requires the exact test database URL");
  }
  const target = new URL(raw);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!['localhost', '127.0.0.1'].includes(target.hostname) ||
      !/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name) ||
      !/^TRUNCATE TABLE [\s\S]+ CASCADE\s*$/i.test(statement.trim())) {
    throw new Error("Fixture reset is limited to loopback test databases and TRUNCATE CASCADE");
  }
  await prisma.$transaction(async (tx) => {
    // SET LOCAL reverts automatically at COMMIT/ROLLBACK. It is not inherited
    // by any later assertion, including tests of the append-only guards.
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRawUnsafe(statement);
  }, { timeout: 30_000 });
}
