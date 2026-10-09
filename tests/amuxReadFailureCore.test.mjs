import assert from "node:assert/strict";
import { test } from "node:test";

import { DriverAdapterError } from "@prisma/driver-adapter-utils";

import {
  AMUX_DATABASE_BUSY_REASON,
  AMUX_DATABASE_BUSY_RETRY_AFTER_SECONDS,
  amuxDatabaseDiagnosticCode,
  amuxTransientDatabaseCode,
} from "../lib/amux/readFailureCore.ts";

// Which failures of a read transaction are answered 503 `amux_database_busy`.
// The boundary and the internal route are driven through the real Prisma
// client in tests/server-contract/amux-commit-deadline-boundary.test.ts; these
// pin the list itself and every shape a code can arrive in.

const postgres = (code) =>
  new DriverAdapterError({
    kind: "postgres",
    code,
    originalCode: code,
    originalMessage: "m",
    severity: "ERROR",
    message: "m",
  });

test("the reason and the Retry-After are the ones the Rust client and the scheduler cadence use", () => {
  assert.equal(AMUX_DATABASE_BUSY_REASON, "amux_database_busy");
  assert.equal(AMUX_DATABASE_BUSY_RETRY_AFTER_SECONDS, 5);
});

test("a Prisma raw-query error exposes only its nested PostgreSQL code", () => {
  assert.equal(
    amuxDatabaseDiagnosticCode({ code: "P2010", meta: { driverAdapterError: postgres("57014") } }),
    "57014",
  );
  assert.equal(amuxDatabaseDiagnosticCode({ code: "P2010", meta: { code: "42P01" } }), "42P01");
  assert.equal(amuxDatabaseDiagnosticCode({ code: "P2010", meta: { database_error: "secret 57014" } }), null);
});

test("the pool, the transaction API, the statement timeout and a lost connection are transient", () => {
  const cases = [
    // What production logged: the transaction could not start within maxWait.
    [{ name: "TransactionManagerError", code: "P2028", message: "Transaction API error: Unable to start a transaction in the given time." }, "P2028"],
    [{ name: "PrismaClientKnownRequestError", code: "P2024" }, "P2024"],
    [{ code: "P1001" }, "P1001"],
    [{ code: "P1002" }, "P1002"],
    [{ code: "P1008" }, "P1008"],
    [{ code: "P1017" }, "P1017"],
    [{ code: "P2037" }, "P2037"],
    // The statement timeout, as the transaction manager rethrows it bare, as a
    // raw query carries it, and in the older meta shape.
    [postgres("57014"), "57014"],
    [{ name: "PrismaClientKnownRequestError", code: "P2010", meta: { driverAdapterError: postgres("57014") } }, "57014"],
    [{ name: "PrismaClientKnownRequestError", code: "P2039", meta: { driverAdapterError: postgres("57014") } }, "57014"],
    [{ code: "P2010", meta: { code: "57014" } }, "57014"],
    // Connection exceptions and shutdowns.
    [postgres("08006"), "08006"],
    [postgres("57P01"), "57P01"],
    [postgres("57P03"), "57P03"],
    [new DriverAdapterError({ kind: "TooManyConnections", cause: "x" }), "TooManyConnections"],
    // The pg adapter's socket kinds, and a raw socket error.
    [new DriverAdapterError({ kind: "ConnectionClosed" }), "ConnectionClosed"],
    [new DriverAdapterError({ kind: "SocketTimeout" }), "SocketTimeout"],
    [new DriverAdapterError({ kind: "DatabaseNotReachable", host: "h", port: 5432 }), "DatabaseNotReachable"],
    [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read", errno: -104 }), "ECONNRESET"],
    // Wrapped once more.
    [new Error("outer", { cause: { code: "P2028" } }), "P2028"],
  ];
  for (const [error, code] of cases) {
    assert.equal(amuxTransientDatabaseCode(error), code, JSON.stringify(error));
  }
});

test("everything else keeps its old answer", () => {
  for (const error of [
    undefined,
    null,
    "P2028",
    new Error("boom"),
    // The commit deadline trigger: a known deadline refusal, never "busy".
    postgres("AX001"),
    { code: "P2010", meta: { driverAdapterError: postgres("AX001") } },
    // Bugs and schema problems are not transient.
    postgres("42P01"),
    // A rejected connection and a protocol violation are not waited out.
    postgres("08004"),
    postgres("08P01"),
    postgres("22P02"),
    { code: "P2002" },
    { code: "P2025" },
    { code: "P2010", meta: { driverAdapterError: postgres("42703") } },
    // A write conflict is a write's matter.
    postgres("40001"),
    { code: "P2034" },
    new DriverAdapterError({ kind: "TransactionWriteConflict" }),
    // No message is read: a text that names a code decides nothing.
    new Error("Transaction API error: P2028 57014 ECONNRESET"),
    { code: "P2010", meta: { database_error: "57014 canceling statement due to statement timeout" } },
    // An AMUX refusal code is not a database code.
    { code: "AMUX_DB_DEADLINE_EXCEEDED" },
  ]) {
    assert.equal(amuxTransientDatabaseCode(error), null, String(error?.message ?? JSON.stringify(error)));
  }
});

test("the walk is bounded and survives cycles", () => {
  const a = { code: "X" };
  const b = { code: "Y", cause: a };
  a.cause = b;
  assert.equal(amuxTransientDatabaseCode(a), null);

  let deep = { code: "P2028" };
  for (let depth = 0; depth < 32; depth += 1) deep = { code: "X", cause: deep };
  assert.equal(amuxTransientDatabaseCode(deep), null, "past the node bound nothing is read");
});

test("only Prisma's own P2024 and P2028, at the top, name a transaction that did not start", async () => {
  const { amuxTransactionNotStartedCode } = await import("../lib/amux/readFailureCore.ts");
  assert.equal(
    amuxTransactionNotStartedCode({
      name: "TransactionManagerError",
      code: "P2028",
      message: "Transaction API error: Unable to start a transaction in the given time.",
    }),
    "P2028",
  );
  assert.equal(amuxTransactionNotStartedCode({ code: "P2024" }), "P2024");
  for (const error of [
    undefined,
    null,
    "P2028",
    { code: "P1017" },
    postgres("57014"),
    // Nested codes are not a start refusal: only Prisma's own top-level answer.
    new Error("outer", { cause: { code: "P2028" } }),
    { code: "P2010", meta: { code: "P2028" } },
    new Error("Transaction API error: P2028"),
  ]) {
    assert.equal(amuxTransactionNotStartedCode(error), null, String(error?.message ?? JSON.stringify(error)));
  }
});
