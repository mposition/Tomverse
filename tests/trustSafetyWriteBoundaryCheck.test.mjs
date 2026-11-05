import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ALLOWED_SPECIFIERS,
  analysePackageFile,
  BOUNDARY_MODULES,
  ENTRY_POINTS,
  checkTrustSafetyWriteBoundary,
} from "../scripts/check-trust-safety-write-boundary.mjs";

/**
 * The §5.6 static check, checked (docs/policy/trust-safety-compliance-agent.md).
 *
 * A check nobody has seen fail is a check nobody knows the shape of, and this
 * section's history is five review rounds of rules that looked right and
 * refused nothing. So every rule here is fed the violation it exists for, and
 * the real tree is required to pass.
 */

const load = (file) => readFileSync(file, "utf8");

/** Run the check with one file's source replaced. */
const withOverlay = (overlay) =>
  checkTrustSafetyWriteBoundary({
    load: (file) => (Object.hasOwn(overlay, file) ? overlay[file] : load(file)),
  });

const rules = (result) => result.failures.map((failure) => failure.rule).sort();

test("the repository passes, and the closures are what §5.6 says they are", () => {
  const { failures, closure, packages } = checkTrustSafetyWriteBoundary();
  assert.deepEqual(failures, []);
  // The boundary stopped the walk: none of the six are in anyone's own files.
  for (const files of Object.values(closure)) {
    for (const boundary of BOUNDARY_MODULES) {
      const path = boundary.startsWith("@/") ? `${boundary.slice(2)}.ts` : boundary;
      assert.ok(!files.includes(path), `${path} is behind the boundary`);
    }
  }
  // A type-only edge is not followed, so the generated client is not walked.
  assert.deepEqual(packages, ["server-only", "zod"]);
  // E2's own files are the section's, not the page's: the common digest area
  // belongs to no one team (§9), and walking from the page would pull every
  // other agent's panel in.
  assert.ok(closure.E2.includes("components/admin/AdminTrustSafetyDigestPanel.tsx"));
  assert.ok(!closure.E2.some((file) => file.includes("agent-digests/page")));
});

test("a request from a file that is not the ping module is refused", () => {
  // Counted, then refused by the file allowlist: the ping module is the only
  // file with an allowance, so a call anywhere else has none to spend.
  const called = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
export const leak = async (url: string) => fetch(url);`,
  });
  assert.ok(rules(called).includes("fetchCalls-not-allowed"), JSON.stringify(called.failures));

  // And the name on its own, which no allowance covers: passing `fetch` to
  // something else is how a call leaves the file that is counted.
  const referenced = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
export const send = fetch;`,
  });
  assert.ok(rules(referenced).includes("banned-name"), JSON.stringify(referenced.failures));
});

test("the ping module's one request is allowed, and a second is not", () => {
  const source = load("lib/trustSafetyObserverPing.ts");
  const twice = source.replace(
    "const response = await fetch(url, {",
    "await fetch(url);\n    const response = await fetch(url, {",
  );
  const result = withOverlay({ "lib/trustSafetyObserverPing.ts": twice });
  assert.ok(rules(result).includes("fetchCalls-not-allowed"), JSON.stringify(result.failures));
});

test("the global object in any other form is refused", () => {
  const result = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
export const leak = (sink: (env: unknown) => void) => sink(process.env);`,
  });
  assert.ok(rules(result).includes("global-object"));
});

test("a computed property access is refused, and a literal one is not", () => {
  const bad = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
export const pick = (table: Record<string, number>, key: string) => table[key];`,
  });
  assert.ok(rules(bad).includes("computed-access"));

  const fine = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
export const first = (rows: readonly number[]) => rows[0];`,
  });
  assert.deepEqual(fine.failures, []);
});

test("reflection is refused in every use, including a destructured one", () => {
  for (const line of [
    "export const keys = (value: object) => Object.keys(value);",
    "export const { freeze } = Object;",
    "export const proxied = (value: object) => new Proxy(value, {});",
  ]) {
    const result = withOverlay({
      "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}\n${line}`,
    });
    assert.ok(rules(result).includes("reflection-name"), line);
  }
});

test("a name written as a string in brackets is judged as that name", () => {
  // The hole independent review executed: a literal key was allowed without
  // being judged, so `(() => {})["constructor"]` reached `Function` without
  // naming it anywhere this check looked.
  const result = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
const make = (() => {})["constructor"] as (body: string) => () => unknown;
export const run = () => make("return 1")();`,
  });
  assert.ok(rules(result).includes("bracket-name"), JSON.stringify(result.failures));
});

test("the same name in a destructuring key is judged too", () => {
  const result = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
export const { "constructor": make } = (() => {}) as unknown as Record<string, unknown>;`,
  });
  assert.ok(rules(result).includes("binding-name"), JSON.stringify(result.failures));
});

test("a numeric index is still allowed", () => {
  const result = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
export const head = (rows: readonly string[]) => rows[0];`,
  });
  assert.deepEqual(result.failures, []);
});

test("a value re-export is walked like an import", () => {
  // The second hole review found: `export { x } from "./y"` loads that file
  // at runtime without importing it, so its requests and writes were outside
  // the check entirely.
  const result = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
export { NextResponse } from "next/server";`,
  });
  assert.ok(rules(result).includes("specifier-not-allowed"), JSON.stringify(result.failures));
});

test("a type-only re-export is not walked", () => {
  const result = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
export type { ActivationState } from "@/lib/trustSafetyActivationCore";`,
  });
  assert.deepEqual(result.failures, []);
});

test("a package import outside (ㄴ')'s eight is refused", () => {
  const result = withOverlay({
    "app/api/admin/agents/trust-safety/activation/route.ts": load(
      "app/api/admin/agents/trust-safety/activation/route.ts",
    ).replace('import { z } from "zod";', 'import { NextResponse } from "next/server";\nimport { z } from "zod";'),
  });
  assert.ok(rules(result).includes("specifier-not-allowed"));
});

test("@prisma/client as a value import is refused, as a type import is not", () => {
  const source = load("lib/trustSafetyTransaction.ts");
  const asValue = source.replace(
    'import type { Prisma, PrismaClient } from "@prisma/client";',
    'import { Prisma, type PrismaClient } from "@prisma/client";',
  );
  assert.notEqual(asValue, source, "the import is where the test thinks it is");
  const result = withOverlay({ "lib/trustSafetyTransaction.ts": asValue });
  assert.ok(rules(result).includes("specifier-must-be-type-only"));
});

test("a built-in module outside the two pairs is refused, by module and by export", () => {
  const byExport = withOverlay({
    "lib/trustSafetyObserverPing.ts": `import { connect } from "node:net";\n${load(
      "lib/trustSafetyObserverPing.ts",
    )}`,
  });
  assert.ok(rules(byExport).includes("builtin-export-not-allowed"));

  const other = withOverlay({
    "lib/trustSafetyObserverPing.ts": `import { createServer } from "node:http";\n${load(
      "lib/trustSafetyObserverPing.ts",
    )}`,
  });
  assert.ok(rules(other).includes("builtin-not-allowed"));

  const namespace = withOverlay({
    "lib/trustSafetyAuditEntryVerify.ts": `import * as crypto from "node:crypto";\n${load(
      "lib/trustSafetyAuditEntryVerify.ts",
    )}`,
  });
  assert.ok(rules(namespace).includes("builtin-namespace-import"));
});

test("require and a dynamic import are refused", () => {
  for (const [rule, line] of [
    ["require", 'export const net = require("node:net");'],
    ["dynamic-import", 'export const load = () => import("node:net");'],
  ]) {
    const result = withOverlay({
      "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}\n${line}`,
    });
    assert.ok(rules(result).includes(rule), line);
  }
});

test("an audit append in E1's or E2's closure is refused", () => {
  // §5.6: the same function is allowed exactly once in E3 and is a failure in
  // the other two. The shared read is in all three closures, so an append
  // there is the case that matters.
  const result = withOverlay({
    "lib/trustSafetyActivationRead.ts": `${load("lib/trustSafetyActivationRead.ts")}
export const sneak = async (writeAdminAuditLog: (input: unknown) => Promise<string>) =>
  writeAdminAuditLog({});`,
  });
  const entries = result.failures.filter((failure) => failure.rule === "auditAppends-not-allowed");
  assert.deepEqual(
    entries.map((failure) => failure.entry).sort(),
    ["E1", "E2"],
    "the shared read is in those two closures; E3 reads the config row itself",
  );
});

test("E3's single allowance is spent, so a second append there is refused too", () => {
  const result = withOverlay({
    "lib/trustSafetyActivationStore.ts": load("lib/trustSafetyActivationStore.ts").replace(
      "      return {\n        result: \"changed\",",
      `      await writeAdminAuditLog({
        session,
        request,
        action: TRUST_SAFETY_ACTIVATION_ACTION,
        targetType: CONFIG_TARGET_TYPE,
        targetId: CONFIG_ID,
        summary: "again",
        metadata: {},
      });
      return {
        result: "changed",`,
    ),
  });
  const entries = result.failures.filter((failure) => failure.rule === "auditAppends-not-allowed");
  assert.deepEqual(entries.map((failure) => failure.entry), ["E3"]);
  assert.match(entries[0].detail, /2 where 1 are allowed/);
});

test("a write to another table is refused even in the entry point that may write", () => {
  const result = withOverlay({
    "lib/trustSafetyActivationStore.ts": load("lib/trustSafetyActivationStore.ts").replace(
      "      const planned = nextActivationWrite({ current, requested });",
      `      await tx.statement((client) => client.privacyRequest.update({ where: { id: "x" }, data: {} }));
      const planned = nextActivationWrite({ current, requested });`,
    ),
  });
  assert.ok(rules(result).includes("delegateWrites-not-allowed"));
});

test("`$executeRaw` and the unsafe variants are refused anywhere", () => {
  for (const [rule, line] of [
    ["raw-execute", "export const lock = (tx: { $executeRaw: (s: unknown) => Promise<number> }) => tx.$executeRaw`SELECT 1`;"],
    ["raw-unsafe", "export const any = (tx: { $queryRawUnsafe: (s: string) => Promise<unknown> }) => tx.$queryRawUnsafe(\"SELECT 1\");"],
  ]) {
    const result = withOverlay({
      "lib/trustSafetyTransaction.ts": `${load("lib/trustSafetyTransaction.ts")}\n${line}`,
    });
    assert.ok(rules(result).includes(rule), line);
  }
});

test("a tagged statement outside the two modules that may send one is refused", () => {
  const result = withOverlay({
    "lib/trustSafetyActivationRead.ts": `${load("lib/trustSafetyActivationRead.ts")}
export const clock = (tx: { $queryRaw: (s: unknown) => Promise<unknown> }) =>
  tx.$queryRaw\`SELECT clock_timestamp()\`;`,
  });
  assert.ok(rules(result).includes("taggedQueryRaw-not-allowed"));
});

test("an allowed statement that changes shape is refused, count unchanged", () => {
  // §5.6 fixes the shape as well as the number. Counting alone let the run
  // row's INSERT become a DELETE on another table -- the same one tagged
  // statement, in the file allowed to have one -- which independent review
  // found.
  const source = load("lib/trustSafetyObserverRun.ts");
  const deletes = source.replace(
    /INSERT INTO "TrustSafetyObserverRun"[\s\S]*?RETURNING "id"/,
    'DELETE FROM "PrivacyRequest" WHERE "id" = ${id} RETURNING "id"',
  );
  assert.notEqual(deletes, source, "the statement is where the test thinks it is");
  const result = withOverlay({ "lib/trustSafetyObserverRun.ts": deletes });
  const found = rules(result);
  assert.ok(found.includes("raw-shape"), JSON.stringify(result.failures));
  assert.ok(found.includes("raw-destructive"));
  assert.ok(!found.includes("taggedQueryRaw-not-allowed"), "the count did not change");
});

test("the wrapper's deadline statement cannot become something else", () => {
  const source = load("lib/trustSafetyTransaction.ts");
  const swapped = source.replace(/SELECT set_config\([\s\S]*?true\) AS armed/, "SELECT 1 AS armed");
  assert.notEqual(swapped, source);
  const result = withOverlay({ "lib/trustSafetyTransaction.ts": swapped });
  assert.ok(rules(result).includes("raw-shape"));
});

test("a change to the shared audit writer's statements fails here first", () => {
  // §5.6 item 1 pins the count because this agent is charged for it: a
  // statement added there changes what the activation write spends, and the
  // judgement then belongs to that file's change, not to this agent's.
  const result = withOverlay({
    "lib/adminAudit.ts": `${load("lib/adminAudit.ts")}
// client.$executeRaw\`SELECT 1\``.replace("// client", "const extra = (client) => client"),
  });
  assert.ok(rules(result).includes("audit-writer-statements"));
});

test("importing a seventh shared module brings it into the agent's own files", () => {
  // (ㄴ'): widening the boundary is the only way to weaken this check, so a
  // module that is not one of the six is walked like any self file -- and
  // `lib/apiSecurity.ts` then fails on its own imports.
  const result = withOverlay({
    "app/api/admin/agents/trust-safety/activation/route.ts": load(
      "app/api/admin/agents/trust-safety/activation/route.ts",
    ).replace(
      'import { z } from "zod";',
      'import { z } from "zod";\nimport { readLimitedText } from "@/lib/apiSecurity";',
    ),
  });
  assert.ok(result.failures.length > 0);
  assert.ok(
    result.failures.some((failure) => failure.file === "lib/apiSecurity.ts"),
    JSON.stringify(result.failures.slice(0, 4)),
  );
});

test("a delegate held in a variable still counts as a write", () => {
  // Requiring the delegate chain let a read-only entry point delete rows:
  // `const requests = prisma.privacyRequest; requests.deleteMany({})`.
  // Independent review found it in E2's closure, where the allowance is zero.
  const result = withOverlay({
    "lib/trustSafetyDigestRead.ts": `${load("lib/trustSafetyDigestRead.ts")}
export const purge = async (requests: { deleteMany: (args: unknown) => Promise<unknown> }) =>
  requests.deleteMany({});`,
  });
  assert.ok(rules(result).includes("delegateWrites-not-allowed"), JSON.stringify(result.failures));
});

test("a write reached through a literal key or an alias still counts", () => {
  // The two forms the call-shaped rule missed, both from review: the method
  // named in brackets, and the method pulled out into a variable first.
  for (const line of [
    'export const purge = async (client: Record<string, Record<string, (a: unknown) => Promise<unknown>>>) => client.privacyRequest["deleteMany"]({});',
    "export const purge2 = async (client: { privacyRequest: { deleteMany: (a: unknown) => Promise<unknown> } }) => { const remove = client.privacyRequest.deleteMany; return remove({}); };",
  ]) {
    const result = withOverlay({
      "lib/trustSafetyDigestRead.ts": `${load("lib/trustSafetyDigestRead.ts")}\n${line}`,
    });
    assert.ok(rules(result).includes("delegateWrites-not-allowed"), line);
  }
});

test("every spelling of a write method's name counts, including the three found last", () => {
  // The class, not its instances: a destructuring key, a shorthand
  // destructuring binding, and a template-literal key. Each was a separate
  // review finding.
  const forms = [
    "export const a = async (client: { privacyRequest: { deleteMany: (x: unknown) => Promise<unknown> } }) => { const { deleteMany: remove } = client.privacyRequest; return remove({}); };",
    "export const b = async (client: { privacyRequest: { deleteMany: (x: unknown) => Promise<unknown> } }) => { const { deleteMany } = client.privacyRequest; return deleteMany({}); };",
    "export const c = async (client: Record<string, Record<string, (x: unknown) => Promise<unknown>>>) => client.privacyRequest[`deleteMany`]({});",
  ];
  for (const line of forms) {
    const result = withOverlay({
      "lib/trustSafetyDigestRead.ts": `${load("lib/trustSafetyDigestRead.ts")}\n${line}`,
    });
    assert.ok(rules(result).includes("delegateWrites-not-allowed"), line.slice(0, 60));
  }
});

test("a raw method reached through a literal key is refused like a dot access", () => {
  for (const [rule, line] of [
    ["raw-unsafe", 'export const any = (client: Record<string, (s: string) => Promise<unknown>>) => client["$executeRawUnsafe"]("DELETE FROM \\"PrivacyRequest\\"");'],
    ["raw-execute", 'export const lock = (client: Record<string, (s: string) => Promise<unknown>>) => client["$executeRaw"]("SELECT 1");'],
  ]) {
    const result = withOverlay({
      "lib/trustSafetyDigestRead.ts": `${load("lib/trustSafetyDigestRead.ts")}\n${line}`,
    });
    assert.ok(rules(result).includes(rule), line.slice(0, 60));
  }
});

test("a template-literal key naming a banned name is judged too", () => {
  const result = withOverlay({
    "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}
const make = (() => {})[\`constructor\`] as (body: string) => () => unknown;
export const run = () => make("return 1")();`,
  });
  assert.ok(rules(result).includes("bracket-name"), JSON.stringify(result.failures));
});

test("an audit writer pulled into a variable counts too", () => {
  const result = withOverlay({
    "lib/trustSafetyActivationRead.ts": `${load("lib/trustSafetyActivationRead.ts")}
export const sneak = (writeAdminAuditLog: (input: unknown) => Promise<string>) => {
  const append = writeAdminAuditLog;
  return append({});
};`,
  });
  assert.ok(rules(result).includes("auditAppends-not-allowed"), JSON.stringify(result.failures));
});

test("a digest's own update is still not a write", () => {
  // Which is why the receiver was looked at in the first place: the routes
  // compare bearer digests with `createHash("sha256").update(...)`.
  const { failures } = checkTrustSafetyWriteBoundary();
  assert.deepEqual(failures, []);
});

test("a star re-export of a built-in module is refused", () => {
  for (const line of [
    'export * from "node:net";',
    'export * as net from "node:net";',
  ]) {
    const result = withOverlay({
      "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}\n${line}`,
    });
    assert.ok(rules(result).includes("builtin-namespace-import"), line);
  }
});

test("the loader names are refused in every appearance, not just as a call", () => {
  for (const line of [
    "export const load = require;",
    'export const net = module.require("node:net");',
    "export const own = exports;",
  ]) {
    const result = withOverlay({
      "lib/trustSafetyRoundCore.ts": `${load("lib/trustSafetyRoundCore.ts")}\n${line}`,
    });
    assert.ok(rules(result).includes("loader-name"), line);
  }
});

test("a raw tag taken out of its call site is refused, not counted", () => {
  // `const query = client.$queryRaw.bind(client); await query`DELETE …`` was
  // past the count, the shape and the destructive-SQL rules at once, because
  // the tag was named `query` by the time it was used.
  const result = withOverlay({
    "lib/trustSafetyDigestRead.ts": `${load("lib/trustSafetyDigestRead.ts")}
export const purge = async (client: { $queryRaw: (s: unknown) => Promise<unknown> }) => {
  const query = client.$queryRaw;
  return query([]);
};`,
  });
  assert.ok(rules(result).includes("raw-extracted"), JSON.stringify(result.failures));
});

test("an aliased audit writer still counts as an append", () => {
  // `import { writeAdminAuditLog as wal }` plus `wal(...)` was an audit write
  // with a count of zero.
  const result = withOverlay({
    "lib/trustSafetyActivationRead.ts": load("lib/trustSafetyActivationRead.ts").replace(
      'import {\n  type TrustSafetyIntegrityKeyEnv,',
      'import { writeAdminAuditLog as wal } from "@/lib/adminAudit";\nimport {\n  type TrustSafetyIntegrityKeyEnv,',
    ) + `
export const sneak = () => wal({});`,
  });
  const entries = result.failures.filter((failure) => failure.rule === "auditAppends-not-allowed");
  assert.ok(entries.length > 0, JSON.stringify(result.failures.slice(0, 3)));
});

test("a comment cannot stand in for the digest the exclusion is about", () => {
  // The exclusion walks the receiver now: a parenthesised receiver's text
  // includes its comments, and `(client /* createHash( */)` was suppressing
  // the write count.
  const result = withOverlay({
    "lib/trustSafetyDigestRead.ts": `${load("lib/trustSafetyDigestRead.ts")}
export const purge = async (client: { privacyRequest: { deleteMany: (x: unknown) => Promise<unknown> } }) =>
  (client /* createHash( */).privacyRequest.deleteMany({});`,
  });
  assert.ok(rules(result).includes("delegateWrites-not-allowed"), JSON.stringify(result.failures));
});

test("Prisma's returning write variants are all counted", () => {
  for (const method of ["createManyAndReturn", "updateManyAndReturn", "upsert"]) {
    const result = withOverlay({
      "lib/trustSafetyDigestRead.ts": `${load("lib/trustSafetyDigestRead.ts")}
export const write = async (client: Record<string, Record<string, (x: unknown) => Promise<unknown>>>) =>
  client.privacyRequest.${method}({});`,
    });
    assert.ok(rules(result).includes("delegateWrites-not-allowed"), method);
  }
});

test("a write to another model is refused at the same count", () => {
  // The allowlist names the pair, not the number: E3's two config writes were
  // swappable for `client.user.deleteMany(...)` while the count held.
  const result = withOverlay({
    "lib/trustSafetyActivationStore.ts": load("lib/trustSafetyActivationStore.ts").replace(
      "client.trustSafetyObserverConfig.update({",
      "client.user.deleteMany({",
    ),
  });
  const entries = result.failures.filter((failure) => failure.rule === "delegateWrites-not-allowed");
  assert.ok(entries.length > 0, JSON.stringify(result.failures.slice(0, 3)));
  assert.match(entries[0].detail, /user\.deleteMany is not one of/);
});

test("a receiver the check cannot reduce to a model is refused", () => {
  const result = withOverlay({
    "lib/trustSafetyActivationStore.ts": load("lib/trustSafetyActivationStore.ts").replace(
      "client.trustSafetyObserverConfig.update({",
      "delegate.update({",
    ),
  });
  const entries = result.failures.filter((failure) => failure.rule === "delegateWrites-not-allowed");
  assert.ok(entries.some((failure) => failure.detail.includes("<unresolved>")), JSON.stringify(entries));
});

test("a CTE smuggling a second write past the allowed shape is refused", () => {
  // One valid PostgreSQL statement, the allowed shape as its tail: the shapes
  // are anchored to the whole statement now.
  const result = withOverlay({
    "lib/trustSafetyTransaction.ts": load("lib/trustSafetyTransaction.ts").replace(
      "          SELECT \"serverVersion\"",
      "          WITH extra AS (INSERT INTO \"PrivacyRequest\" DEFAULT VALUES RETURNING \"id\")\n          SELECT \"serverVersion\"",
    ),
  });
  assert.ok(rules(result).includes("raw-shape"), JSON.stringify(result.failures.slice(0, 3)));
});

test("a namespace import of a boundary module is refused", () => {
  // `import * as audit from "@/lib/adminAudit"` then
  // `audit["writeAdminAuditLog"](...)` was an audit write nothing counted.
  const result = withOverlay({
    "lib/trustSafetyActivationStore.ts": `import * as audit from "@/lib/adminAudit";\n${load(
      "lib/trustSafetyActivationStore.ts",
    )}`,
  });
  assert.ok(rules(result).includes("boundary-namespace-import"), JSON.stringify(result.failures.slice(0, 3)));
});

test("only a digest imported from node:crypto excludes a write", () => {
  // Any call named createHash counted before, so an object literal with that
  // key suppressed a real delete.
  const result = withOverlay({
    "lib/trustSafetyDigestRead.ts": `${load("lib/trustSafetyDigestRead.ts")}
export const purge = async (client: { privacyRequest: { deleteMany: (x: unknown) => Promise<unknown> } }) =>
  ({ createHash: () => client.privacyRequest }).createHash("x").deleteMany({});`,
  });
  assert.ok(rules(result).includes("delegateWrites-not-allowed"), JSON.stringify(result.failures.slice(0, 3)));
});

test("(ㄷ): the loader rule, as a table of what is refused and what is not", () => {
  // Four rounds of review each moved a positional fold, so the fold is gone:
  // a call a loader takes part in has every reducible argument judged as a
  // specifier, and any argument that does not reduce fails the package. The
  // whole table is asserted together, so moving one case cannot quietly move
  // another, and the five allowed rows are what keep the rule usable.
  const refused = {
    // An alias of an alias assigned later in the file: the collector ran
    // once in source order, so this was invisible. It runs to a fixed point.
    "an alias of an alias assigned later":
      'let r; function run() { const load = r; return load("node:net"); } r = require; module.exports = run;',
    // A comma expression and a conditional reduce to a loader too.
    "a comma expression": 'module.exports = (0, require)("node:net");',
    "a conditional alias":
      'const r = globalThis.x ? require : null; module.exports = r("node:net");',
    // `createRequire` was exempt by name, so an alias of `require` called
    // that skipped the specifier check. There is no exemption now.
    "createRequire as an alias of require":
      'const createRequire = require; module.exports = createRequire("node:net");',
    // Evaluating a `new` loads the module too, and only calls were judged.
    "new require(...)": 'module.exports = new require("node:https");',
    // An alias assigned rather than declared went untracked.
    "an alias assigned, not declared": 'let r; r = require; module.exports = r("node:net");',
    "an unreducible specifier beside an allowed string":
      'const target = "node:" + "net"; module.exports = require(target, "node:crypto");',
    "an allowed module as the forwarded thisArg":
      'module.exports = Function.prototype.call.call(require, "node:crypto", "node:net");',
    "the loader bound into Function.prototype.call":
      'module.exports = Function.prototype.call.bind(require)("node:crypto", "node:net");',
    "a loader-valued thisArg on .call": 'module.exports = require.call(require, "node:net");',
    "a loader-valued thisArg on .apply":
      'module.exports = require.apply(require, ["node:net"]);',
    "a loader-valued thisArg on .bind":
      'module.exports = require.bind(require, "node:net")();',
    "require.call with an allowed thisArg":
      'module.exports = require.call("node:crypto", "node:net");',
    "bind with the specifier bound in": 'module.exports = require.bind(module, "node:net")();',
    "a bound loader invoked later":
      'const load = require.bind(module); module.exports = load("node:net");',
    "apply, whose argument array cannot be read":
      'module.exports = require.apply(null, ["node:net"]);',
    "a dynamic import of a module (ㄱ-1) does not allow":
      'export const go = (u) => import("node:https").then((m) => m.get(u));',
    "process.mainModule with a string key":
      'module.exports = process.mainModule["require"]("node:net");',
    "module.constructor._load": 'module.exports = module.constructor._load("node:net");',
    // (ㄱ-1) allows no export of `node:module`, so a package that imports it
    // fails, `createRequire` included. That is the section's own answer and
    // the cost of using such a package, not a gap: the two walked today,
    // `zod` and `server-only`, do not.
    "a package importing node:module":
      'import { createRequire } from "node:module"; const r = createRequire(import.meta.url); module.exports = r("./util.js");',
  };
  const allowed = {
    "node:crypto, allowed entirely":
      'const { createHash } = require("node:crypto"); module.exports = createHash;',
    "a relative require": 'module.exports = require("./util.js");',
    "a static import": 'import { z } from "./schema.js"; export const s = z;',
    "an ordinary computed read, which react does": "module.exports = (config, key) => config[key];",
    "a call that no loader takes part in": "module.exports = (f, x) => f(x);",
    "an ordinary new": "module.exports = class A { constructor() { this.x = new Map(); } };",
    "an ordinary comma expression": "module.exports = (a, b) => (a, b);",
    "an ordinary conditional": "module.exports = (c, a, b) => (c ? a : b);",
  };

  const judge = (source) =>
    analysePackageFile({ specifier: "probe", file: "node_modules/probe/index.js", source }).failures;

  for (const [label, source] of Object.entries(refused)) {
    assert.ok(judge(source).length > 0, `${label} must be refused`);
  }
  for (const [label, source] of Object.entries(allowed)) {
    assert.deepEqual(judge(source), [], `${label}: ${JSON.stringify(judge(source))}`);
  }
});

test("the entry points and the specifier list are the ones the section names", () => {
  assert.deepEqual(
    ENTRY_POINTS.map((entry) => entry.id),
    ["E1", "E2", "E3"],
  );
  assert.equal(ALLOWED_SPECIFIERS.size, 8, "eight, as (ㄴ') counts them");
  assert.equal(BOUNDARY_MODULES.size, 6, "six, as (ㄴ) names them");
});
