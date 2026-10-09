// Environment names an ops-observer service may start with
// (docs/policy/sre-ops.md §3 rule 5, §7): the lists match the policy text, a
// correctly configured service passes, every credential in the app's own
// environment is refused by at least one of the two checks, and the child
// receives only its listed variables.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CHILD_VARIABLES,
  RAILWAY_NAMES,
  RUNTIME_NAMES,
  SERVICE_VARIABLES,
  childEnvironment,
  counterpartVariables,
  isCredentialShaped,
  judgeEnvironmentNames,
} from "../scripts/ops-observer/runtime-variables-core.mjs";

const policy = readFileSync(new URL("../docs/policy/sre-ops.md", import.meta.url), "utf8");
const root = fileURLToPath(new URL("..", import.meta.url));

// Every variable name the app reads, from `process.env.NAME` in lib/ and app/.
function appVariableNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        for (const m of readFileSync(path, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
      }
    }
  };
  walk(join(root, "lib"));
  walk(join(root, "app"));
  return [...names];
}

const backticked = (text) => [...text.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]);

// The text between two markers, which must each occur exactly once.
function between(start, end) {
  const from = policy.indexOf(start);
  assert.ok(from !== -1 && policy.indexOf(start, from + 1) === -1, `policy marker: ${start}`);
  const to = policy.indexOf(end, from + start.length);
  assert.ok(to !== -1, `policy marker: ${end}`);
  return policy.slice(from + start.length, to);
}

function policyRow(label) {
  const row = policy.split("\n").find((line) => line.startsWith(`| ${label} |`));
  assert.ok(row, `policy §7 row: ${label}`);
  return backticked(row.slice(row.indexOf("|", 2)));
}

test("the allowlists equal the policy's §3 rule 5 lists exactly", () => {
  assert.deepEqual(
    [...RUNTIME_NAMES].sort(),
    backticked(between("base image·Node의 이름:", "3. Railway가 넣는")).sort(),
  );
  assert.deepEqual(
    [...RAILWAY_NAMES].sort(),
    backticked(between("Railway가 넣는 비밀 아닌 이름:", "이 목록은 코드 상수")).sort(),
  );
});

test("each service's variables equal its policy §7 row exactly", () => {
  assert.deepEqual([...SERVICE_VARIABLES.page].sort(), policyRow("`Ops Observer`(page)").sort());
  assert.deepEqual([...SERVICE_VARIABLES.digest].sort(), policyRow("`Ops Observer Digest`").sort());
});

test("a correctly configured service starts", () => {
  for (const service of ["page", "digest"]) {
    const names = [...SERVICE_VARIABLES[service], "PATH", "HOME", "NODE_ENV", "RAILWAY_SERVICE_NAME"];
    assert.deepEqual(judgeEnvironmentNames(service, names), { ok: true }, service);
  }
});

test("the service's own route secret is not refused by the shape rule", () => {
  assert.ok(isCredentialShaped("OPS_OBSERVER_SECRET"));
  assert.deepEqual(judgeEnvironmentNames("page", ["OPS_OBSERVER_SECRET"]), { ok: true });
  assert.deepEqual(judgeEnvironmentNames("digest", ["OPS_OBSERVER_DIGEST_SECRET"]), { ok: true });
});

test("the other service's variables are refused by both checks", () => {
  for (const service of ["page", "digest"]) {
    for (const name of counterpartVariables(service)) {
      const verdict = judgeEnvironmentNames(service, [name]);
      assert.equal(verdict.ok, false, `${service} must refuse ${name}`);
      assert.deepEqual(verdict.notAllowed, [name]);
      assert.deepEqual(verdict.credentialShaped, [name]);
    }
  }
});

test("names the reviewer listed are refused, including ones no keyword rule would catch", () => {
  const names = [
    "DATABASE_URL",
    "DIRECT_URL",
    "DIRECT_DATABASE_URL",
    "STRIPE_SECRET_KEY",
    "TURNSTILE_SECRET_KEY",
    "R2_SECRET_ACCESS_KEY",
    "R2_ACCESS_KEY_ID",
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    "CLOUDFLARE_API_TOKEN",
    "FEEDBACK_AUTOFIX_GITHUB_READ_TOKEN",
    "RAILWAY_API_TOKEN",
    "RAILWAY_PROJECT_TOKEN",
    "RAILWAY_TOKEN",
    "NEXTAUTH_SECRET",
    "ADMIN_AUDIT_INTEGRITY_KEY",
    "MAINTENANCE_SECRET",
    "PGPASSWORD",
    "R2_BUCKET",
  ];
  for (const name of names) {
    const verdict = judgeEnvironmentNames("page", [name]);
    assert.equal(verdict.ok, false, name);
    assert.ok(verdict.notAllowed.includes(name), `${name} must not be allowlisted`);
  }
});

test("every variable the app reads is refused, so pasting the app's environment cannot start a service", () => {
  const names = appVariableNames();
  assert.ok(names.length > 50, "expected the app's variable list");
  const own = new Set([...SERVICE_VARIABLES.page, ...SERVICE_VARIABLES.digest]);
  const allowedRuntime = new Set(["NODE_ENV", "PORT", "HOSTNAME", ...RAILWAY_NAMES]);
  for (const name of names.filter((n) => !own.has(n) && !allowedRuntime.has(n))) {
    assert.equal(judgeEnvironmentNames("page", [name]).ok, false, name);
    assert.equal(judgeEnvironmentNames("digest", [name]).ok, false, name);
  }
});

test("no allowlisted runtime or Railway name is credential-shaped", () => {
  for (const name of [...RUNTIME_NAMES, ...RAILWAY_NAMES]) {
    assert.equal(isCredentialShaped(name), false, name);
  }
});

test("a refusal carries names only, sorted", () => {
  const verdict = judgeEnvironmentNames("page", ["ZED", "PATH", "ALPHA"]);
  assert.deepEqual(verdict, { ok: false, notAllowed: ["ALPHA", "ZED"], credentialShaped: [] });
});

test("the child receives only its listed variables", () => {
  const env = {
    OPS_OBSERVER_SECRET: "s",
    OPS_OBSERVER_APP_URL: "https://tomverse.app",
    OPS_OBSERVER_ENABLED: "true",
    RAILWAY_DOCKERFILE_PATH: "docker/ops-observer.Dockerfile",
    PATH: "/usr/bin",
  };
  assert.deepEqual(childEnvironment("page", env), {
    OPS_OBSERVER_SECRET: "s",
    OPS_OBSERVER_APP_URL: "https://tomverse.app",
  });
  for (const service of ["page", "digest"]) {
    for (const name of CHILD_VARIABLES[service]) assert.ok(SERVICE_VARIABLES[service].includes(name));
    assert.ok(!CHILD_VARIABLES[service].includes("OPS_OBSERVER_ENABLED"));
  }
});

test("unknown service and malformed names throw", () => {
  assert.throws(() => judgeEnvironmentNames("both", []), /service_unknown/);
  assert.throws(() => judgeEnvironmentNames("page", "PATH"), /env_names_invalid/);
});
