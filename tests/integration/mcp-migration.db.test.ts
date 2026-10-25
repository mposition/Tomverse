import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";
test("MCP migration applies additively and its foreign keys cascade in a disposable transaction", async () => {
  const url = process.env.DATABASE_URL || "";
  assert.ok(url.includes("127.0.0.1:56439") && url.includes("mcp_preview_test"), "disposable DB only");
  const client = new Client({ connectionString: url }); await client.connect();
  try {
    await client.query("BEGIN");
    await client.query('CREATE SCHEMA mcp_migration_test');
    await client.query('SET LOCAL search_path TO mcp_migration_test');
    await client.query('CREATE TABLE "User" ("id" TEXT PRIMARY KEY)');
    await client.query(readFileSync(new URL("../../prisma/migrations/20261025110000_mcp_connector_preview/migration.sql", import.meta.url), "utf8"));
    await client.query('INSERT INTO "User" VALUES (\'local-only-user\')');
    await client.query('INSERT INTO "McpConnection" ("id","userId","serverId","policyDigest","catalog","updatedAt") VALUES (\'connection\',\'local-only-user\',\'synthetic\',\'digest\',\'[]\',CURRENT_TIMESTAMP)');
    await client.query('INSERT INTO "McpInvocation" ("id","userId","connectionId","connectionVersion","toolName","expiresAt","updatedAt") VALUES (\'action\',\'local-only-user\',\'connection\',1,\'create_note\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)');
    await client.query('DELETE FROM "User"');
    assert.equal((await client.query('SELECT count(*) FROM "McpConnection"')).rows[0].count, "0");
    assert.equal((await client.query('SELECT count(*) FROM "McpInvocation"')).rows[0].count, "0");
    await client.query('INSERT INTO "User" VALUES (\'oauth-user\')');
    await client.query('INSERT INTO "McpOAuthFlow" ("id","userId","serverId","policyDigest","stateHash","redirectUri","expiresAt") VALUES (\'flow\',\'oauth-user\',\'synthetic\',\'digest\',\'hash\',\'http://127.0.0.1/callback\',CURRENT_TIMESTAMP)');
    await client.query('DELETE FROM "User"');
    assert.equal((await client.query('SELECT count(*) FROM "McpOAuthFlow"')).rows[0].count, "0");
  } finally { await client.query("ROLLBACK"); await client.end(); }
});
