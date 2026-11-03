// The CLI model catalog store (owner decision 2026-10-27): the exact
// statements each operation sends, counted on a recording transaction,
// because the AMUX DB boundaries budget them. What the database itself
// refuses is exercised in tests/integration/amux-cli-model-catalog.db.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import {
  AmuxCliModelLinkWriteError,
  readAmuxCliModelCatalogForAdmin,
  recordAmuxCliModelLinkByOwner,
  recordAmuxCliModelRefresh,
} from "../lib/amux/cliModelCatalogStore.ts";

const recordingTx = ({ newest = [], target = { catalogDeleted: false } } = {}) => {
  const sent = [];
  const tx = {
    $executeRaw: (strings, ...values) => {
      sent.push({ kind: "execute", sql: strings.join("$"), values });
      return Promise.resolve(1);
    },
    $queryRaw: (strings, ...values) => {
      const sql = strings.join("$");
      sent.push({ kind: "query", sql, values });
      if (sql.includes("AT TIME ZONE 'UTC'")) return Promise.resolve([{ createdAt: new Date("2026-10-27T00:00:00.000Z") }]);
      if (sql.includes('FROM "AmuxCliModelLinkEvent"') && sql.includes("LIMIT 1")) return Promise.resolve(newest);
      if (sql.includes('FROM "AmuxCliModelLinkEvent"')) {
        return Promise.resolve([{ cli: "cursor", cliModel: "claude-opus-5-5-high", pricedModelId: "claude-opus-5-5" }]);
      }
      if (sql.includes('FROM "AmuxCliModel"')) {
        return Promise.resolve([{ cli: "cursor", cliModel: "claude-opus-5-5-high", displayName: null, listed: true, lastSeenAtMs: 1_793_000_000_000n }]);
      }
      return Promise.reject(new Error(`unexpected statement: ${sql}`));
    },
    modelRegistryEntry: {
      findMany: (query) => {
        sent.push({ kind: "findMany", query });
        return Promise.resolve([{ id: "claude-opus-5-5", name: "Claude Opus 5.5", apiModel: "claude-opus-5-5", provider: "anthropic",
          catalogDeleted: false, enabled: true, status: "enabled", replacementModelId: null }]);
      },
      findUnique: (query) => {
        sent.push({ kind: "findUnique", query });
        return Promise.resolve(target);
      },
    },
    adminAuditLog: {
      findFirst: (query) => {
        sent.push({ kind: "findFirst", query });
        return Promise.resolve(null);
      },
      create: (query) => {
        sent.push({ kind: "create", data: query.data });
        return Promise.resolve({ id: "audit-row-1" });
      },
    },
  };
  return { tx, sent };
};

const SESSION = { user: { id: "owner-1", email: "owner@example.test" } };

test("the Admin read is three statements, within its boundary with setup and fence", async () => {
  const { tx, sent } = recordingTx();
  const view = await readAmuxCliModelCatalogForAdmin(tx);
  assert.equal(sent.length, 3);
  assert.deepEqual(AMUX_DB_BOUNDARIES.cliModelCatalogRead, { operation: "cli_model_catalog_read", prismaCallCeiling: sent.length + 2, isolation: "read" });
  assert.equal(view.refreshedAt.cursor, new Date(1_793_000_000_000).toISOString());
  assert.deepEqual(view.entries[0].link, { pricedModelId: "claude-opus-5-5" });
});

test("an owner's link is the chain lock, two reads, the audit and the insert, in order", async () => {
  const { tx, sent } = recordingTx();
  const record = await recordAmuxCliModelLinkByOwner(tx, { session: SESSION, cli: "cursor", cliModel: "claude-opus-5-5-high", pricedModelId: "claude-opus-5-5" });
  assert.equal(record.pricedModelId, "claude-opus-5-5");
  const kinds = sent.map((entry) => entry.kind);
  assert.equal(kinds.at(-1), "execute");
  assert.match(sent.at(-1).sql, /INSERT INTO "AmuxCliModelLinkEvent"/);
  assert.ok(sent.some((entry) => entry.kind === "create" && entry.data.action === "amux.cli_model.link"));
  assert.ok(sent.length + 2 <= AMUX_DB_BOUNDARIES.cliModelLinkChange.prismaCallCeiling, `sent ${sent.length}`);
  // The audit row is written before the event that names it.
  assert.ok(kinds.indexOf("create") < kinds.lastIndexOf("execute"));
});

test("a refused link writes nothing: bad shape, the same link again, a missing or retired model", async () => {
  const bad = recordingTx();
  await assert.rejects(recordAmuxCliModelLinkByOwner(bad.tx, { session: SESSION, cli: "devin", cliModel: "x", pricedModelId: null }),
    (error) => error instanceof AmuxCliModelLinkWriteError && error.code === "invalid_change");
  assert.equal(bad.sent.length, 0);
  for (const [options, code] of [
    [{ newest: [{ pricedModelId: "claude-opus-5-5" }] }, "no_change"],
    [{ target: null }, "model_not_found"],
    [{ target: { catalogDeleted: true } }, "model_not_found"],
  ]) {
    const { tx, sent } = recordingTx(options);
    await assert.rejects(recordAmuxCliModelLinkByOwner(tx, { session: SESSION, cli: "cursor", cliModel: "x", pricedModelId: "claude-opus-5-5" }),
      (error) => error instanceof AmuxCliModelLinkWriteError && error.code === code);
    assert.equal(sent.some((entry) => entry.kind === "create" || entry.kind === "execute" && /INSERT/.test(entry.sql)), false, code);
  }
  // Holding a name needs no target model.
  const hold = recordingTx();
  await recordAmuxCliModelLinkByOwner(hold.tx, { session: SESSION, cli: "cursor", cliModel: "composer-2.5", pricedModelId: null });
  assert.equal(hold.sent.some((entry) => entry.kind === "findUnique"), false);
});

test("a host refresh is two statements: the upsert of what is listed and the unlisting of the rest", async () => {
  const { tx, sent } = recordingTx();
  await recordAmuxCliModelRefresh(tx, { cli: "copilot", models: [{ cliModel: "kimi-k3", displayName: null }] });
  assert.equal(sent.length, 2);
  assert.match(sent[0].sql, /INSERT INTO "AmuxCliModel"[\s\S]*ON CONFLICT \("cli", "cliModel"\) DO UPDATE/);
  assert.match(sent[1].sql, /UPDATE "AmuxCliModel" SET "listed" = false/);
  assert.deepEqual(AMUX_DB_BOUNDARIES.cliModelRefresh, { operation: "cli_model_refresh", prismaCallCeiling: sent.length + 2, isolation: "mutation" });
});

test("only this store names the catalog tables", () => {
  const source = readFileSync(new URL("../lib/amux/cliModelCatalogStore.ts", import.meta.url), "utf8");
  assert.match(source, /"AmuxCliModelLinkEvent"/);
  for (const path of ["../app/api/admin/amux/cli-models/route.ts", "../app/api/internal/amux/cli-models/route.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /"AmuxCliModel/, path);
  }
});
