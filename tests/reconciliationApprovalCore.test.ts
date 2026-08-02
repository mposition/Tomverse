import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  findReconciliationApprovalProblems,
  readReconciliationEnvironment,
  type ReconciliationApproval,
} from "@/lib/reconciliationApprovalCore";

const EXPECTED = { fromModelId: "gpt-5-4-mini", toModelId: "gpt-5-6-luna" };

const approved = (
  overrides: Partial<ReconciliationApproval> = {}
): ReconciliationApproval => ({
  apply: true,
  approvedRetirement: true,
  ticket: "https://github.com/mposition/tomverse/issues/999",
  actor: "@mposition",
  fromModelId: EXPECTED.fromModelId,
  toModelId: EXPECTED.toModelId,
  environment: { ci: false, automatedHook: null },
  ...overrides,
});

const codes = (approval: ReconciliationApproval) =>
  findReconciliationApprovalProblems(approval, EXPECTED).map(
    (problem) => problem.code
  );

test("a dry run needs no approval at all", () => {
  // Reporting what would change has to stay one command away, or nobody looks
  // before deciding.
  assert.deepEqual(
    codes({
      apply: false,
      approvedRetirement: false,
      ticket: null,
      actor: null,
      fromModelId: null,
      toModelId: null,
      environment: { ci: true, automatedHook: "build" },
    }),
    []
  );
});

test("a fully approved write is allowed", () => {
  assert.deepEqual(codes(approved()), []);
});

test("--apply alone cannot retire GPT-5.4 mini's stored selections", () => {
  // The regression this exists for: the previous gate was --apply on its own,
  // so a copied command line moved every account that had chosen 5.4 mini.
  const bare: ReconciliationApproval = {
    apply: true,
    approvedRetirement: false,
    ticket: null,
    actor: null,
    fromModelId: null,
    toModelId: null,
    environment: { ci: false, automatedHook: null },
  };
  assert.deepEqual(codes(bare), [
    "missing_approval_flag",
    "missing_ticket",
    "missing_actor",
    "missing_target",
  ]);
});

test("each missing field is reported on its own", () => {
  assert.deepEqual(codes(approved({ approvedRetirement: false })), [
    "missing_approval_flag",
  ]);
  assert.deepEqual(codes(approved({ ticket: null })), ["missing_ticket"]);
  assert.deepEqual(codes(approved({ actor: null })), ["missing_actor"]);
  assert.deepEqual(codes(approved({ toModelId: null })), ["missing_target"]);
});

test("a run aimed at the wrong models is refused, not silently retargeted", () => {
  assert.deepEqual(
    codes(approved({ fromModelId: "gpt-5-6-luna", toModelId: "gpt-5-4-mini" })),
    ["target_mismatch"]
  );
});

test("a build, deploy, start or migration step may never write", () => {
  for (const hook of [
    "build",
    "prebuild",
    "start",
    "prestart",
    "deploy",
    "postdeploy",
    "db:migrate",
    "postinstall",
  ]) {
    assert.deepEqual(
      codes(approved({ environment: { ci: false, automatedHook: hook } })),
      ["automated_context"],
      hook
    );
  }
});

test("CI may never write, however complete the approval looks", () => {
  assert.deepEqual(
    codes(approved({ environment: { ci: true, automatedHook: null } })),
    ["automated_context"]
  );
});

test("the environment reader recognises lifecycle hooks and CI", () => {
  assert.deepEqual(readReconciliationEnvironment({}), {
    ci: false,
    automatedHook: null,
  });
  assert.deepEqual(readReconciliationEnvironment({ CI: "true" }), {
    ci: true,
    automatedHook: null,
  });
  assert.deepEqual(readReconciliationEnvironment({ GITHUB_ACTIONS: "true" }), {
    ci: true,
    automatedHook: null,
  });
  assert.equal(
    readReconciliationEnvironment({ npm_lifecycle_event: "build" }).automatedHook,
    "build"
  );
  // A named maintenance script is the one lifecycle event that is allowed --
  // it is what an operator types.
  assert.equal(
    readReconciliationEnvironment({
      npm_lifecycle_event: "maintenance:default-model-reconciliation",
    }).automatedHook,
    null
  );
});

test("nothing in the repository runs the reconciliation by itself", () => {
  // The script's own guard stops a write. This stops the invocation from
  // existing in the first place, which is the part a reviewer can see.
  const roots = [
    ...readdirSync(join(process.cwd(), "scripts")).map((name) =>
      join("scripts", name)
    ),
    ...(() => {
      const workflows = join(process.cwd(), ".github/workflows");
      try {
        return readdirSync(workflows).map((name) =>
          join(".github/workflows", name)
        );
      } catch {
        return [];
      }
    })(),
    "package.json",
    "Dockerfile",
    "railway.json",
    "railway.toml",
    "Procfile",
  ];

  const offenders: string[] = [];
  for (const relative of roots) {
    let contents: string;
    try {
      contents = readFileSync(join(process.cwd(), relative), "utf8");
    } catch {
      continue;
    }
    if (relative === "scripts/run-default-model-reconciliation.mjs") continue;
    if (!/run-default-model-reconciliation/.test(contents)) continue;

    // package.json is allowed to *define* the operator command; what it must
    // not do is chain it into build, start, deploy or migrate.
    if (relative === "package.json") {
      const scripts = JSON.parse(contents).scripts ?? {};
      for (const [name, command] of Object.entries(scripts)) {
        if (
          name !== "maintenance:default-model-reconciliation" &&
          /run-default-model-reconciliation/.test(String(command))
        ) {
          offenders.push(`package.json: ${name}`);
        }
      }
      continue;
    }
    offenders.push(relative);
  }

  assert.deepEqual(
    offenders,
    [],
    "reconciliation must only ever be started by an operator typing the command"
  );
});
