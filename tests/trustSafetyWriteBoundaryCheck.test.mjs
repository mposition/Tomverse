import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ALLOWED_SPECIFIERS,
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

test("the entry points and the specifier list are the ones the section names", () => {
  assert.deepEqual(
    ENTRY_POINTS.map((entry) => entry.id),
    ["E1", "E2", "E3"],
  );
  assert.equal(ALLOWED_SPECIFIERS.size, 8, "eight, as (ㄴ') counts them");
  assert.equal(BOUNDARY_MODULES.size, 6, "six, as (ㄴ) names them");
});
