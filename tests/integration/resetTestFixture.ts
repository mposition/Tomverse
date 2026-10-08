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
  const raw = process.env.TEST_DATABASE_URL?.trim();
  const active = process.env.DATABASE_URL?.trim();
  if (!raw || !active || raw !== active) {
    throw new Error("Fixture reset requires the exact test database URL");
  }
  const target = new URL(raw);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ""));
  const table = '"[A-Za-z_][A-Za-z0-9_]*"';
  const truncate = new RegExp(
    `^TRUNCATE\\s+TABLE\\s+${table}(?:\\s*,\\s*${table})*\\s+RESTART\\s+IDENTITY\\s+CASCADE$`,
    "i",
  );
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name) ||
      target.search !== "" ||
      !truncate.test(statement.trim())) {
    throw new Error("Fixture reset is limited to loopback test databases and TRUNCATE CASCADE");
  }
  try {
    await prisma.$transaction(async (tx) => {
      // Verify the database name on this exact connection. The URL guard
      // excludes connection overrides, while this catches a client configured
      // for a differently named database.
      const [backend] = await tx.$queryRawUnsafe<Array<{ database: string }>>(
        'SELECT current_database() AS "database"',
      );
      if (!backend || backend.database !== name) {
        throw new Error("Fixture reset requires the exact test database backend");
      }
      // SET LOCAL reverts automatically at COMMIT/ROLLBACK. It is not inherited
      // by any later assertion, including tests of the append-only guards.
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRawUnsafe(statement);
    }, { timeout: 30_000 });
  } catch (error) {
    if (error instanceof Error && /permission denied.*session_replication_role/i.test(error.message)) {
      throw new Error("Fixture reset requires a superuser on the disposable test database", { cause: error });
    }
    throw error;
  }
}
