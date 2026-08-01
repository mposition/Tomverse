import { disconnectAdminFixtureDatabase } from "./database";

/**
 * Closes the fixture connection pool. Without this the Playwright process
 * keeps an open PostgreSQL socket and does not exit after the last test.
 */
export default async function globalTeardown() {
  await disconnectAdminFixtureDatabase();
}
