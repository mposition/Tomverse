import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  isChatRefinerInitialAutoRouterAuthority,
  mintChatRefinerInitialAutoRouterAuthority,
} from "../lib/chatRefinerInitialAutoRouterAuthority.ts";

const binding = () => ({
  routerActivationAuditLogId: "audit_router_initial_release",
  runtimeCommitSha: "a".repeat(40),
  runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
});

test("only the exact minted object carries initial Auto authority", () => {
  const authority = mintChatRefinerInitialAutoRouterAuthority(binding());
  assert.equal(isChatRefinerInitialAutoRouterAuthority(authority), true);
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(isChatRefinerInitialAutoRouterAuthority({ ...authority }), false);
  assert.equal(
    isChatRefinerInitialAutoRouterAuthority(JSON.parse(JSON.stringify(authority))),
    false
  );
  assert.equal(isChatRefinerInitialAutoRouterAuthority(null), false);
});

test("the mint refuses malformed runtime bindings", () => {
  for (const overrides of [
    { routerActivationAuditLogId: "" },
    { runtimeCommitSha: "not-a-sha" },
    { runtimeDeploymentId: "not-a-deployment" },
  ]) {
    assert.throws(
      () => mintChatRefinerInitialAutoRouterAuthority({
        ...binding(),
        ...overrides,
      }),
      /authority_binding_invalid/
    );
  }
});

test("the request route never reads an initial authority from the body", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  assert.doesNotMatch(route, /body\.(initialReleaseAuthority|initialAutoAuthority)/);
  assert.match(route, /readChatRefinerInitialAutoRouterAuthority\(\)/);
  assert.equal(
    (route.match(/await readChatRefinerInitialAutoRouterAuthority\(\)/g) ?? []).length,
    1,
    "one request must use one fresh authority object for both cohort decisions"
  );
  assert.equal(
    (route.match(/^\s+initialReleaseAuthority,$/gm) ?? []).length,
    2,
    "the preliminary cohort and final selection must receive the same object"
  );
});

test("only the strict release store imports the production mint", () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path.replaceAll("\\", "/"));
    }
  };
  walk("lib");
  walk("app");
  const callers = files.filter((path) =>
    readFileSync(path, "utf8").includes("mintChatRefinerInitialAutoRouterAuthority")
  ).sort();
  assert.deepEqual(callers, [
    "lib/chatRefinerInitialAutoReleaseStore.ts",
    "lib/chatRefinerInitialAutoRouterAuthority.ts",
  ]);
});
