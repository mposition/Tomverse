import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Prisma } from "@prisma/client";

import { AMUX_V19_REGISTRATION_FAILED_EVENT, amuxV19RegistrationFailureLog } from
  "../lib/amux/ideaSystemRegistrationFailureLogCore.ts";

const ideaId = "2be752c3-ba61-4320-ba2e-2f5a2337fff9";

test("a database failure keeps its class, Prisma code and SQLSTATE only", () => {
  const error = new Prisma.PrismaClientKnownRequestError(
    "Raw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`",
    { code: "P2010", clientVersion: "test",
      meta: { code: "57014", message: "canceling statement due to statement timeout" } });
  const line = amuxV19RegistrationFailureLog(ideaId, error);
  assert.deepEqual(line, { event: AMUX_V19_REGISTRATION_FAILED_EVENT, ideaId,
    errorName: "PrismaClientKnownRequestError", errorCode: "P2010", dbCode: "57014" });
  assert.doesNotMatch(JSON.stringify(line), /canceling|Raw query/);
});

test("a registration refusal and an external failure keep their own codes", () => {
  class AmuxV19SystemRegistrationError extends Error {
    constructor(code) { super(code); this.name = "AmuxV19SystemRegistrationError";
      this.code = code; }
  }
  assert.deepEqual(amuxV19RegistrationFailureLog(ideaId,
    new AmuxV19SystemRegistrationError("outcome_unknown")), {
    event: AMUX_V19_REGISTRATION_FAILED_EVENT, ideaId,
    errorName: "AmuxV19SystemRegistrationError", errorCode: "outcome_unknown",
    dbCode: null });
  const keyStore = Object.assign(new Error("Access Denied for docs/private.md"),
    { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  assert.deepEqual(amuxV19RegistrationFailureLog(ideaId, keyStore), {
    event: AMUX_V19_REGISTRATION_FAILED_EVENT, ideaId,
    errorName: "AccessDenied", errorCode: null, dbCode: null });
});

test("anything outside the closed shapes is dropped, never copied", () => {
  const strange = Object.assign(new Error("secret body"), {
    name: "Name with spaces and\nnewline", code: "a code with spaces",
    meta: { code: "not-a-sqlstate" } });
  assert.deepEqual(amuxV19RegistrationFailureLog("not-an-idea", strange), {
    event: AMUX_V19_REGISTRATION_FAILED_EVENT, ideaId: null, errorName: "Error",
    errorCode: null, dbCode: null });
  assert.deepEqual(amuxV19RegistrationFailureLog(ideaId, "plain text"), {
    event: AMUX_V19_REGISTRATION_FAILED_EVENT, ideaId, errorName: "string",
    errorCode: null, dbCode: null });
  assert.deepEqual(amuxV19RegistrationFailureLog(ideaId, null), {
    event: AMUX_V19_REGISTRATION_FAILED_EVENT, ideaId, errorName: "object",
    errorCode: null, dbCode: null });
});

test("the result route logs every registration failure it hides from the runner", () => {
  const source = readFileSync(new URL(
    "../app/api/internal/amux/v19/session-analysis-result/route.ts", import.meta.url), "utf8");
  const register = source.slice(source.indexOf("async function registerSessionPlan"));
  const handler = register.slice(register.indexOf("} catch (error) {"),
    register.indexOf("export async function GET"));
  assert.match(handler, /console\.error\(JSON\.stringify\(amuxV19RegistrationFailureLog\(ideaId, error\)\)\)/);
  assert.ok(handler.indexOf("console.error") < handler.indexOf("outcome_unknown"),
    "the cause is logged before it becomes outcome_unknown");
});
