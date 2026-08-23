import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  findReconciliationApprovalProblems,
  findReconciliationTargetProblems,
  readReconciliationEnvironment,
  type ReconciliationApproval,
  type ReconciliationModelState,
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
  findReconciliationApprovalProblems(approval).map((problem) => problem.code);

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

test("any pair of models is accepted, because this is every retirement's tool", () => {
  // ML-10: --from and --to used to be checked against two constants naming one
  // migration. The next retirement would have meant copying the script, and a
  // copy carries no guarantee the approval gate comes with it.
  assert.deepEqual(
    codes(approved({ fromModelId: "some-old-model", toModelId: "some-new-model" })),
    []
  );
});

test("moving a model onto itself is refused", () => {
  // Not a harmless no-op: each "rewrite" files a ModelMigrationRecord, and the
  // notice built from those records would tell people their setting moved to
  // the model it was already on.
  assert.deepEqual(
    codes(approved({ fromModelId: "gpt-5-6-luna", toModelId: "gpt-5-6-luna" })),
    ["same_target"]
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
    if (relative === join("scripts", "run-default-model-reconciliation.mjs")) continue;
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

// ML-10: the timing rule as a check rather than as prose.
//
// "Run with the retirement deploy" was enforced by two constants naming one
// migration. Reading the registry makes it true for every migration.

const retired = (
  overrides: Partial<ReconciliationModelState> = {}
): ReconciliationModelState => ({
  modelId: "gpt-5-4-mini",
  found: true,
  enabled: false,
  publiclyListed: false,
  catalogDeleted: false,
  ...overrides,
});

const live = (
  overrides: Partial<ReconciliationModelState> = {}
): ReconciliationModelState => ({
  modelId: "gpt-5-6-luna",
  found: true,
  enabled: true,
  publiclyListed: true,
  catalogDeleted: false,
  ...overrides,
});

const targetCodes = (
  from: ReconciliationModelState,
  to: ReconciliationModelState,
  apply = true
) =>
  findReconciliationTargetProblems({ apply, from, to }).problems.map(
    (problem) => problem.code
  );

test("a retired source and a live replacement pass", () => {
  assert.deepEqual(targetCodes(retired(), live()), []);
});

test("an enabled model may not be moved off", () => {
  // The acceptance criterion. Until it is retired, an account that named it
  // named a model that still works.
  assert.deepEqual(targetCodes(retired({ enabled: true }), live()), [
    "from_not_retired",
  ]);
});

test("a still-listed model may not be moved off either", () => {
  // Disabled but still in the picker is a half-retirement, and the rows are
  // not yet stale pointers.
  assert.deepEqual(targetCodes(retired({ publiclyListed: true }), live()), [
    "from_not_retired",
  ]);
});

test("the refusal names which half is still true", () => {
  const { problems } = findReconciliationTargetProblems({
    apply: true,
    from: retired({ enabled: true, publiclyListed: true }),
    to: live(),
  });
  assert.match(problems[0].message, /enabled and publicly listed/);
});

test("an unknown source fails closed", () => {
  // A missing row proves nothing about whether the model was retired, and
  // proof is the entire point of this check.
  assert.deepEqual(targetCodes(retired({ found: false }), live()), [
    "from_unknown",
  ]);
});

test("the replacement has to be one that can answer", () => {
  assert.deepEqual(targetCodes(retired(), live({ found: false })), ["to_unknown"]);
  assert.deepEqual(targetCodes(retired(), live({ enabled: false })), [
    "to_not_usable",
  ]);
  assert.deepEqual(targetCodes(retired(), live({ catalogDeleted: true })), [
    "to_not_usable",
  ]);
});

test("an unlisted replacement warns rather than refusing", () => {
  // The model works; what the accounts moved onto it lose is finding it in
  // their own picker. That can be deliberate, so it is not this check's call.
  const result = findReconciliationTargetProblems({
    apply: true,
    from: retired(),
    to: live({ publiclyListed: false }),
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /model picker/);
});

test("both ends are reported together, not one per run", () => {
  assert.deepEqual(
    targetCodes(retired({ enabled: true }), live({ enabled: false })),
    ["from_not_retired", "to_not_usable"]
  );
});

test("a dry run reads the registry and refuses nothing", () => {
  // Reporting what would change stays one command away, exactly as it does for
  // the approval fields.
  assert.deepEqual(
    targetCodes(retired({ found: false, enabled: true }), live({ found: false }), false),
    []
  );
});
